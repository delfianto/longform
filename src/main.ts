import "../styles.css";

import {
  Plugin,
  WorkspaceLeaf,
  FileView,
  addIcon,
  Notice,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import debounce from "lodash/debounce";
import once from "lodash/once";
import pick from "lodash/pick";
import { derived, type Unsubscriber } from "svelte/store";
import { get } from "svelte/store";

import { VIEW_TYPE_LONGFORM_EXPLORER, ExplorerPane } from "./view/explorer/ExplorerPane";
import {
  PASSTHROUGH_SAVE_SETTINGS_PATHS,
  type Project,
  type LongformPluginSettings,
  type SerializedWorkflow,
  type WordCountSession,
} from "./model/types";
import { DEFAULT_SETTINGS, TRACKED_SETTINGS_PATHS } from "./model/types";
import { activeFile, goalProgress, selectedTab } from "./view/stores";
import { ICON_NAME, ICON_SVG } from "./view/icon";
import { LongformSettingsTab } from "./view/settings/LongformSettings";
import { deserializeWorkflow, serializeWorkflow } from "./compile/serialization";
import type { Workflow } from "./compile";
import { DEFAULT_WORKFLOWS } from "./compile";
import { UserScriptObserver } from "./model/user-script-observer";
import { StoreVaultSync } from "./model/store-vault-sync";
import {
  selectedProject,
  selectedProjectPath,
  workflows,
  initialized,
  pluginSettings,
  projects,
  sessions,
} from "./model/stores";
import { addCommands } from "./commands";
import { determineMigrationStatus } from "./model/migration";
import { draftForPath } from "./model/scene-navigation";
import { WritingSessionTracker } from "./model/writing-session-tracker";
import NewProjectModal from "./view/project-lifecycle/new-project-modal";
import { LongformAPI } from "./api/LongformAPI";

const LONGFORM_LEAF_CLASS = "longform-leaf";

// TODO: Try and abstract away more logic from actual plugin hooks here

export default class LongformPlugin extends Plugin {
  // Local mirror of the pluginSettings store
  // since this class does a lot of ad-hoc settings fetching.
  // More efficient than a lot of get() calls.
  cachedSettings: LongformPluginSettings | null = null;
  private unsubscribeSettings: Unsubscriber;
  private unsubscribeWorkflows: Unsubscriber;
  private unsubscribeProjects: Unsubscriber;
  private unsubscribeSelectedProject: Unsubscriber;
  private unsubscribeSessions: Unsubscriber;
  private unsubscribeGoalNotification: Unsubscriber;
  private userScriptObserver: UserScriptObserver;
  writingSessionTracker: WritingSessionTracker;
  public api: LongformAPI;

  private storeVaultSync: StoreVaultSync;

  async onload(): Promise<void> {
    console.log(`[Longform] Starting Longform ${this.manifest.version}…`);
    addIcon(ICON_NAME, ICON_SVG);

    this.registerView(VIEW_TYPE_LONGFORM_EXPLORER, (leaf: WorkspaceLeaf) => new ExplorerPane(leaf));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file: TAbstractFile) => {
        if (!(file instanceof TFolder)) {
          return;
        }
        menu.addItem((item) => {
          item
            .setTitle("Create Longform Project")
            .setIcon(ICON_NAME)
            .onClick(() => {
              new NewProjectModal(this.app, file).open();
            });
        });
      }),
    );

    // Settings
    this.unsubscribeSettings = pluginSettings.subscribe(async (value) => {
      let shouldSave = false;

      const changeInKeys = (
        obj1: Record<string, any>,
        obj2: Record<string, any>,
        keys: string[],
      ): boolean => {
        return !!keys.find((k) => obj1[k] !== obj2[k]);
      };

      if (
        this.cachedSettings &&
        changeInKeys(this.cachedSettings, value, PASSTHROUGH_SAVE_SETTINGS_PATHS)
      ) {
        shouldSave = true;
      }

      this.cachedSettings = value;

      if (shouldSave) {
        await this.saveSettings();
      }
    });

    await this.loadSettings();
    this.addSettingTab(new LongformSettingsTab(this.app, this));

    this.storeVaultSync = new StoreVaultSync(this.app);

    this.app.workspace.onLayoutReady(this.postLayoutInit.bind(this));

    // Track active file
    activeFile.set(this.app.workspace.getActiveFile());
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf.view instanceof FileView) {
          activeFile.set(leaf.view.file);
        }
        // NOTE: This may break, as it's undocumented.
        // Need some way to determine the empty state.
        else if ((leaf.view as any).emptyTitleEl && (leaf.view as any).emptyStateEl) {
          activeFile.set(null);
        }
      }),
    );

    addCommands(this);

    // Dynamically style longform scenes
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.styleLongformLeaves();
      }),
    );
    this.unsubscribeProjects = projects.subscribe((allProjects) => {
      this.styleLongformLeaves(allProjects);
    });

    this.api = new LongformAPI();
  }

  onunload(): void {
    this.userScriptObserver.destroy();
    this.storeVaultSync.destroy();
    this.unsubscribeSettings();
    this.unsubscribeWorkflows();
    this.unsubscribeSelectedProject();
    this.unsubscribeProjects();
    this.unsubscribeSessions();
    this.unsubscribeGoalNotification();
    this.writingSessionTracker.destroy();
    this.app.workspace
      .getLeavesOfType(VIEW_TYPE_LONGFORM_EXPLORER)
      .forEach((leaf) => leaf.detach());
  }

  async loadSettings(): Promise<void> {
    const settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // deserialize iso8601 strings as dates

    const _pluginSettings: LongformPluginSettings = pick(
      settings,
      TRACKED_SETTINGS_PATHS,
    ) as LongformPluginSettings;
    pluginSettings.set(_pluginSettings);
    selectedProjectPath.set(_pluginSettings.selectedDraftVaultPath);
    determineMigrationStatus(_pluginSettings);

    // We load user scripts imperatively first to cover cases where we need to deserialize
    // workflows that may contain them.
    const userScriptFolder = settings["userScriptFolder"];
    this.userScriptObserver = new UserScriptObserver(this.app.vault, userScriptFolder);
    await this.userScriptObserver.loadUserSteps();

    // Load workflows: vault file takes priority, fall back to data.json for one-time migration.
    let _workflows = await this.loadWorkflowsFromVault();

    if (!_workflows && settings["workflows"]) {
      console.log("[Longform] Migrating workflows from data.json to vault storage.");
      _workflows = settings["workflows"];
    }

    if (!_workflows) {
      console.log("[Longform] No workflows found; adding default workflow.");
      _workflows = DEFAULT_WORKFLOWS;
    }

    const deserializedWorkflows: Record<string, Workflow> = {};
    Object.entries(_workflows).forEach(([key, value]) => {
      deserializedWorkflows[key as string] = deserializeWorkflow(value as SerializedWorkflow);
    });
    workflows.set(deserializedWorkflows);

    // Persist to vault (creates the file if migrating or first run).
    await this.saveWorkflowsToVault();

    const onStatusClick = () => {
      const file = get(activeFile);
      if (!file) {
        return false;
      }
      const draft = draftForPath(file.path, get(projects));
      if (draft) {
        selectedProjectPath.set(draft.vaultPath);
        this.initLeaf();
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_LONGFORM_EXPLORER).first();
        if (leaf) {
          this.app.workspace.revealLeaf(leaf);
        }

        selectedTab.set("Project");
      }
    };

    this.writingSessionTracker = new WritingSessionTracker(
      settings["sessions"],
      this.addStatusBarItem(),
      onStatusClick,
      this.app.vault,
    );
  }

  private get workflowsDir(): string {
    return normalizePath(`${this.app.vault.configDir}/longform`);
  }

  private get workflowsPath(): string {
    return normalizePath(`${this.workflowsDir}/workflows.json`);
  }

  private async loadWorkflowsFromVault(): Promise<Record<string, SerializedWorkflow> | null> {
    try {
      if (await this.app.vault.adapter.exists(this.workflowsPath)) {
        const raw = await this.app.vault.adapter.read(this.workflowsPath);
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error("[Longform] Failed to read workflows from vault:", e);
    }
    return null;
  }

  async saveWorkflowsToVault(): Promise<void> {
    const _workflows = get(workflows);
    const serialized: Record<string, SerializedWorkflow> = {};
    Object.entries(_workflows).forEach(([key, value]) => {
      serialized[key] = serializeWorkflow(value);
    });

    try {
      if (!(await this.app.vault.adapter.exists(this.workflowsDir))) {
        await this.app.vault.adapter.mkdir(this.workflowsDir);
      }
      await this.app.vault.adapter.write(
        this.workflowsPath,
        JSON.stringify(serialized, null, 2),
      );
    } catch (e) {
      console.error("[Longform] Failed to save workflows to vault:", e);
    }
  }

  async saveSettings(): Promise<void> {
    if (!this.cachedSettings) {
      return;
    }

    await this.saveData(this.cachedSettings);
  }

  private async postLayoutInit(): Promise<void> {
    this.userScriptObserver.beginObserving();

    // Initialize StoreVaultSync with sync awareness
    await this.storeVaultSync.initialize();

    // Continue with the rest of initialization only after sync is complete
    this.watchProjects();

    const defaultToScenes = once(function (d: Project) {
      if (d && d.format === "scenes") {
        selectedTab.set("Scenes");
      }
    });

    this.unsubscribeSelectedProject = selectedProject.subscribe(async (d) => {
      if (!get(initialized) || !d) {
        return;
      }

      // On initial load, default to Scenes tab for multi-scene projects.
      defaultToScenes(d);

      pluginSettings.update((s) => ({
        ...s,
        selectedDraftVaultPath: d.vaultPath,
      }));
      this.cachedSettings = get(pluginSettings);
      await this.saveSettings();
    });

    // Workflows
    const saveWorkflows = debounce(() => {
      this.saveWorkflowsToVault();
    }, 3000);
    this.unsubscribeWorkflows = workflows.subscribe(() => {
      if (!get(initialized)) {
        return;
      }

      saveWorkflows();
    });

    // Sessions
    const saveSessions = debounce(async (toSave: WordCountSession[]) => {
      if (this.cachedSettings.sessionStorage === "data") {
        pluginSettings.update((s) => {
          const toReturn = {
            ...s,
            sessions: toSave,
          };
          this.cachedSettings = toReturn;
          return toReturn;
        });
        await this.saveSettings();
      } else {
        // Save to either plugin or vault
        let file: string | null = null;
        if (this.cachedSettings.sessionStorage === "plugin-folder") {
          if (!this.manifest.dir) {
            console.error(`[Longform] No manifest.dir for saving sessions.`);
            return;
          }
          file = normalizePath(`${this.manifest.dir}/sessions.json`);
        } else {
          file = this.cachedSettings.sessionFile;
        }
        if (!file) {
          return;
        }
        const data = JSON.stringify(toSave);
        await this.app.vault.adapter.write(file, data);

        // If we have lingering session data in settings, clear it
        if (this.cachedSettings.sessions.length !== 0) {
          const emptySessions: WordCountSession[] = [];
          pluginSettings.update((s) => {
            const toReturn = {
              ...s,
              sessions: emptySessions,
            };
            this.cachedSettings = toReturn;
            return toReturn;
          });
          await this.saveSettings();
        }
      }
    }, 3000);
    this.unsubscribeSessions = sessions.subscribe((s) => {
      if (!get(initialized)) {
        return;
      }

      saveSessions(s);
    });

    this.unsubscribeGoalNotification = derived(
      [goalProgress, pluginSettings, selectedProject, activeFile],
      (stores) => stores,
    ).subscribe(([$goalProgress, $pluginSettings, $selectedProject, $activeFile]) => {
      if ($goalProgress >= 1 && $pluginSettings.notifyOnGoal) {
        let target: string;
        if ($pluginSettings.applyGoalTo === "all") {
          target = "all";
        } else if ($pluginSettings.applyGoalTo === "project") {
          target = `project::${$selectedProject.vaultPath}`;
        } else if ($pluginSettings.applyGoalTo === "note") {
          if ($selectedProject && $selectedProject.format === "single") {
            target = `note::${$selectedProject.vaultPath}`;
          } else if ($selectedProject && $selectedProject.format === "scenes" && $activeFile) {
            target = `note::${$activeFile.path}`;
          }
        }
        if (target && !this.writingSessionTracker.goalsNotifiedFor.has(target)) {
          this.writingSessionTracker.goalsNotifiedFor.add(target);
          new Notice("Writing goal met!");
        }
      }
    });

    this.initLeaf();
    initialized.set(true);
  }

  initLeaf(): void {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_LONGFORM_EXPLORER).length) {
      return;
    }
    this.app.workspace.getLeftLeaf(false).setViewState({
      type: VIEW_TYPE_LONGFORM_EXPLORER,
    });
  }

  private watchProjects(): void {
    // USER SCRIPTS
    this.registerEvent(
      this.app.vault.on(
        "modify",
        this.userScriptObserver.fileEventCallback.bind(this.userScriptObserver),
      ),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.userScriptObserver.fileEventCallback.bind(this.userScriptObserver)(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.userScriptObserver.fileEventCallback.bind(this.userScriptObserver)(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, _oldPath) => {
        this.userScriptObserver.fileEventCallback.bind(this.userScriptObserver)(file);
      }),
    );

    // STORE-VAULT SYNC
    this.storeVaultSync.discoverDrafts();

    this.registerEvent(
      this.app.metadataCache.on(
        "changed",
        this.storeVaultSync.fileMetadataChanged.bind(this.storeVaultSync),
      ),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => this.storeVaultSync.fileCreated(file as TFile)),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => this.storeVaultSync.fileDeleted(file as TFile)),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) =>
        this.storeVaultSync.fileRenamed(file as TFile, oldPath),
      ),
    );

    // WORD COUNTS
    this.registerEvent(
      this.app.vault.on(
        "modify",
        this.writingSessionTracker.fileModified.bind(this.writingSessionTracker),
      ),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.writingSessionTracker.debouncedCountDraftContaining.bind(this.writingSessionTracker)(
          file,
        );
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.writingSessionTracker.debouncedCountDraftContaining.bind(this.writingSessionTracker)(
          file,
        );
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, _oldPath) => {
        this.writingSessionTracker.debouncedCountDraftContaining.bind(this.writingSessionTracker)(
          file,
        );
      }),
    );
  }

  private styleLongformLeaves(allProjects: Project[] = get(projects)) {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (leaf.view instanceof FileView) {
        const draft = draftForPath(leaf.view.file.path, allProjects);
        if (draft) {
          leaf.view.containerEl.classList.add(LONGFORM_LEAF_CLASS);
        } else {
          leaf.view.containerEl.classList.remove(LONGFORM_LEAF_CLASS);
        }
      }

      // @ts-ignore
      const leafId = leaf.id;
      if (leafId) {
        leaf.view.containerEl.dataset.leafId = leafId;
      }
    });
  }
}
