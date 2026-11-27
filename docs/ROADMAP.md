# Roadmap

✅ done in this scaffold · ◐ partial · ☐ to do

## Phase 0: Spike (1–2 weeks)

- ✅ Tauri 2 shell, CodeMirror 6 editor, open/save `.mdx`
- ✅ `mdxjs` compile → sandboxed preview rendering team components
- ◐ Verified on Ubuntu WebKitGTK (headless). ☐ Test on macOS WKWebView, Windows WebView2 and the team's real Linux GPUs
- ☐ Exit check: preview updates in under 200 ms after typing on all three OSes

## Slides

- ✅ Phase 1: `type: slides`, `---` between slides, slide preview that follows the cursor, presenting with keyboard / clicker, overview, reset, component state kept, errors contained per slide
- ✅ Phase 2: layouts, columns, step reveals, speaker notes, slide list in the sidebar, overflow warning, new-deck template, PDF with one slide per page, warning for `---` directly under text, deck-friendly lint rules
- ☐ Later: presenter view on a second screen, transitions, themes, opt-in network access for demos

## Phase 1: MVP (6–8 weeks)

1. ✅ Highlighting for Markdown + JSX + ESM + YAML (nested Lezer parsers, `ui/src/editor/mdx-language.ts`)
2. ◐ Split preview: ✅ scroll sync editor → preview, ✅ error reporting. ✅ click-to-source (preview → editor), ✅ cursor outline, ✅ desktop / mobile width, ✅ multiple file tabs, ✅ error overlay linked to source lines. ☐ Scroll sync preview → editor; ☐ relative component imports
3. ✅ Component palette, tag/prop/value completion and manifest diagnostics. ✅ Hover docs for components and props
4. ✅ Problems panel (syntax, compile, components, frontmatter, links, a11y, mdxlint/remark-lint rules; override with `.mdx-ide/mdxlint-rules.json`, disable with `lint.mdxlint_rules = false`)
5. ✅ Frontmatter: schema validation and a form generated from the schema, with a raw-YAML toggle (TOML frontmatter: YAML view only is hidden)
6. ✅ Outline panel and heading navigation
7. ✅ Broken link, anchor and image checking. ☐ Persistent workspace index (SQLite/redb) instead of re-parsing link targets
8. ✅ `.mdx`-only explorer, filter, workspace search. ✅ Fuzzy quick-open (⌘P) and ⌘K command palette, ✅ new file (from the collection template) and new folder, rename / move (including drag and drop) and delete to Trash, links and relative imports updated on rename / move, resizable and collapsible sidebar
9. ✅ Format on save via `mdxlint` sidecar (`sidecars/mdxlint`, needs Node; `lint.format_on_save`, rc in `.mdx-ide/mdxlintrc.json`) (not Prettier: it doesn't support MDX 3)
10. ✅ Paste/drop images → copied into `assets_dir`, relative path inserted
11. ☐ Signed installers + `tauri-plugin-updater` (CI release job is ready; add signing keys and updater endpoint)

## Phase 2: v1 (8–12 weeks)

- ✅ Git (`crates/mdx-git`, driving the `git` CLI for reads and writes): status, stage / unstage / commit, fetch / fast-forward pull / push (never forced), create and switch branches, source and rendered diff, blame. ✅ discard (new files go to the Trash). ☐ Merge / rebase, conflict resolution UI
- Rich/WYSIWYG mode (MDXEditor with `jsxPlugin` property editors)
- Slash commands from the manifest (`/callout`, `/tabs`, `/image`) and the snippet library
- Docs-site-aware preview (Docusaurus / Next.js / Astro theme, global CSS, MDX component map) and a "site-accurate" Node compile mode
- Relative component imports in the preview (Oxc transform, served via `mdxpreview://`)
- Backlinks / link graph; renaming a heading updates links (renaming / moving pages already does)
- Spell check (prose nodes only) and a team glossary
- More a11y rules: heading level skips, empty links, "click here" link text
- Keymaps (VS Code / Vim), theming
- WASM plugin API with Extism (custom lint rules, transforms, export targets)

## Phase 3: Later

- Real-time co-editing (yrs + y-codemirror.next, or Loro) with presence
- Review comments stored outside the MDX (sidecar JSON or Git notes)
- Opt-in AI assist (rewrite, frontmatter descriptions, component suggestions) with a configurable or self-hosted provider
- ✅ PDF export on macOS (keeps component state). ☐ PDF on Windows / Linux, page options (paper size, headers), HTML export
- Doc analytics: stale docs, CODEOWNERS, component coverage
- Linux: move to Tauri 3's CEF runtime once stable
