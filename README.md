# Longform (delfianto fork)

A personal fork of [kevboh/longform](https://github.com/kevboh/longform) — the Obsidian plugin for writing novels, screenplays, and other long-form projects. This fork rebuilds the toolchain and rethinks how project metadata lives in your vault, primarily to:

- make `Index.md` frontmatter safe to round-trip through Obsidian's Properties UI without nuking your project, and
- treat eBook / Dublin Core metadata as a first-class part of the project — no separate sidecar files.

If you want stable, community-supported Longform, use [the upstream](https://github.com/kevboh/longform). It is what most people want. The rest of this README assumes you've read the upstream's [README](https://github.com/kevboh/longform/blob/main/README.md) at least once and want to know what's different here.

> [!CAUTION]
> This fork makes **breaking changes** to the `Index.md` frontmatter schema and ships **no automated migration** for projects authored against upstream's `2.x`. Existing projects need to be hand-edited once. See [Breaking changes](#breaking-changes-vs-upstream-2x) below.

## What this is

- A personal fork, version-bumped to **3.0**, sharing the upstream plugin id `longform`.
- Modernized stack: [Bun](https://bun.com), [Vite+](https://voidzero.dev) (alpha) as a unified toolchain, Svelte 5 (runes), TypeScript 5.7+.
- **Flat frontmatter schema** — every project key lives at the top level of `Index.md` so Obsidian's Properties UI can edit it without flattening or losing structure.
- **eBook metadata first-class** — `author`, `language`, `identifier`, `description`, `cover`, `publisher`, `pubdate`, `rights`, `subjects`, `series`, `seriesIndex` live alongside `title` / `workflow` / `scenes`. An EPUB-producing compile step can read them directly; no sidecar file.
- **Scene display labels** — the Scenes tab uses each scene file's `frontmatter.title` as its row label (live-updating), falling back to the filename. Lets you name files concisely (`ch01-s02.md`) while displaying a friendlier title.
- All other upstream features still work: sidebar pane, reorderable nested scene list, per-project/per-scene word counts in the Project tab, compile workflows, single-scene and multi-scene projects, multiple drafts grouped by title. Writing-session goals and the status-bar word count have been removed — Obsidian's built-in word-count statistic covers the latter.

## What this is NOT

- **Not the upstream Longform.** It will not appear in Obsidian's Community Plugins store. Installation is manual.
- **Not a drop-in replacement** for existing Longform `2.x` projects. The schema break is intentional and one-time.
- **Not maintained for general users.** Built to scratch my own writing setup; happy to take PRs but no roadmap, no support promises, no guarantees of stability across releases.
- **Not co-installable with upstream Longform** — both plugins claim the same plugin id. Disable one before enabling the other.

## Breaking changes vs. upstream `2.x`

| Area | Upstream `2.x` | This fork (`3.x`) |
|---|---|---|
| Discriminator | Nested `longform:` object with `format:` inside | Top-level `longform: scenes` or `longform: single` |
| Project keys | Nested under `longform.*` | Top-level — `title`, `workflow`, `sceneFolder`, `scenes`, `ignoredFiles`, `sceneTemplate` |
| Scene hierarchy | Nested YAML arrays (`- - second scene`) | Flat array with `> ` prefix tokens (`"> second scene"`) — round-trips safely through Obsidian's Properties UI |
| eBook metadata | Not handled; users keep a sidecar file | First-class top-level keys (see above) plus a collapsible "eBook Metadata" section in the Project tab, with a Generate-UUID button and FileSuggest for cover |
| Scene display label | Filename only | `frontmatter.title` of each scene file, falling back to filename |
| Migration | Plugin runs a migration on first launch | **None.** Files using the legacy nested form are silently ignored. |
| `v1` (folder-based) → `v2` migration | Built-in `Migrate` button + docs | **Removed.** Files predating `v2` are unsupported. |

### Migrating an existing `2.x` project

Open each `Index.md` and rewrite the frontmatter. **Before:**

```yaml
---
longform:
  format: scenes
  title: My Novel
  workflow: Default Workflow
  sceneFolder: /
  scenes:
    - first scene
    - - second scene
      - third scene
    - fourth
  ignoredFiles:
    - "*-scratch"
---
```

**After:**

```yaml
---
longform: scenes
title: My Novel
workflow: Default Workflow
sceneFolder: /
scenes:
  - first scene
  - "> second scene"
  - "> third scene"
  - fourth
ignoredFiles:
  - "*-scratch"
---
```

That's the whole migration. Each nested array level in `scenes:` becomes one `> ` token. Save the file and the project reappears in the Longform pane. eBook fields are optional and can be added later through the Project tab UI.

See [docs/INDEX_FILE.md](./docs/INDEX_FILE.md) for the full schema and [docs/MULTIPLE_SCENE_PROJECTS.md](./docs/MULTIPLE_SCENE_PROJECTS.md) for the hierarchy details.

## Installing

Not in the Community Plugins store. Manual install:

1. Download `manifest.json`, `main.js`, and `styles.css` from a [release](https://github.com/delfianto/longform/releases).
2. Drop them into `.obsidian/plugins/longform/` inside your vault.
3. Enable **Longform (fork)** in Obsidian's Community Plugins settings.

Disable the upstream Longform first if you have it — both plugins share the `longform` plugin id and will conflict.

## Getting started

UI flows for creating, reordering, and compiling projects are unchanged from upstream. Refer to the upstream [README](https://github.com/kevboh/longform/blob/main/README.md) for the visual walkthrough. The only thing that differs in practice is the on-disk `Index.md` schema, covered above and in [docs/INDEX_FILE.md](./docs/INDEX_FILE.md).

## Stack

| Layer | Tool |
|---|---|
| Runtime / package manager | [Bun](https://bun.com) |
| Build / lint / format / test / type-aware lint | [Vite+](https://voidzero.dev) (alpha) — `vp build`, `vp test`, `vp check`, `vp lint`, `vp fmt` |
| UI framework | Svelte 5 (runes mode) |
| Type-checking | `tsc --noEmit` + `svelte-check` (kept until Vite+ adds Svelte type-check coverage) |

Standalone `vite` and `vitest` are not declared as devDependencies — they resolve to Vite+'s vendored versions via `package.json` `overrides`.

## Development

```sh
bun install          # one-time
bun run dev          # watch build into test-longform-vault/.obsidian/plugins/longform
bun run build        # production build → ./dist (main.js, styles.css, manifest.json)
bun run test         # vp test run (vitest)
bun run type-check   # tsc + svelte-check
bun run check        # vp check (format + lint)
bun run lint:fix     # autofix lint
bun run format       # autofix formatting
```

Release artifacts after `bun run build` live in `./dist/`. Zip the three files there for a GitHub release; users drop them into `.obsidian/plugins/longform/`.

## Scene-only styling

Longform attaches the `.longform-leaf` CSS class to any pane editing a scene or index file. This lets you style your writing environment independently of the rest of Obsidian. See the upstream [Scene-only Styling](https://github.com/kevboh/longform#scene-only-styling) section for a working example — behavior is unchanged in this fork.

## Troubleshooting

> [!IMPORTANT]
> **Longform never alters the contents of your scene notes.** The only file it rewrites is each project's `Index.md`. Scene files are read-only from the plugin's perspective. (The optional `writeProperty` setting can also add `longform-order` / `longform-number` to scene files; that's the only exception, and it's opt-in.)

If a project disappears from the sidebar after you edit its `Index.md`, the frontmatter no longer matches the v3 schema — most often a missing top-level `longform: scenes` (or `single`). Either fix it by hand or restart Obsidian. Longform recomputes projects from frontmatter on each load and never deletes files based on frontmatter state.

## License

See [LICENSE.md](./LICENSE.md). Same MIT lineage as upstream.

## Credits

This fork stands entirely on [kevboh's](https://github.com/kevboh) original [Longform](https://github.com/kevboh/longform). The plugin architecture, compile pipeline, sidebar UX, and most of what makes Longform useful were all there before I touched it. The community [collection of compile steps](https://github.com/obsidian-community/longform-compile-steps) continues to apply — the compile step API is unchanged.
