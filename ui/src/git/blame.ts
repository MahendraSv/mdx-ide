// A gutter showing who last changed each line.

import type { Extension } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";
import type { Blame } from "../api";

type Commit = Blame["commits"][number];

export function age(seconds: number, now = Date.now()): string {
  const days = Math.floor((now / 1000 - seconds) / 86_400);
  if (days < 1) return "today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

class BlameMarker extends GutterMarker {
  constructor(
    readonly commit: Commit,
    /** Only the first line of a run from one commit carries the text. */
    readonly first: boolean,
  ) {
    super();
  }
  eq(other: BlameMarker) {
    return other.commit === this.commit && other.first === this.first;
  }
  toDOM() {
    const { id, author, time, summary } = this.commit;
    const el = document.createElement("span");
    el.className = id ? "blame-line" : "blame-line uncommitted";
    el.title = id ? `${id} · ${author} · ${new Date(time * 1000).toLocaleString()}\n${summary}` : summary;
    el.textContent = this.first ? (id ? `${author} · ${age(time)}` : "Uncommitted") : "";
    return el;
  }
}

export function blameGutter(blame: Blame): Extension {
  return gutter({
    class: "cm-blame",
    lineMarker(view, block) {
      const line = view.state.doc.lineAt(block.from).number - 1;
      const index = blame.lines[line];
      const commit = index === undefined ? undefined : blame.commits[index];
      return commit ? new BlameMarker(commit, line === 0 || blame.lines[line - 1] !== index) : null;
    },
    lineMarkerChange: () => false,
  });
}
