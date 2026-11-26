import { syntaxHighlighting } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { api, type FileDiff } from "../api";
import { mdxHighlight, mdxLanguage } from "../editor/mdx-language";
import { Preview, type PreviewHandle } from "../Preview";
import { changedLines, frontmatterOf, type DiffTarget } from "./model";

export type DiffMode = "source" | "rendered";

interface Props {
  target: DiffTarget;
  /** Bumped whenever the repository status is re-read. */
  revision: number;
  /** The path relative to the open folder; null when the file is outside it. */
  docPath: string | null;
  mode: DiffMode;
  dark: boolean;
  /** Restarts the preview frames when the team's components change. */
  previewGeneration: number;
  /** The file is open with edits that are not saved, so not part of this diff. */
  unsaved: boolean;
  onMode(mode: DiffMode): void;
  onToggleStage(): void;
  onOpenFile(): void;
  onClose(): void;
}

const LABELS = {
  staged: ["Last commit", "Staged"],
  unstaged: ["Staged / last commit", "Working copy"],
};

export function DiffView(props: Props) {
  const { target, revision, docPath, mode } = props;
  const [diff, setDiff] = useState<{ key: string; value: FileDiff } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${target.staged}:${target.path}`;

  useEffect(() => {
    let current = true;
    api.gitDiff(target.path, target.staged).then(
      (value) => {
        if (!current) return;
        setError(null);
        // Keep the same object if nothing changed, so the views keep their scroll position.
        setDiff((d) => (d?.key === key && d.value.old === value.old && d.value.new === value.new && d.value.binary === value.binary ? d : { key, value }));
      },
      (e) => current && setError(String(e)),
    );
    return () => {
      current = false;
    };
  }, [key, revision]);

  const value = diff?.key === key ? diff.value : null;
  const isPage = target.path.endsWith(".mdx");
  const shown: DiffMode = isPage ? mode : "source";
  const [before, after] = LABELS[target.staged ? "staged" : "unstaged"];

  return (
    <section className="diff" aria-label={`Changes in ${target.path}`}>
      <div className="diff-head">
        <span className="diff-path" title={target.path}>{target.path}</span>
        <span className="chip-pill">{target.staged ? "Staged changes" : "Unstaged changes"}</span>
        <span className="sp" />
        {isPage && (
          <div role="group" aria-label="Diff view" className="group">
            {(["source", "rendered"] as const).map((m) => (
              <button key={m} type="button" className="seg" aria-pressed={shown === m} onClick={() => props.onMode(m)}>
                {m === "source" ? "Source" : "Rendered"}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="btn-ghost" onClick={props.onToggleStage}>{target.staged ? "Unstage" : "Stage"}</button>
        {docPath !== null && isPage && value?.new !== "" && (
          <button type="button" className="btn-ghost" onClick={props.onOpenFile}>Open file</button>
        )}
        <button type="button" className="icon-btn" aria-label="Close changes" title="Close" onClick={props.onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      {props.unsaved && <div className="git-note">This file has unsaved edits. Save it to include them here.</div>}
      <div className="diff-labels">
        <span>{before}</span>
        <span>{after}</span>
      </div>
      {error ? (
        <div className="empty" role="alert">{error}</div>
      ) : !value ? (
        <div className="empty">Loading changes…</div>
      ) : value.binary ? (
        <div className="empty">This file is binary or too large to compare.</div>
      ) : value.old === value.new ? (
        <div className="empty">No differences in the file contents.</div>
      ) : shown === "source" ? (
        <SourceDiff diff={value} />
      ) : (
        <RenderedDiff key={key} diff={value} path={docPath ?? target.path} dark={props.dark} generation={props.previewGeneration} />
      )}
    </section>
  );
}

function SourceDiff({ diff }: { diff: FileDiff }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const extensions = [lineNumbers(), mdxLanguage(), syntaxHighlighting(mdxHighlight), EditorView.lineWrapping, EditorState.readOnly.of(true)];
    const view = new MergeView({
      a: { doc: diff.old, extensions },
      b: { doc: diff.new, extensions },
      parent: host.current!,
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
    });
    return () => view.destroy();
  }, [diff]);
  return <div className="diff-source" ref={host} />;
}

/** Both versions rendered side by side, with the blocks that differ outlined. */
function RenderedDiff({ diff, path, dark, generation }: { diff: FileDiff; path: string; dark: boolean; generation: number }) {
  const lines = changedLines(diff.old, diff.new);
  return (
    <>
      {frontmatterOf(diff.old) !== frontmatterOf(diff.new) && <div className="git-note">The frontmatter changed. It is not rendered; see the Source view.</div>}
      <div className="diff-rendered">
        <Side key={`a${generation}`} label="Before" text={diff.old} path={path} dark={dark} kind="removed" ranges={lines.removed} />
        <Side key={`b${generation}`} label="After" text={diff.new} path={path} dark={dark} kind="added" ranges={lines.added} />
      </div>
    </>
  );
}

function Side({ label, text, path, dark, kind, ranges }: { label: string; text: string; path: string; dark: boolean; kind: "added" | "removed"; ranges: [number, number][] }) {
  const preview = useRef<PreviewHandle>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!text) return;
    let current = true;
    api.compilePreview(path, text).then(
      (result) => {
        if (!current) return;
        if (result.status === "ok") {
          setError(null);
          preview.current?.render(result.code, path);
          preview.current?.markChanges(kind, ranges);
        } else {
          preview.current?.clear();
          const line = result.diagnostic.range?.start.line;
          setError(`${result.diagnostic.message}${line ? ` (line ${line})` : ""}`);
        }
      },
      (e) => current && setError(String(e)),
    );
    return () => {
      current = false;
    };
    // `ranges` is derived from the same texts as `text`.
  }, [text, path]);

  return (
    <div className="diff-side" aria-label={label}>
      {!text ? (
        <div className="empty center">{kind === "removed" ? "This page is new." : "This page was deleted."}</div>
      ) : (
        <>
          {error && <div className="git-note git-error" role="alert">{error}</div>}
          <Preview ref={preview} dark={dark} onRuntimeError={setError} />
        </>
      )}
    </div>
  );
}
