import {
  normalizePath,
  TFile,
  type App,
  type CachedMetadata,
  type MetadataCache,
  type Vault,
} from "obsidian";
import { cloneDeep, isEqual } from "lodash";
import { get, type Unsubscriber } from "svelte/store";

import type { Project } from "./types";
import {
  projects as projectsStore,
  pluginSettings,
  waitingForSync,
  selectedProjectPath,
} from "./stores";
import {
  arraysToIndentedScenes,
  formatSceneNumber,
  numberScenes,
  setDraftOnFrontmatterObject,
} from "src/model/draft-utils";
import { fileNameFromPath } from "./note-utils";
import { findScene, sceneFolderPath, scenePath } from "./scene-navigation";

type FileWithMetadata = {
  file: TFile;
  metadata: CachedMetadata;
};

export function resolveIfLongformFile(
  metadataCache: MetadataCache,
  file: TFile,
): FileWithMetadata | null {
  const metadata = metadataCache.getFileCache(file);
  if (metadata && metadata.frontmatter && metadata.frontmatter["longform"]) {
    return { file, metadata };
  }
  return null;
}

/**
 * Observes any file with a `longform` metadata entry and keeps its
 * metadata and associated scenes (if any) updated in the `drafts`
 * store.
 *
 * Subscribes to the `drafts` store and records changes in it to disk.
 *
 * Thus, keeps both store and vault in sync.
 */
export class StoreVaultSync {
  private app: App;
  private vault: Vault;
  private metadataCache: MetadataCache;
  private isInitializing = true;
  private settlingTime = 30000; // fallback settling time

  private lastKnownProjectsByPath: Record<string, Project> = {};
  private unsubscribeProjectsStore: Unsubscriber;

  private pathsToIgnoreNextChange: Set<string> = new Set();

  constructor(app: App) {
    this.app = app;
    this.vault = app.vault;
    this.metadataCache = app.metadataCache;
  }

  destroy(): void {
    this.unsubscribeProjectsStore();
  }

  private isSyncEnabled(): boolean {
    try {
      // @ts-ignore - accessing private API
      const syncPlugin = this.app.internalPlugins?.plugins?.sync;
      return syncPlugin?.enabled === true;
    } catch {
      return false;
    }
  }

  private async waitForSync(): Promise<void> {
    const settings = get(pluginSettings);

    // First check if "wait for sync" in setting or the Sync plugin itself is enabled
    if (!settings.waitForSync || !this.isSyncEnabled()) {
      return Promise.resolve();
    }

    try {
      // @ts-ignore - accessing private API
      const sync = this.app.internalPlugins.plugins.sync.instance;

      // Set waitingForSync to disable watchers and enable loading spinner
      waitingForSync.set(true);

      // Check if we can't access the sync status (possibly due to Sync plugin API changes), use fallback wait if not
      if (!sync?.syncing) {
        return this.fallbackWait();
      }

      return new Promise((resolve) => {
        if (!sync.syncing) {
          waitingForSync.set(false);
          resolve();
          return;
        }

        console.log("[Longform] Waiting for active sync to complete...");

        // Poll sync status every second
        const interval = setInterval(() => {
          if (!sync.syncing) {
            clearInterval(interval);
            clearTimeout(timeout); // Clear the timeout when sync completes
            console.log("[Longform] Sync complete.");
            waitingForSync.set(false);
            resolve();
          }
          console.log("[Longform] Sync status:", sync.syncStatus);
        }, 1000);

        // Add a timeout just in case sync never completes
        const timeout = setTimeout(() => {
          clearInterval(interval);
          console.log("[Longform] Sync wait timed out");
          waitingForSync.set(false);
          resolve();
        }, this.settlingTime);
      });
    } catch (error) {
      waitingForSync.set(false);
      return this.fallbackWait();
    }
  }

  private async fallbackWait(): Promise<void> {
    const settings = get(pluginSettings);
    if (!settings.fallbackWaitEnabled) {
      return Promise.resolve();
    }

    return new Promise((resolve) => setTimeout(resolve, settings.fallbackWaitTime * 1000));
  }

  async initialize() {
    try {
      await this.waitForSync();
      await this.discoverDrafts();

      this.isInitializing = false;
    } catch (error) {
      this.isInitializing = false;
    }
  }

  async discoverDrafts() {
    const start = new Date().getTime();

    const files = this.vault.getMarkdownFiles();
    const resolvedFiles = files.map((f) => resolveIfLongformFile(this.metadataCache, f));
    const projectFiles = resolvedFiles.filter((f) => f !== null);

    const possibleProjects = await Promise.all(projectFiles.map((f) => this.draftFor(f)));
    const loadedProjects = possibleProjects.filter((d) => d !== null);

    // Write dirty projects back to their index files
    const dirtyProjects = loadedProjects.filter((d) => d.dirty);
    for (const d of dirtyProjects) {
      await this.writeDraftFrontmatter(d.draft);
    }

    const projectsToWrite = loadedProjects.map((d) => d.draft);

    this.lastKnownProjectsByPath = cloneDeep(
      projectsToWrite.reduce((acc: Record<string, Project>, p) => {
        acc[p.vaultPath] = p;
        return acc;
      }, {}),
    );
    projectsStore.set(projectsToWrite);

    console.log(
      `[Longform] Loaded and watching projects. Found ${projectFiles.length} projects in ${
        (new Date().getTime() - start) / 1000.0
      }s.`,
    );

    this.unsubscribeProjectsStore = projectsStore.subscribe(this.draftsStoreChanged.bind(this));
  }

  async fileMetadataChanged(file: TFile, _data: string, cache: CachedMetadata) {
    if (this.isInitializing) return;
    if (this.pathsToIgnoreNextChange.delete(file.path)) {
      return;
    }

    const result = await this.draftFor({ file, metadata: cache });
    if (!result) {
      const deleted = this.lastKnownProjectsByPath[file.path];
      if (deleted) {
        projectsStore.update((ps) => ps.filter((p) => p.vaultPath !== file.path));
      }
      return;
    }

    const { draft } = result;

    const old = this.lastKnownProjectsByPath[draft.vaultPath];
    if (!old || !isEqual(draft, old)) {
      this.lastKnownProjectsByPath[draft.vaultPath] = draft;
      projectsStore.update((ps) => {
        const idx = ps.findIndex((p) => p.vaultPath === draft.vaultPath);
        if (idx < 0) {
          ps.push(draft);
        } else {
          ps[idx] = draft;
        }
        return ps;
      });
    }
  }

  async fileCreated(file: TFile) {
    if (this.isInitializing) return;
    const ps = get(projectsStore);

    const scenePath = file.parent.path;
    const memberProject = ps.find((p) => {
      if (p.format !== "scenes") return false;
      const parentPath = this.vault.getAbstractFileByPath(p.vaultPath).parent.path;
      const targetPath = normalizePath(`${parentPath}/${p.sceneFolder}`);
      return targetPath === scenePath && !p.scenes.map((s) => s.title).contains(file.basename);
    });
    if (memberProject) {
      projectsStore.update((all) =>
        all.map((p) => {
          if (
            p.vaultPath === memberProject.vaultPath &&
            p.format === "scenes" &&
            !p.unknownFiles.contains(file.basename)
          ) {
            p.unknownFiles.push(file.basename);
          }
          return p;
        }),
      );
    }
  }

  async fileDeleted(file: TFile) {
    if (this.isInitializing) return;
    const ps = get(projectsStore);
    const projectIndex = ps.findIndex((p) => p.vaultPath === file.path);
    if (projectIndex >= 0) {
      const remaining = cloneDeep(ps);
      remaining.splice(projectIndex, 1);
      projectsStore.set(remaining);
      if (get(selectedProjectPath) === file.path) {
        selectedProjectPath.set(remaining.length > 0 ? remaining[0].vaultPath : null);
      }
    } else {
      const found = findScene(file.path, ps);
      if (found) {
        projectsStore.update((all) =>
          all.map((p) => {
            if (p.vaultPath === found.draft.vaultPath && p.format === "scenes") {
              p.scenes.splice(found.index, 1);
            }
            return p;
          }),
        );
      } else {
        const ownerProject = ps.find(
          (p) => p.format === "scenes" && p.unknownFiles.contains(file.basename),
        );
        if (ownerProject) {
          projectsStore.update((all) =>
            all.map((p) => {
              if (p.vaultPath === ownerProject.vaultPath && p.format === "scenes") {
                p.unknownFiles = p.unknownFiles.filter((f) => f !== file.basename);
              }
              return p;
            }),
          );
        }
      }
    }
  }

  async fileRenamed(file: TFile, oldPath: string) {
    if (this.isInitializing) return;
    const ps = get(projectsStore);
    const projectIndex = ps.findIndex((p) => p.vaultPath === oldPath);
    if (projectIndex >= 0) {
      projectsStore.update((all) => {
        const p = all[projectIndex];
        p.vaultPath = file.path;
        if (!p.titleInFrontmatter) {
          p.title = fileNameFromPath(file.path);
        }
        all[projectIndex] = p;
        return all;
      });
      if (get(selectedProjectPath) === oldPath) {
        selectedProjectPath.set(file.path);
      }
    } else {
      const newTitle = fileNameFromPath(file.path);
      const foundOld = findScene(oldPath, ps);
      const oldParent = oldPath.split("/").slice(0, -1).join("/");

      if (foundOld && oldParent === file.parent.path) {
        // in-place rename
        projectsStore.update((all) =>
          all.map((p) => {
            if (p.vaultPath === foundOld.draft.vaultPath && p.format === "scenes") {
              p.scenes[foundOld.index].title = newTitle;
            }
            return p;
          }),
        );
      } else {
        // moved out of a project
        const oldProject = ps.find(
          (p) => p.format === "scenes" && sceneFolderPath(p, this.vault) === oldParent,
        );
        if (oldProject) {
          projectsStore.update((all) =>
            all.map((p) => {
              if (p.vaultPath === oldProject.vaultPath && p.format === "scenes") {
                p.scenes = p.scenes.filter((s) => s.title !== file.basename);
                p.unknownFiles = p.unknownFiles.filter((f) => f !== file.basename);
              }
              return p;
            }),
          );
        }

        // moved into a project
        const newProject = ps.find(
          (p) => p.format === "scenes" && sceneFolderPath(p, this.vault) === file.parent.path,
        );
        if (newProject) {
          projectsStore.update((all) =>
            all.map((p) => {
              if (p.vaultPath === newProject.vaultPath && p.format === "scenes") {
                p.unknownFiles.push(file.basename);
              }
              return p;
            }),
          );
        }
      }
    }
  }

  async draftsStoreChanged(newValue: Project[]) {
    for (const project of newValue) {
      const old = this.lastKnownProjectsByPath[project.vaultPath];
      if (!old || !isEqual(project, old)) {
        this.pathsToIgnoreNextChange.add(project.vaultPath);
        await this.writeDraftFrontmatter(project);
      }
    }

    this.lastKnownProjectsByPath = cloneDeep(
      newValue.reduce((acc: Record<string, Project>, p) => {
        acc[p.vaultPath] = p;
        return acc;
      }, {}),
    );
  }

  private async draftFor(
    fileWithMetadata: FileWithMetadata,
  ): Promise<{ draft: Project; dirty: boolean } | null> {
    if (!fileWithMetadata.metadata.frontmatter) {
      return null;
    }
    const longformEntry = fileWithMetadata.metadata.frontmatter["longform"];
    if (!longformEntry) {
      return null;
    }
    const format = longformEntry["format"];
    const vaultPath = fileWithMetadata.file.path;
    let title = longformEntry["title"];
    let titleInFrontmatter = true;
    if (!title) {
      titleInFrontmatter = false;
      title = fileNameFromPath(vaultPath);
    }
    const workflow = longformEntry["workflow"] ?? null;

    if (format === "scenes") {
      let rawScenes: any = longformEntry["scenes"] ?? [];

      if (rawScenes.length === 0) {
        // fallback for issue where the metadata cache seems to fail to recognize yaml arrays.
        // in this case, it reports the array as empty when it's not,
        // so we will parse out the yaml directly from the file contents, just in case.
        // discord discussion: https://discord.com/channels/686053708261228577/840286264964022302/994589562082951219

        // 2023-01-03: Confirmed this issue is still present; using new processFrontMatter function
        // seems to read correctly, though!

        let fm = null;
        try {
          await this.app.fileManager.processFrontMatter(fileWithMetadata.file, (_fm) => {
            fm = _fm;
          });
        } catch (error) {
          console.error("[Longform] error manually loading frontmatter:", error);
        }

        if (fm) {
          rawScenes = fm["longform"]["scenes"];
        }
      }

      // Convert to indented scenes
      const scenes = arraysToIndentedScenes(rawScenes);
      const sceneFolder = longformEntry["sceneFolder"] ?? "/";
      const sceneTemplate = longformEntry["sceneTemplate"] ?? null;
      const ignoredFiles: string[] = longformEntry["ignoredFiles"] ?? [];
      const normalizedSceneFolder = normalizePath(
        `${fileWithMetadata.file.parent.path}/${sceneFolder}`,
      );

      let filenamesInSceneFolder: string[] = [];
      if (await this.vault.adapter.exists(normalizedSceneFolder)) {
        filenamesInSceneFolder = (await this.vault.adapter.list(normalizedSceneFolder)).files
          .filter((f) => f !== fileWithMetadata.file.path && f.endsWith(".md"))
          .map((f) => this.vault.getAbstractFileByPath(f)?.name.slice(0, -3))
          .filter((maybeName) => maybeName !== null && maybeName !== undefined) as string[];
      }

      // Filter removed scenes
      const knownScenes = scenes.filter(({ title }) => filenamesInSceneFolder.contains(title));

      const dirty = knownScenes.length !== scenes.length;

      const sceneTitles = new Set(scenes.map((s) => s.title));
      const newScenes = filenamesInSceneFolder.filter((s) => !sceneTitles.has(s));

      // ignore all new scenes that are known-to-ignore per ignoredFiles
      const ignoredRegexes = ignoredFiles.filter((n) => n).map((p) => ignoredPatternToRegex(p));
      const unknownFiles = newScenes.filter(
        (s) => ignoredRegexes.find((r) => r.test(s)) === undefined,
      );

      return {
        draft: {
          format: "scenes",
          title,
          titleInFrontmatter,
          vaultPath,
          sceneFolder,
          scenes: knownScenes,
          ignoredFiles,
          unknownFiles,
          sceneTemplate,
          workflow,
        },
        dirty,
      };
    } else if (format === "single") {
      return {
        draft: {
          format: "single",
          title,
          titleInFrontmatter,
          vaultPath,
          workflow,
        },
        dirty: false,
      };
    } else {
      console.log(
        `[Longform] Error loading draft at ${fileWithMetadata.file.path}: invalid longform.format. Ignoring.`,
      );
      return null;
    }
  }

  private async writeDraftFrontmatter(draft: Project) {
    const file = this.app.vault.getAbstractFileByPath(draft.vaultPath);
    if (!file || !(file instanceof TFile)) {
      return;
    }

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      setDraftOnFrontmatterObject(fm, draft);
    });

    // for multi-scene projects, optionally set a property on each scene that holds its order within the project
    if (get(pluginSettings).writeProperty) {
      if (draft.format === "scenes") {
        const writes: Promise<void>[] = [];
        const sceneNumbers = numberScenes(draft.scenes);
        sceneNumbers.forEach((numberedScene, index) => {
          const sceneFilePath = scenePath(numberedScene.title, draft, this.app.vault);

          const sceneFile = this.app.vault.getAbstractFileByPath(sceneFilePath);
          // false if a folder, or not found
          if (!(sceneFile instanceof TFile)) {
            return;
          }
          writes.push(writeSceneNumbers(this.app, sceneFile, index, numberedScene.numbering));
        });

        await Promise.all(writes);
      }
    }
  }
}

export function syncSceneIndices(app: App): void | Promise<void[]> {
  const writes: Promise<void>[] = [];
  get(projectsStore).forEach((draft) => {
    if (draft.format !== "scenes") return;
    numberScenes(draft.scenes).map((numberedScene, index) => {
      const sceneFilePath = scenePath(numberedScene.title, draft, app.vault);

      const sceneFile = app.vault.getAbstractFileByPath(sceneFilePath);
      // false if a folder, or not found
      if (!(sceneFile instanceof TFile)) {
        return;
      }
      return writeSceneNumbers(app, sceneFile, index, numberedScene.numbering);
    });
  });
  if (writes.length === 0) return;
  return Promise.all(writes);
}

function writeSceneNumbers(app: App, file: TFile, index: number, numbering: number[]) {
  return app.fileManager.processFrontMatter(file, (fm) => {
    fm["longform-order"] = index;
    fm["longform-number"] = formatSceneNumber(numbering);
  });
}

const ESCAPED_CHARACTERS = new Set("/&$^+.()=!|[]{},".split(""));
function ignoredPatternToRegex(pattern: string): RegExp {
  let regex = "";

  for (let index = 0; index < pattern.length; index++) {
    const c = pattern[index];

    if (ESCAPED_CHARACTERS.has(c)) {
      regex += "\\" + c;
    } else if (c === "*") {
      regex += ".*";
    } else if (c === "?") {
      regex += ".";
    } else {
      regex += c;
    }
  }

  return new RegExp(`^${regex}$`);
}
