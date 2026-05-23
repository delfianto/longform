import { App, TFile, Vault } from "obsidian";
import { get, type Writable } from "svelte/store";

import type { Project, IndentedScene, MultipleSceneProject } from "./types";
import { scenePath } from "src/model/scene-navigation";
import { createNoteWithPotentialTemplate } from "./note-utils";
import { pluginSettings } from "./stores";

type SceneInsertionLocation = {
  at: "before" | "after" | "end";
  relativeTo: number | null;
};

export async function createScene(
  app: App,
  path: string,
  index: number,
  project: MultipleSceneProject,
  open: boolean,
): Promise<void> {
  const template = project.sceneTemplate ?? get(pluginSettings).sceneTemplate;
  const note = await createNoteWithPotentialTemplate(app, path, template);
  if (note === null) return;

  if (get(pluginSettings).writeProperty) {
    await app.fileManager.processFrontMatter(note, (fm) => {
      fm["longform-order"] = index;
    });
  }

  if (open) {
    app.workspace.openLinkText(path, "/", false);
  }
}

export async function insertScene(
  app: App,
  projectsStore: Writable<Project[]>,
  project: MultipleSceneProject,
  sceneName: string,
  vault: Vault,
  location: SceneInsertionLocation,
  open: boolean,
) {
  const newScenePath = scenePath(sceneName, project, vault);

  if (!newScenePath || !project || project.format !== "scenes") {
    return;
  }

  projectsStore.update((allProjects) => {
    return allProjects.map((p) => {
      if (p.vaultPath === project.vaultPath && p.format === "scenes") {
        if (location.at === "end") {
          p.scenes = [...p.scenes, { title: sceneName, indent: 0 }];
        } else {
          const relativeScene = p.scenes[location.relativeTo];
          const index = location.at === "before" ? location.relativeTo : location.relativeTo + 1;
          p.scenes.splice(index, 0, {
            title: sceneName,
            indent: relativeScene.indent,
          });
        }
      }
      return p;
    });
  });

  await createScene(
    app,
    newScenePath,
    project.scenes.findIndex((s) => s.title === sceneName),
    project,
    open,
  );
}

export function setProjectFrontmatter(obj: Record<string, any>, project: Project) {
  obj["longform"] = {};
  obj["longform"]["format"] = project.format;
  if (project.titleInFrontmatter) {
    obj["longform"]["title"] = project.title;
  }
  if (project.workflow) {
    obj["longform"]["workflow"] = project.workflow;
  }

  if (project.format === "scenes") {
    obj["longform"]["sceneFolder"] = project.sceneFolder;
    obj["longform"]["scenes"] = indentedScenesToArrays(project.scenes);
    if (project.sceneTemplate) {
      obj["longform"]["sceneTemplate"] = project.sceneTemplate;
    }
    obj["longform"]["ignoredFiles"] = project.ignoredFiles;
  }
}

// Legacy alias used by store-vault-sync
export const setDraftOnFrontmatterObject = setProjectFrontmatter;

export function indentedScenesToArrays(indented: IndentedScene[]) {
  const result: any = [];
  let currentIndent = 0;
  let currentNesting = result;
  const nestingAt: Record<number, any> = {};
  nestingAt[0] = currentNesting;

  indented.forEach(({ title, indent }) => {
    if (indent > currentIndent) {
      while (currentIndent < indent) {
        currentIndent = currentIndent + 1;
        const newNesting: any = [];
        currentNesting.push(newNesting);
        nestingAt[currentIndent] = newNesting;
        currentNesting = newNesting;
      }
    } else if (indent < currentIndent) {
      currentNesting = nestingAt[indent];
      currentIndent = indent;
    }

    currentNesting.push(title);
  });
  return result;
}

export function arraysToIndentedScenes(
  arr: any,
  result: IndentedScene[] = [],
  currentIndent = -1,
): IndentedScene[] {
  if (arr instanceof Array) {
    if (arr.length === 0) {
      return result;
    }

    const next = arr.shift();
    const inner = arraysToIndentedScenes(next, [], currentIndent + 1);
    return arraysToIndentedScenes(arr, [...result, ...inner], currentIndent);
  } else {
    return [
      {
        title: arr,
        indent: currentIndent,
      },
    ];
  }
}

export type NumberedScene = IndentedScene & {
  numbering: number[];
};

export function numberScenes(scenes: IndentedScene[]): NumberedScene[] {
  const numbering = [0];
  let lastNumberedIndent = 0;

  return scenes.map((scene) => {
    const { indent } = scene;
    if (indent > lastNumberedIndent) {
      let fill = lastNumberedIndent + 1;
      while (fill <= indent) {
        numbering[fill] = 1;
        fill = fill + 1;
      }
      numbering[indent] = 0;
    } else if (indent < lastNumberedIndent) {
      const start = indent + 1;
      numbering.splice(start, numbering.length - start);
    }
    lastNumberedIndent = indent;

    numbering[indent] = numbering[indent] + 1;
    return {
      ...scene,
      numbering: [...numbering],
    };
  });
}

export function formatSceneNumber(numbering: number[]): string {
  return numbering.join(".");
}

export async function insertProjectFrontmatter(app: App, path: string, project: Project) {
  const exists = await app.vault.adapter.exists(path);
  if (!exists) {
    await app.vault.create(path, "");
  }

  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    return;
  }
  try {
    await app.fileManager.processFrontMatter(file, (fm) => {
      setProjectFrontmatter(fm, project);
    });
  } catch (error) {
    console.error("[Longform] insertProjectFrontmatter: processFrontMatter error:", error);
  }
}

// Legacy alias
export const insertDraftIntoFrontmatter = insertProjectFrontmatter;
