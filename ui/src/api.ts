// Typed wrappers around the Rust IPC commands (src-tauri/src/commands.rs).
// Types mirror crates/mdx-core. TODO: generate these with tauri-specta.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PreviewPage } from "./preview-protocol";

export interface Point { line: number; column: number; offset: number }
export interface Range { start: Point; end: Point }
export type Severity = "error" | "warning" | "info";

export type { PreviewPage };

export interface Diagnostic {
  range: Range | null;
  severity: Severity;
  source: "syntax" | "compile" | "components" | "frontmatter" | "links" | "a11y" | "mdxlint";
  rule: string;
  message: string;
}

export interface OutlineItem { depth: number; text: string; slug: string; range: Range | null }

export interface DocumentAnalysis {
  outline: OutlineItem[];
  links: { kind: string; url: string; range: Range | null }[];
  components: { name: string | null; inline: boolean; hasSpread: boolean; range: Range | null }[];
  frontmatter: { format: "yaml" | "toml"; raw: string; range: Range | null } | null;
  importedNames: string[];
  diagnostics: Diagnostic[];
  wordCount: number;
}

export interface PropSpec { name: string; type: string; required: boolean; values: string[]; description: string }
export interface ComponentSpec {
  name: string;
  description: string;
  category?: string;
  props: PropSpec[];
  acceptsChildren: boolean;
  snippet?: string;
}
export interface ComponentManifest { package?: string; components: ComponentSpec[] }

export interface FileEntry { path: string; size: number }
export interface WorkspaceInfo {
  root: string;
  files: FileEntry[];
  dirs: string[];
  manifest: ComponentManifest | null;
  configProblems: string[];
  formatOnSave: boolean;
  mdxlintRules: boolean;
}

export interface CompletionItem {
  label: string;
  type: string;
  detail: string | null;
  info: string | null;
  snippet: string | null;
}

export interface SearchHit { path: string; line: number; column: number; preview: string }

export type PreviewResult = ({ status: "ok" } & PreviewPage) | { status: "error"; diagnostic: Diagnostic };

export interface RenameReport {
  path: string;
  /** Pages whose links were updated; `disk` / `buffer` carry new saved / unsaved text. */
  files: { path: string; links: number; disk: string | null; buffer: string | null }[];
  skipped: string[];
}

export interface ChangedFile {
  /** Relative to the repository root. */
  path: string;
  origPath: string | null;
  /** Index vs last commit: M, A, D, R, C, T. */
  staged: string | null;
  /** Working tree vs index; U = untracked. */
  unstaged: string | null;
  conflicted: boolean;
}

export interface GitStatus {
  repoRoot: string;
  /** The open folder inside the repository: "" or "sub/folder/". */
  workspacePrefix: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  /** The upstream branch is configured but no longer exists. */
  upstreamGone: boolean;
  remotes: string[];
  ahead: number;
  behind: number;
  files: ChangedFile[];
}

export interface Branch { name: string; remote: boolean; current: boolean }
export interface FileDiff { old: string; new: string; binary: boolean }
export interface Blame {
  commits: { id: string | null; author: string; time: number; summary: string }[];
  /** Per line, an index into `commits`. */
  lines: number[];
}

export const api = {
  exportPdf: (snapshot: { body: string; styles: string; theme: string }, title: string, path: string) => invoke<void>("export_pdf", { snapshot, title, path }),
  gitStatus: () => invoke<GitStatus | null>("git_status"),
  gitStage: (paths: string[]) => invoke<void>("git_stage", { paths }),
  gitUnstage: (paths: string[]) => invoke<void>("git_unstage", { paths }),
  gitDiscard: (paths: string[]) => invoke<void>("git_discard", { paths }),
  gitCommit: (message: string) => invoke<string>("git_commit", { message }),
  gitBranches: () => invoke<Branch[]>("git_branches"),
  gitSwitch: (name: string) => invoke<void>("git_switch", { name }),
  gitCreateBranch: (name: string) => invoke<void>("git_create_branch", { name }),
  gitFetch: () => invoke<void>("git_fetch"),
  gitPull: () => invoke<number>("git_pull"),
  gitPush: () => invoke<{ target: string; published: boolean; commits: number }>("git_push"),
  gitDiff: (path: string, staged: boolean) => invoke<FileDiff>("git_diff", { path, staged }),
  gitBlame: (path: string, contents: string) => invoke<Blame>("git_blame", { path, contents }),
  initialFolder: () => invoke<string | null>("initial_folder"),
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  listFiles: () => invoke<WorkspaceInfo>("list_files"),
  createFile: (path: string, date: string) => invoke<string>("create_file", { path, date }),
  createFolder: (path: string) => invoke<string>("create_folder", { path }),
  renameEntry: (from: string, to: string, unsaved: Record<string, string>) => invoke<RenameReport>("rename_entry", { from, to, unsaved }),
  trashEntry: (path: string) => invoke<void>("trash_entry", { path }),
  entryFileCount: (path: string) => invoke<number>("entry_file_count", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, contents: string) => invoke<void>("write_file", { path, contents }),
  analyze: (path: string, source: string) => invoke<DocumentAnalysis>("analyze", { path, source }),
  /** With `slides`, a page with `type: slides` compiles to a slide deck. */
  compilePreview: (path: string, source: string, slides: boolean) => invoke<PreviewResult>("compile_preview", { path, source, slides }),
  search: (query: string, opts: { regex?: boolean; caseSensitive?: boolean } = {}) =>
    invoke<SearchHit[]>("search", { options: { query, ...opts } }),
  completeComponents: () => invoke<CompletionItem[]>("complete_components"),
  completeProps: (component: string, already: string[]) => invoke<CompletionItem[]>("complete_props", { component, already }),
  completePropValues: (component: string, prop: string) => invoke<CompletionItem[]>("complete_prop_values", { component, prop }),
  saveAsset: (path: string, fileName: string, bytes: number[]) => invoke<string>("save_asset", { path, fileName, bytes }),
  lintMdx: (path: string, source: string) => invoke<Diagnostic[]>("lint_mdx", { path, source }),
  formatMdx: (path: string, source: string) => invoke<string>("format_mdx", { path, source }),
  frontmatterSchema: (path: string) => invoke<unknown | null>("frontmatter_schema", { path }),
};

export function onWorkspaceChanged(cb: (e: { paths: string[]; configChanged: boolean }) => void): Promise<UnlistenFn> {
  return listen<{ paths: string[]; configChanged: boolean }>("workspace://changed", (e) => cb(e.payload));
}
