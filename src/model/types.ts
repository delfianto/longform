export const LONGFORM_CURRENT_PLUGIN_DATA_VERSION = 3;
export const LONGFORM_CURRENT_INDEX_VERSION = 1;

export type IndentedScene = {
  title: string;
  indent: number;
};

export type MultipleSceneProject = {
  format: "scenes";
  title: string;
  titleInFrontmatter: boolean;
  vaultPath: string;
  workflow: string | null;
  sceneFolder: string;
  scenes: IndentedScene[];
  ignoredFiles: string[] | null;
  unknownFiles: string[];
  sceneTemplate: string | null;
};

export type SingleSceneProject = {
  format: "single";
  title: string;
  titleInFrontmatter: boolean;
  vaultPath: string;
  workflow: string | null;
};

export type Project = MultipleSceneProject | SingleSceneProject;

// Legacy type aliases — kept so compile steps and API callers don't all need updating at once.
export type Draft = Project;
export type MultipleSceneDraft = MultipleSceneProject;
export type SingleSceneDraft = SingleSceneProject;

export type SerializedStep = {
  id: string;
  optionValues: { [id: string]: unknown };
};

export type SerializedWorkflow = {
  name: string;
  description: string;
  steps: SerializedStep[];
};

/**
 * Maps project vault paths to either a map of scene names to word counts or,
 * in the case of single-scene projects, the word count.
 */
export type ProjectWordCounts = Record<string, Record<string, number> | number>;

// Legacy alias
export type DraftWordCounts = ProjectWordCounts;

export type WordCountSession = {
  start: Date;
  total: number;
  /** Keyed by vault path of the project. */
  projects: Record<
    string,
    {
      total: number;
      scenes: Record<string, number>;
    }
  >;
};

export interface LongformPluginSettings {
  version: number;
  selectedProjectPath: string | null;
  workflows: Record<string, SerializedWorkflow> | null;
  userScriptFolder: string | null;
  sessionStorage: "data" | "plugin-folder" | "file";
  sessions: WordCountSession[];
  showWordCountInStatusBar: boolean;
  startNewSessionEachDay: boolean;
  sessionGoal: number;
  applyGoalTo: "all" | "project" | "note";
  notifyOnGoal: boolean;
  countDeletionsForGoal: boolean;
  keepSessionCount: number;
  sessionFile: string;
  numberScenes: boolean;
  sceneTemplate: string | null;
  waitForSync: boolean;
  fallbackWaitEnabled: boolean;
  fallbackWaitTime: number;
  writeProperty: boolean;
  // DEPRECATED. To be removed in future, needed now for migrations.
  projects: {
    [path: string]: {
      indexFile: string;
      draftsPath: string;
    };
  };
}

export const DEFAULT_SESSION_FILE = "longform-sessions.json";

export const DEFAULT_SETTINGS: LongformPluginSettings = {
  version: LONGFORM_CURRENT_PLUGIN_DATA_VERSION,
  selectedProjectPath: null,
  workflows: null,
  userScriptFolder: null,
  sessionStorage: "data",
  sessions: [],
  showWordCountInStatusBar: true,
  startNewSessionEachDay: true,
  sessionGoal: 500,
  applyGoalTo: "all",
  notifyOnGoal: true,
  countDeletionsForGoal: false,
  keepSessionCount: 30,
  sessionFile: DEFAULT_SESSION_FILE,
  numberScenes: false,
  sceneTemplate: null,
  writeProperty: false,
  projects: {},
  waitForSync: false,
  fallbackWaitEnabled: true,
  fallbackWaitTime: 5,
};

export const TRACKED_SETTINGS_PATHS: (keyof LongformPluginSettings)[] = [
  "version",
  "projects",
  "selectedProjectPath",
  "userScriptFolder",
  "sessionStorage",
  "sessions",
  "showWordCountInStatusBar",
  "startNewSessionEachDay",
  "sessionGoal",
  "applyGoalTo",
  "notifyOnGoal",
  "countDeletionsForGoal",
  "keepSessionCount",
  "sessionFile",
  "numberScenes",
  "sceneTemplate",
  "waitForSync",
  "fallbackWaitEnabled",
  "fallbackWaitTime",
  "writeProperty",
];

export const PASSTHROUGH_SAVE_SETTINGS_PATHS: (keyof LongformPluginSettings)[] = [
  "sessionStorage",
  "userScriptFolder",
  "showWordCountInStatusBar",
  "startNewSessionEachDay",
  "sessionGoal",
  "applyGoalTo",
  "notifyOnGoal",
  "countDeletionsForGoal",
  "keepSessionCount",
  "sessionFile",
  "numberScenes",
  "sceneTemplate",
  "waitForSync",
  "fallbackWaitEnabled",
  "fallbackWaitTime",
  "writeProperty",
];
