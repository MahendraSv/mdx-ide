// Shared helpers for the Git panel, explorer markers and diff view.

import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import type { ChangedFile, GitStatus } from "../api";

/** A file shown in the diff view: staged (last commit → index) or not (index → working tree). */
export interface DiffTarget {
  path: string;
  staged: boolean;
}

const LABELS: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Untracked", "!": "Conflict" };

export const describe = (letter: string) => LABELS[letter] ?? "Changed";

export const letterFor = (file: ChangedFile, staged: boolean) => (file.conflicted ? "!" : (staged ? file.staged : file.unstaged) ?? "M");

/** The path as the explorer knows it, or null for files outside the open folder. */
export const workspacePath = (status: GitStatus, path: string) => (path.startsWith(status.workspacePrefix) ? path.slice(status.workspacePrefix.length) : null);

/** Every changed file of the open folder, with the letter to show next to it. */
export function explorerMarks(status: GitStatus | null): ReadonlyMap<string, string> {
  const marks = new Map<string, string>();
  for (const file of status?.files ?? []) {
    const path = workspacePath(status!, file.path);
    if (path !== null) marks.set(path, letterFor(file, file.unstaged === null));
  }
  return marks;
}

/** 1-based, inclusive line ranges that differ, for each side. */
export function changedLines(before: string, after: string): { removed: [number, number][]; added: [number, number][] } {
  const a = Text.of(before.split("\n"));
  const b = Text.of(after.split("\n"));
  const removed: [number, number][] = [];
  const added: [number, number][] = [];
  // Blank lines at the edges of a change belong to no block; keeping them would also mark
  // the neighbouring block, whose source range reaches the blank line.
  const mark = (into: [number, number][], doc: Text, from: number, to: number) => {
    let first = doc.lineAt(Math.min(from, doc.length)).number;
    let last = doc.lineAt(Math.min(to, doc.length)).number;
    while (first <= last && !doc.line(first).text.trim()) first++;
    while (last >= first && !doc.line(last).text.trim()) last--;
    if (first <= last) into.push([first, last]);
  };
  for (const c of Chunk.build(a, b)) {
    // An empty side (pure insertion or deletion) has nothing to mark.
    if (c.toA > c.fromA) mark(removed, a, c.fromA, c.endA);
    if (c.toB > c.fromB) mark(added, b, c.fromB, c.endB);
  }
  return { removed, added };
}

/** The YAML block at the top of a page, which the rendered view does not show. */
export const frontmatterOf = (text: string) => /^---\r?\n[\s\S]*?\r?\n---/.exec(text)?.[0] ?? "";
