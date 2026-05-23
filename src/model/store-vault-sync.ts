import {
  normalizePath,
  TFile,
  type App,
  type CachedMetadata,
  type EventRef,
  type MetadataCache,
  type Vault,
} from "obsidian";
import { cloneDeep, isEqual } from "lodash";
import { get, type Unsubscriber } from "svelte/store";

import { EBOOK_STRING_KEYS, type EbookMetadata, type Project } from "./types";
import {
  projects as projectsStore,
  pluginSettings,
  selectedProjectPath,
  updateScenesProject,
  waitingForSync,
} from "./stores";
import {
  decodeFlatScenes,
  formatSceneNumber,
  numberScenes,
  setProjectFrontmatter,
} from "src/model/project-utils";
import { fileNameFromPath } from "src/lib/path";
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
  const format = metadata?.frontmatter?.["longform"];
  if (format === "scenes" || format === "single") {
    return { file, metadata };
  }
  return null;
}

/**
 * Observes any file with a `longform` metadata entry and keeps its
 * metadata and associated scenes (if any) updated in the `projects`
 * store.
 *
 * Subscribes to the `projects` store and records changes in it to disk.
 *
 * Thus, keeps both store and vault in sync.
 */
export class StoreVaultSync {
  private app: App;
  private vault: Vault;
  private metadataCache: MetadataCache;
  private registerEvent: (ref: EventRef) => void;
  private settlingTime = 30000; // fallback settling time

  private lastKnownProjectsByPath: Record<string, Project> = {};
  private unsubscribers: Unsubscriber[] = [];

  private pathsToIgnoreNextChange: Set<string> = new Set();

  constructor(app: App, registerEvent: (ref: EventRef) => void) {
    this.app = app;
    this.vault = app.vault;
    this.metadataCache = app.metadataCache;
    this.registerEvent = registerEvent;
  }

  destroy(): void {
    this.unsubscribers.forEach((u) => u());
  }

  private isSyncEnabled(): boolean {
    try {
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
      const sync = this.app.internalPlugins.plugins.sync?.instance;

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
        }, 1000);

        // Add a timeout just in case sync never completes
        const timeout = setTimeout(() => {
          clearInterval(interval);
          console.log("[Longform] Sync wait timed out");
          waitingForSync.set(false);
          resolve();
        }, this.settlingTime);
      });
    } catch {
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
    await this.waitForSync();
    await this.discoverProjects();
    // Register vault listeners only after the initial discover/load
    // completes, so handlers cannot fire during initialization.
    this.registerEvent(this.app.metadataCache.on("changed", this.fileMetadataChanged.bind(this)));
    this.registerEvent(this.app.vault.on("create", (f) => this.fileCreated(f as TFile)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.fileDeleted(f as TFile)));
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => this.fileRenamed(f as TFile, oldPath)),
    );
  }

  async discoverProjects() {
    const start = new Date().getTime();

    const files = this.vault.getMarkdownFiles();
    const resolvedFiles = files.map((f) => resolveIfLongformFile(this.metadataCache, f));
    const projectFiles = resolvedFiles.filter((f) => f !== null);

    const possibleProjects = await Promise.all(projectFiles.map((f) => this.projectFor(f)));
    const loadedProjects = possibleProjects.filter((d) => d !== null);

    // Write dirty projects back to their index files
    const dirtyProjects = loadedProjects.filter((d) => d.dirty);
    for (const d of dirtyProjects) {
      await this.writeProjectFrontmatter(d.project);
    }

    const projectsToWrite = loadedProjects.map((d) => d.project);

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

    this.unsubscribers.push(projectsStore.subscribe(this.projectsStoreChanged.bind(this)));
  }

  async fileMetadataChanged(file: TFile, _data: string, cache: CachedMetadata) {
    if (this.pathsToIgnoreNextChange.delete(file.path)) {
      return;
    }

    const result = await this.projectFor({ file, metadata: cache });
    if (!result) {
      const deleted = this.lastKnownProjectsByPath[file.path];
      if (deleted) {
        projectsStore.update((ps) => ps.filter((p) => p.vaultPath !== file.path));
      }
      return;
    }

    const { project } = result;

    const old = this.lastKnownProjectsByPath[project.vaultPath];
    if (!old || !isEqual(project, old)) {
      this.lastKnownProjectsByPath[project.vaultPath] = project;
      projectsStore.update((ps) => {
        const idx = ps.findIndex((p) => p.vaultPath === project.vaultPath);
        if (idx < 0) {
          ps.push(project);
        } else {
          ps[idx] = project;
        }
        return ps;
      });
    }
  }

  async fileCreated(file: TFile) {
    const owner = this.findOwningSceneFolder(file, get(projectsStore));
    if (owner) {
      this.addUnknownSceneFile(owner.vaultPath, file.basename);
    }
  }

  async fileDeleted(file: TFile) {
    const ps = get(projectsStore);
    if (this.removeProjectByPath(file.path)) return;

    const found = findScene(file.path, ps);
    if (found) {
      this.removeSceneFromProject(found.project.vaultPath, found.index);
      return;
    }

    const ownerProject = ps.find(
      (p) => p.format === "scenes" && p.unknownFiles.contains(file.basename),
    );
    if (ownerProject) {
      this.removeUnknownFile(ownerProject.vaultPath, file.basename);
    }
  }

  async fileRenamed(file: TFile, oldPath: string) {
    if (this.renameProjectInStore(oldPath, file.path)) return;

    const ps = get(projectsStore);
    const newTitle = fileNameFromPath(file.path);
    const foundOld = findScene(oldPath, ps);
    const oldParent = oldPath.split("/").slice(0, -1).join("/");

    if (foundOld && oldParent === file.parent.path) {
      // In-place rename within the same scene folder.
      this.renameSceneInProject(foundOld.project.vaultPath, foundOld.index, newTitle);
      return;
    }

    // File moved out of a known project's scene folder.
    const oldOwner = ps.find(
      (p) => p.format === "scenes" && sceneFolderPath(p, this.vault) === oldParent,
    );
    if (oldOwner) {
      updateScenesProject(oldOwner.vaultPath, (p) => {
        p.scenes = p.scenes.filter((s) => s.title !== file.basename);
        p.unknownFiles = p.unknownFiles.filter((f) => f !== file.basename);
      });
    }

    // File moved into a known project's scene folder.
    const newOwner = ps.find(
      (p) => p.format === "scenes" && sceneFolderPath(p, this.vault) === file.parent.path,
    );
    if (newOwner) {
      this.addUnknownSceneFile(newOwner.vaultPath, file.basename);
    }
  }

  // ---- Intent-named private operations used by the file event handlers. ----

  private findOwningSceneFolder(file: TFile, ps: Project[]): Project | undefined {
    const sceneFolder = file.parent.path;
    return ps.find((p) => {
      if (p.format !== "scenes") return false;
      const parentPath = this.vault.getAbstractFileByPath(p.vaultPath).parent.path;
      const targetPath = normalizePath(`${parentPath}/${p.sceneFolder}`);
      return targetPath === sceneFolder && !p.scenes.map((s) => s.title).contains(file.basename);
    });
  }

  private addUnknownSceneFile(projectVaultPath: string, basename: string) {
    updateScenesProject(projectVaultPath, (p) => {
      if (!p.unknownFiles.contains(basename)) p.unknownFiles.push(basename);
    });
  }

  /** Returns true if a project with `path` existed and was removed. */
  private removeProjectByPath(path: string): boolean {
    const ps = get(projectsStore);
    if (!ps.some((p) => p.vaultPath === path)) return false;
    const remaining = cloneDeep(ps).filter((p) => p.vaultPath !== path);
    projectsStore.set(remaining);
    if (get(selectedProjectPath) === path) {
      selectedProjectPath.set(remaining.length > 0 ? remaining[0].vaultPath : null);
    }
    return true;
  }

  private removeSceneFromProject(projectVaultPath: string, sceneIndex: number) {
    updateScenesProject(projectVaultPath, (p) => {
      p.scenes.splice(sceneIndex, 1);
    });
  }

  private removeUnknownFile(projectVaultPath: string, basename: string) {
    updateScenesProject(projectVaultPath, (p) => {
      p.unknownFiles = p.unknownFiles.filter((f) => f !== basename);
    });
  }

  /** Returns true if a project at `oldPath` existed and was renamed to `newPath`. */
  private renameProjectInStore(oldPath: string, newPath: string): boolean {
    const ps = get(projectsStore);
    const idx = ps.findIndex((p) => p.vaultPath === oldPath);
    if (idx < 0) return false;
    projectsStore.update((all) => {
      const p = all[idx];
      p.vaultPath = newPath;
      if (!p.titleInFrontmatter) {
        p.title = fileNameFromPath(newPath);
      }
      return all;
    });
    if (get(selectedProjectPath) === oldPath) {
      selectedProjectPath.set(newPath);
    }
    return true;
  }

  private renameSceneInProject(projectVaultPath: string, sceneIndex: number, newTitle: string) {
    updateScenesProject(projectVaultPath, (p) => {
      p.scenes[sceneIndex].title = newTitle;
    });
  }

  async projectsStoreChanged(newValue: Project[]) {
    for (const project of newValue) {
      const old = this.lastKnownProjectsByPath[project.vaultPath];
      if (!old || !isEqual(project, old)) {
        this.pathsToIgnoreNextChange.add(project.vaultPath);
        await this.writeProjectFrontmatter(project);
      }
    }

    this.lastKnownProjectsByPath = cloneDeep(
      newValue.reduce((acc: Record<string, Project>, p) => {
        acc[p.vaultPath] = p;
        return acc;
      }, {}),
    );
  }

  private async projectFor(
    fileWithMetadata: FileWithMetadata,
  ): Promise<{ project: Project; dirty: boolean } | null> {
    const fm = fileWithMetadata.metadata.frontmatter;
    if (!fm) {
      return null;
    }
    const format = fm["longform"];
    if (format !== "scenes" && format !== "single") {
      return null;
    }

    const vaultPath = fileWithMetadata.file.path;
    const rawTitle = fm["title"];
    const titleInFrontmatter = typeof rawTitle === "string" && rawTitle.trim().length > 0;
    const title = titleInFrontmatter ? String(rawTitle) : fileNameFromPath(vaultPath);
    const workflow = typeof fm["workflow"] === "string" ? (fm["workflow"] as string) : null;
    const ebook = readEbookMetadata(fm);

    if (format === "scenes") {
      const scenes = decodeFlatScenes(fm["scenes"]);
      const sceneFolder = typeof fm["sceneFolder"] === "string" ? fm["sceneFolder"] : "/";
      const sceneTemplate =
        typeof fm["sceneTemplate"] === "string" && fm["sceneTemplate"].length > 0
          ? fm["sceneTemplate"]
          : null;
      const ignoredFiles: string[] = Array.isArray(fm["ignoredFiles"])
        ? fm["ignoredFiles"].filter((v: unknown): v is string => typeof v === "string")
        : [];
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

      const knownScenes = scenes.filter(({ title }) => filenamesInSceneFolder.contains(title));
      const dirty = knownScenes.length !== scenes.length;

      const sceneTitles = new Set(scenes.map((s) => s.title));
      const newScenes = filenamesInSceneFolder.filter((s) => !sceneTitles.has(s));

      const ignoredRegexes = ignoredFiles.filter((n) => n).map((p) => ignoredPatternToRegex(p));
      const unknownFiles = newScenes.filter(
        (s) => ignoredRegexes.find((r) => r.test(s)) === undefined,
      );

      return {
        project: {
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
          ebook,
        },
        dirty,
      };
    }

    return {
      project: {
        format: "single",
        title,
        titleInFrontmatter,
        vaultPath,
        workflow,
        ebook,
      },
      dirty: false,
    };
  }

  private async writeProjectFrontmatter(project: Project) {
    const file = this.app.vault.getAbstractFileByPath(project.vaultPath);
    if (!file || !(file instanceof TFile)) {
      return;
    }

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      setProjectFrontmatter(fm, project);
    });

    // for multi-scene projects, optionally set a property on each scene that holds its order within the project
    if (get(pluginSettings).writeProperty) {
      if (project.format === "scenes") {
        const writes: Promise<void>[] = [];
        const sceneNumbers = numberScenes(project.scenes);
        sceneNumbers.forEach((numberedScene, index) => {
          const sceneFilePath = scenePath(numberedScene.title, project, this.app.vault);

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
  get(projectsStore).forEach((project) => {
    if (project.format !== "scenes") return;
    numberScenes(project.scenes).map((numberedScene, index) => {
      const sceneFilePath = scenePath(numberedScene.title, project, app.vault);

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

function readEbookMetadata(fm: Record<string, any>): EbookMetadata {
  const ebook: EbookMetadata = {};
  for (const key of EBOOK_STRING_KEYS) {
    const value = fm[key];
    if (typeof value === "string" && value.trim().length > 0) {
      ebook[key] = value;
    }
  }
  if (Array.isArray(fm["subjects"])) {
    const subjects = fm["subjects"].filter(
      (v: unknown): v is string => typeof v === "string" && v.length > 0,
    );
    if (subjects.length > 0) ebook.subjects = subjects;
  }
  if (typeof fm["seriesIndex"] === "number" && Number.isFinite(fm["seriesIndex"])) {
    ebook.seriesIndex = fm["seriesIndex"];
  }
  return ebook;
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
