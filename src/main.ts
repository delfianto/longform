import "./styles.css";

import {
  Plugin,
  WorkspaceLeaf,
  FileView,
  addIcon,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import debounce from "lodash/debounce";
import once from "lodash/once";
import pick from "lodash/pick";
import type { Unsubscriber } from "svelte/store";
import { get } from "svelte/store";

import { VIEW_TYPE_LONGFORM_EXPLORER, ExplorerPane } from "./view/explorer/ExplorerPane";
import {
  PASSTHROUGH_SAVE_SETTINGS_PATHS,
  type Project,
  type LongformPluginSettings,
  type SerializedWorkflow,
} from "./model/types";
import { DEFAULT_SETTINGS, TRACKED_SETTINGS_PATHS } from "./model/types";
import { activeFile, selectedTab } from "./view/stores";
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
} from "./model/stores";
import { addCommands } from "./commands";
import { projectForPath } from "./model/scene-navigation";
import { WordCountTracker } from "./model/word-count-tracker";
import NewProjectModal from "./view/modals/NewProjectModal";
import { LongformAPI } from "./api";

const LONGFORM_LEAF_CLASS = "longform-leaf";

// TODO: Try and abstract away more logic from actual plugin hooks here

export default class LongformPlugin extends Plugin {
  // Local mirror of the pluginSettings store
  // since this class does a lot of ad-hoc settings fetching.
  // More efficient than a lot of get() calls.
  cachedSettings: LongformPluginSettings | null = null;
  private unsubscribers: Unsubscriber[] = [];
  private userScriptObserver: UserScriptObserver;
  wordCountTracker: WordCountTracker;
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
    this.unsubscribers.push(
      pluginSettings.subscribe(async (value) => {
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
      }),
    );

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
        } else {
          // Empty-state view detection — undocumented Obsidian API; may break.
          const emptyView = leaf.view as { emptyTitleEl?: HTMLElement; emptyStateEl?: HTMLElement };
          if (emptyView.emptyTitleEl && emptyView.emptyStateEl) {
            activeFile.set(null);
          }
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
    this.unsubscribers.push(
      projects.subscribe((allProjects) => {
        this.styleLongformLeaves(allProjects);
      }),
    );

    this.api = new LongformAPI();
  }

  onunload(): void {
    this.userScriptObserver.destroy();
    this.storeVaultSync.destroy();
    this.unsubscribers.forEach((u) => u());
    this.wordCountTracker.destroy();
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
    selectedProjectPath.set(_pluginSettings.selectedProjectPath);

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

    this.wordCountTracker = new WordCountTracker(this.app.vault);
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
      await this.app.vault.adapter.write(this.workflowsPath, JSON.stringify(serialized, null, 2));
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

    this.unsubscribers.push(
      selectedProject.subscribe(async (d) => {
        if (!get(initialized) || !d) {
          return;
        }

        // On initial load, default to Scenes tab for multi-scene projects.
        defaultToScenes(d);

        pluginSettings.update((s) => ({
          ...s,
          selectedProjectPath: d.vaultPath,
        }));
        this.cachedSettings = get(pluginSettings);
        await this.saveSettings();
      }),
    );

    // Workflows
    const saveWorkflows = debounce(() => {
      this.saveWorkflowsToVault();
    }, 3000);
    this.unsubscribers.push(
      workflows.subscribe(() => {
        if (!get(initialized)) {
          return;
        }

        saveWorkflows();
      }),
    );

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
      this.app.vault.on("modify", this.wordCountTracker.fileModified.bind(this.wordCountTracker)),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.wordCountTracker.debouncedCountProjectContaining.bind(this.wordCountTracker)(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.wordCountTracker.debouncedCountProjectContaining.bind(this.wordCountTracker)(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, _oldPath) => {
        this.wordCountTracker.debouncedCountProjectContaining.bind(this.wordCountTracker)(file);
      }),
    );
  }

  private styleLongformLeaves(allProjects: Project[] = get(projects)) {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (leaf.view instanceof FileView) {
        const draft = projectForPath(leaf.view.file.path, allProjects);
        if (draft) {
          leaf.view.containerEl.classList.add(LONGFORM_LEAF_CLASS);
        } else {
          leaf.view.containerEl.classList.remove(LONGFORM_LEAF_CLASS);
        }
      }

      const leafId = leaf.id;
      if (leafId) {
        leaf.view.containerEl.dataset.leafId = leafId;
      }
    });
  }
}
