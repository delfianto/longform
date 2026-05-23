export const LONGFORM_CURRENT_PLUGIN_DATA_VERSION = 3;
export const LONGFORM_CURRENT_INDEX_VERSION = 2;

export type IndentedScene = {
  title: string;
  indent: number;
};

export type EbookMetadata = {
  author?: string;
  language?: string;
  identifier?: string;
  description?: string;
  cover?: string;
  publisher?: string;
  pubdate?: string;
  rights?: string;
  subjects?: string[];
  series?: string;
  seriesIndex?: number;
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
  ebook: EbookMetadata;
};

export type SingleSceneProject = {
  format: "single";
  title: string;
  titleInFrontmatter: boolean;
  vaultPath: string;
  workflow: string | null;
  ebook: EbookMetadata;
};

export type Project = MultipleSceneProject | SingleSceneProject;

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

export interface LongformPluginSettings {
  version: number;
  selectedProjectPath: string | null;
  workflows: Record<string, SerializedWorkflow> | null;
  userScriptFolder: string | null;
  numberScenes: boolean;
  sceneTemplate: string | null;
  waitForSync: boolean;
  fallbackWaitEnabled: boolean;
  fallbackWaitTime: number;
  writeProperty: boolean;
}

export const DEFAULT_SETTINGS: LongformPluginSettings = {
  version: LONGFORM_CURRENT_PLUGIN_DATA_VERSION,
  selectedProjectPath: null,
  workflows: null,
  userScriptFolder: null,
  numberScenes: false,
  sceneTemplate: null,
  writeProperty: false,
  waitForSync: false,
  fallbackWaitEnabled: true,
  fallbackWaitTime: 5,
};

export const TRACKED_SETTINGS_PATHS: (keyof LongformPluginSettings)[] = [
  "version",
  "selectedProjectPath",
  "userScriptFolder",
  "numberScenes",
  "sceneTemplate",
  "waitForSync",
  "fallbackWaitEnabled",
  "fallbackWaitTime",
  "writeProperty",
];

export const PASSTHROUGH_SAVE_SETTINGS_PATHS: (keyof LongformPluginSettings)[] = [
  "userScriptFolder",
  "numberScenes",
  "sceneTemplate",
  "waitForSync",
  "fallbackWaitEnabled",
  "fallbackWaitTime",
  "writeProperty",
];
