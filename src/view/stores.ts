import type { TFile } from "obsidian";
import { derived, writable } from "svelte/store";

import { projects, projectWordCounts, selectedProject } from "src/model/stores";
import { type SceneWordStats, statsForScene } from "src/model/note-utils";
import type { Project, ProjectWordCounts } from "src/model/types";

// Writable stores
export const activeFile = writable<TFile | null>(null);

export type ExplorerTab = "Scenes" | "Project" | "Compile";
export const selectedTab = writable<ExplorerTab>("Project");

const statsFor = (
  file: TFile,
  project: Project | null | undefined,
  allProjects: Project[],
  wordCounts: ProjectWordCounts,
): SceneWordStats | null => {
  if (project && wordCounts) {
    return statsForScene(file, project, allProjects, wordCounts);
  }
  return null;
};

// Derived stores
export const selectedProjectWordCountStatus = derived(
  [activeFile, selectedProject, projects, projectWordCounts],
  ([$activeFile, $selectedProject, $projects, $projectWordCounts]) =>
    $activeFile && $selectedProject
      ? statsFor($activeFile, $selectedProject, $projects, $projectWordCounts)
      : null,
);
