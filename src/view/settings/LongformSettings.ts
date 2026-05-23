import { App, PluginSettingTab, Setting } from "obsidian";
import type { Unsubscriber } from "svelte/store";
import { get } from "svelte/store";

import type LongformPlugin from "../../main";
import { pluginSettings, userScriptSteps } from "src/model/stores";
import { FolderSuggest } from "./folder-suggest";
import { FileSuggest } from "./file-suggest";
import { syncSceneIndices } from "src/model/store-vault-sync";

export class LongformSettingsTab extends PluginSettingTab {
  plugin: LongformPlugin;
  private unsubscribers: Unsubscriber[] = [];
  private stepsSummary: HTMLElement;
  private stepsList: HTMLUListElement;

  constructor(app: App, plugin: LongformPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const settings = get(pluginSettings);

    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl).setName("Composition").setHeading();
    new Setting(containerEl).setName("New scene template").addSearch((cb) => {
      new FileSuggest(this.app, cb.inputEl);
      cb.setPlaceholder("templates/Scene.md")
        .setValue(settings.sceneTemplate ?? "")
        .onChange((v) => {
          pluginSettings.update((s) => ({
            ...s,
            sceneTemplate: v,
          }));
        });
    });
    containerEl.createEl("p", { cls: "setting-item-description" }, (el) => {
      el.innerHTML =
        "This file will be used as a template when creating new scenes via the New Scene… field. If you use a templating plugin (Templater or the core plugin) it will be used to process this template. This setting applies to all projects and can be overridden per-project in the Project > Project Metadata settings in the Longform pane.";
    });

    new Setting(containerEl)
      .setName("Show scene numbers in Scenes tab")
      .setDesc(
        "If on, shows numbers for scenes with subscenes separated by periods, e.g. 1.1.2. Create subscenes by dragging a scene to an indent under an existing scene, or us an indent command.",
      )
      .addToggle((cb) => {
        cb.setValue(settings.numberScenes);
        cb.onChange((value) => {
          pluginSettings.update((s) => ({
            ...s,
            numberScenes: value,
          }));
        });
      });

    new Setting(containerEl)
      .setName("Write scene index to frontmatter")
      .setDesc(
        "If enabled, will add a scene index, and scene number, to the frontmatter of scene files.",
      )
      .addToggle((toggle) => {
        toggle.setValue(settings.writeProperty);
        toggle.onChange((value) => {
          pluginSettings.update((settings) => ({
            ...settings,
            writeProperty: value,
          }));
          if (value) {
            syncSceneIndices(this.app);
          }
        });
      });

    new Setting(containerEl).setName("Compile").setHeading();

    new Setting(containerEl)
      .setName("User script step folder")
      .setDesc(
        ".js files in this folder will be available as User Script Steps in the Compile panel.",
      )
      .addSearch((cb) => {
        new FolderSuggest(this.app, cb.inputEl);
        cb.setPlaceholder("my/script/steps/")
          .setValue(settings.userScriptFolder ?? "")
          .onChange((v) => {
            pluginSettings.update((s) => ({
              ...s,
              userScriptFolder: v,
            }));
          });
      });

    this.stepsSummary = containerEl.createSpan();
    this.stepsList = containerEl.createEl("ul", {
      cls: "longform-settings-user-steps",
    });
    this.unsubscribers.push(
      userScriptSteps.subscribe((steps) => {
        if (steps && steps.length > 0) {
          this.stepsSummary.innerText = `Loaded ${steps.length} step${
            steps.length !== 1 ? "s" : ""
          }:`;
        } else {
          this.stepsSummary.innerText = "No steps loaded.";
        }
        if (this.stepsList) {
          this.stepsList.empty();
          if (steps) {
            steps.forEach((s) => {
              const stepEl = this.stepsList.createEl("li");
              stepEl.createSpan({
                text: s.description.name,
                cls: "longform-settings-user-step-name",
              });
              stepEl.createSpan({
                text: `(${s.description.canonicalID})`,
                cls: "longform-settings-user-step-id",
              });
            });
          }
        }
      }),
    );
    containerEl.createEl("p", { cls: "setting-item-description" }, (el) => {
      el.innerHTML =
        "User Script Steps are automatically loaded from this folder. Changes to .js files in this folder are synced with Longform after a slight delay. If your script does not appear here or in the Compile tab, you may have an error in your script—check the dev console for it.";
    });

    new Setting(containerEl).setName("Troubleshooting").setHeading();

    new Setting(containerEl)
      .setName("Wait for Obsidian Sync")
      .setDesc(
        "Prevent Longform from running until Obsidian Sync completes its first sync. If you are using Sync, you may want to enable this if you experience issues with scenes disappearing or falsely being shown as new.",
      )
      .addToggle((cb) => {
        cb.setValue(settings.waitForSync);
        cb.onChange((value) => {
          pluginSettings.update((s) => ({
            ...s,
            waitForSync: value,
          }));
        });
      });

    new Setting(containerEl)
      .setName("Enable fallback wait")
      .setDesc(
        "If sync status cannot be detected, wait for the time specified below before looking for scenes.",
      )
      .addToggle((cb) => {
        cb.setValue(settings.fallbackWaitEnabled);
        cb.onChange((value) => {
          pluginSettings.update((s) => ({
            ...s,
            fallbackWaitEnabled: value,
          }));
        });
      });

    new Setting(containerEl)
      .setName("Fallback wait time")
      .setDesc("Time to wait in seconds if sync status cannot be detected.")
      .addText((cb) => {
        cb.setValue(settings.fallbackWaitTime.toString());
        cb.onChange((value) => {
          const numberValue = parseInt(value);
          if (!isNaN(numberValue) && numberValue > 0) {
            pluginSettings.update((s) => ({
              ...s,
              fallbackWaitTime: numberValue,
            }));
          }
        });
      });

    new Setting(containerEl).setName("Credits").setHeading();

    containerEl.createEl("p", {}, (el) => {
      el.innerHTML =
        'Longform written and maintained by <a href="https://kevinbarrett.org">Kevin Barrett</a>.';
    });
    containerEl.createEl("p", {}, (el) => {
      el.innerHTML =
        'Read the source code and report issues at <a href="https://github.com/kevboh/longform">https://github.com/kevboh/longform</a>.';
    });
    containerEl.createEl("p", {}, (el) => {
      el.innerHTML =
        'Icon made by <a href="https://www.flaticon.com/authors/zlatko-najdenovski" title="Zlatko Najdenovski">Zlatko Najdenovski</a> from <a href="https://www.flaticon.com/" title="Flaticon">www.flaticon.com</a>.';
    });
  }

  hide(): void {
    this.unsubscribers.forEach((u) => u());
  }
}
