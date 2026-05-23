import { derived, writable } from "svelte/store";
import { sortBy } from "lodash";

import type { ProjectWordCounts, Project, LongformPluginSettings } from "./types";
import type { Workflow, CompileStep } from "src/compile/steps/abstract-compile-step";

// WRITEABLE STORES

export const initialized = writable<boolean>(false);
export const pluginSettings = writable<LongformPluginSettings>(null);

/** All discovered longform projects. */
export const projects = writable<Project[]>([]);

/** Full, normalized vault path to the currently selected project's index file. */
export const selectedProjectPath = writable<string | null>(null);

export const workflows = writable<Record<string, Workflow>>({});
export const userScriptSteps = writable<CompileStep[] | null>(null);
export const projectWordCounts = writable<ProjectWordCounts>({});
export const waitingForSync = writable<boolean>(false);

// DERIVED STORES

/** All projects indexed by title (one project per title). */
export const projectsByTitle = derived([projects], ([$projects]) => {
  const sorted = sortBy($projects, (p) => p.title);
  const result: Record<string, Project> = {};
  for (const p of sorted) {
    result[p.title] = p;
  }
  return result;
});

/** The currently selected project, resolved from selectedProjectPath. */
export const selectedProject = derived(
  [projects, selectedProjectPath],
  ([$projects, $selectedProjectPath]) => {
    if (!$selectedProjectPath) return null;
    return $projects.find((p) => p.vaultPath === $selectedProjectPath) ?? null;
  },
);

/** The current draft's workflow, if one is selected. */
export const currentWorkflow = derived(
  [workflows, selectedProject],
  ([$workflows, $selectedProject]) => {
    if ($selectedProject) {
      const name = $selectedProject.workflow;
      if (name) return $workflows[name];
    }
    return null;
  },
);
