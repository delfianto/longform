import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import builtins from "builtin-modules";
import path from "path";

// vite build always sets NODE_ENV=production, so use --watch presence to detect dev mode.
// Dev: watches and rebuilds into the test vault.
// Prod: outputs to project root where manifest.json lives.
const isWatch = process.argv.includes("--watch");
const outDir = isWatch ? "test-longform-vault/.obsidian/plugins/longform" : ".";

export default defineConfig({
  plugins: [svelte()],

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
    emptyOutDir: false,
    sourcemap: !isWatch ? false : "inline",
    minify: !isWatch,
    copyPublicDir: false,
    // Suppress the "outDir same as root" check for the prod build
    ...(!isWatch && { assetsDir: "" }),
  },
});
