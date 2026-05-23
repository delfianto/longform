import type { TFile } from "obsidian";
import { derived, writable } from "svelte/store";

import { projects, projectWordCounts, selectedProject, sessions, pluginSettings } from "src/model/stores";
import { type SceneWordStats, statsForScene, fileNameFromPath } from "src/model/note-utils";
import { draftForPath } from "src/model/scene-navigation";
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

// Legacy alias
export const selectedDraftWordCountStatus = selectedProjectWordCountStatus;

export const activeFileWordCountStatus = derived(
  [activeFile, selectedProject, projects, projectWordCounts],
  ([$activeFile, , $projects, $projectWordCounts]) =>
    $activeFile
      ? statsFor($activeFile, draftForPath($activeFile.path, $projects), $projects, $projectWordCounts)
      : null,
);

export const goalProgress = derived(
  [selectedProject, sessions, pluginSettings, activeFile, projects],
  ([$selectedProject, $sessions, $pluginSettings, $activeFile, $projects]) => {
    if (!$selectedProject || $sessions.length === 0 || !$pluginSettings) {
      return 0;
    }

    const latestSession = $sessions[0];
    const goal = $pluginSettings.sessionGoal;

    if ($pluginSettings.applyGoalTo === "all") {
      return latestSession.total / goal;
    } else if ($pluginSettings.applyGoalTo === "project") {
      const projectTotal = latestSession.projects?.[$selectedProject.vaultPath];
      if (projectTotal) {
        return projectTotal.total / goal;
      } else {
        return 0;
      }
    } else {
      if (!$activeFile) {
        return 0;
      }
      const project = draftForPath($activeFile.path, $projects);
      if (!project) {
        return 0;
      }
      const name = fileNameFromPath($activeFile.path);
      const projectTotals = latestSession.projects?.[project.vaultPath];
      if (!projectTotals) {
        return 0;
      }
      if (project.format === "single") {
        return projectTotals.total;
      } else {
        const sceneTotal = projectTotals.scenes[name] ?? 0;
        return sceneTotal / goal;
      }
    }
  },
);
