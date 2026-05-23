import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import builtins from "builtin-modules";
import { copyFileSync } from "node:fs";
import path from "node:path";

// vite build always sets NODE_ENV=production, so use --watch presence to detect dev mode.
// Dev: watches and rebuilds into the test vault (alongside an already-placed manifest.json).
// Prod: outputs to ./dist next to main.js + styles.css + a freshly-copied manifest.json,
// ready to be zipped as a release artifact.
const isWatch = process.argv.includes("--watch");
const outDir = isWatch ? "test-longform-vault/.obsidian/plugins/longform" : "dist";

// Copies manifest.json into the prod outDir at the end of the build so the
// release artifacts (manifest.json, main.js, styles.css) are co-located.
function copyManifest(): Plugin {
  return {
    name: "copy-manifest-to-dist",
    apply: "build",
    closeBundle() {
      if (isWatch) return;
      const src = path.resolve("manifest.json");
      const dest = path.resolve(outDir, "manifest.json");
      copyFileSync(src, dest);
    },
  };
}

export default defineConfig({
  plugins: [svelte(), copyManifest()],

  resolve: {
    alias: {
      // Source files use `src/...` as bare imports (no leading ./)
      src: path.resolve("./src"),
    },
  },

  build: {
    lib: {
      entry: "src/main.ts",
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: [
        "obsidian",
        "electron",
        "@codemirror/autocomplete",
        "@codemirror/collab",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/common",
        "@lezer/highlight",
        "@lezer/lr",
        ...builtins,
      ],
      output: {
        entryFileNames: "main.js",
        assetFileNames: (info) =>
          info.name?.endsWith(".css") ? "styles.css" : (info.name ?? "asset"),
      },
    },
    outDir,
    emptyOutDir: !isWatch,
    sourcemap: !isWatch ? false : "inline",
    minify: !isWatch,
    copyPublicDir: false,
  },
});
