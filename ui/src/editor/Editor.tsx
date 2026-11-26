import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, snippet } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type StateEffect } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { ComponentManifest, Diagnostic } from "../api";
import { mdxCompletionSource } from "./completion";
import { mdxHover } from "./hover";
import { mdxLanguage } from "./mdx-language";
import { clipboardToMarkdown } from "./paste-markdown";
import { byteOffsetToPos } from "./positions";

// Syntax colours come from the design tokens, so they follow the theme.
const mdxHighlight = HighlightStyle.define([
  { tag: [t.heading, t.strong], color: "var(--text0)", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "var(--synKw)" },
  { tag: [t.string, t.special(t.string), t.monospace], color: "var(--synStr)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--synTag)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--synAttr)" },
  { tag: [t.definition(t.propertyName), t.labelName], color: "var(--synKey)" },
  { tag: [t.comment, t.meta, t.processingInstruction, t.contentSeparator], color: "var(--dim)" },
  { tag: t.link, color: "var(--synTag)", textDecoration: "underline" },
  { tag: t.url, color: "var(--synTag)" },
  { tag: [t.number, t.bool, t.null], color: "var(--synAttr)" },
]);

export interface EditorHandle {
  gotoLine(line: number, column?: number): void;
  insertSnippet(template: string): void;
  focus(): void;
  /** Replace (or create) the frontmatter block with `raw` (no fences). */
  setFrontmatter(raw: string): void;
  /** Replace the whole document with a minimal diff, so the cursor and scroll position survive. */
  replaceAll(text: string): void;
  /** Change the text of any open document, shown or cached, keeping its history. */
  replaceIn(docKey: string, text: string): void;
  /** Drop the cached state (undo history, cursor, scroll) of a closed document. */
  forget(docKey: string): void;
}

interface Props {
  /** Identifies the document. Each key keeps its own history, cursor and scroll position;
   *  a new key starts from `initialText`. */
  docKey: string;
  initialText: string;
  diagnostics: Diagnostic[];
  manifest?: ComponentManifest | null;
  onChange(text: string): void;
  onSave(): void;
  onTopLineChange?(line: number): void;
  onCursor?(line: number, column: number): void;
  /** Persist an image and return the path to insert; the editor inserts `![alt](path)`. */
  onImage?(file: File): Promise<string>;
  onImageError?(message: string): void;
}

/** The smallest single change that turns `old` into `text`, so cursor and history stay put. */
function minimalChange(old: string, text: string) {
  let a = 0;
  while (a < old.length && a < text.length && old[a] === text[a]) a++;
  let b = 0;
  while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
  return { from: a, to: old.length - b, insert: text.slice(a, text.length - b) };
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const plainPaste = useRef(false);
  const currentKey = useRef<string | null>(null);
  const cache = useRef(new Map<string, { state: EditorState; scroll: StateEffect<unknown> }>());
  const cb = useRef(props);
  cb.current = props;

  /** Paste / drop of image files: copy into the assets folder, then insert Markdown. */
  const handleImages = (files: FileList | undefined | null, e: Event, v: EditorView, at: number) => {
    const images = Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!images.length || !cb.current.onImage) return false;
    e.preventDefault();
    const target = currentKey.current;
    void (async () => {
      let pos = at;
      for (const f of images) {
        // Saving is async: never insert into a different file if the user switched tabs.
        if (currentKey.current !== target) break;
        try {
          const path = await cb.current.onImage!(f);
          if (currentKey.current !== target) {
            cb.current.onImageError?.(`Image saved as ${path}, but not inserted because you switched files.`);
            break;
          }
          const alt = f.name.replace(/\.[^.]+$/, "").replace(/[\[\]]/g, "") || "image";
          const text = `![${alt}](${path.includes(" ") ? `<${path}>` : path})\n`;
          pos = Math.min(pos, v.state.doc.length);
          v.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
          pos += text.length;
        } catch (err) {
          cb.current.onImageError?.(String(err));
        }
      }
    })();
    return true;
  };

  // Swap editor states when the active document changes.
  useEffect(() => {
    const v = view.current;
    if (v && currentKey.current && currentKey.current !== props.docKey) {
      cache.current.set(currentKey.current, { state: v.state, scroll: v.scrollSnapshot() });
    }
    currentKey.current = props.docKey;
    const cached = cache.current.get(props.docKey);
    const state = cached?.state ?? EditorState.create({
      doc: props.initialText,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        lintGutter(),
        history(),
        drawSelection(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(mdxHighlight),
        mdxLanguage(),
        mdxHover(() => cb.current.manifest ?? null),
        autocompletion({ override: [mdxCompletionSource], activateOnTyping: true }),
        EditorView.lineWrapping,
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...lintKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) {
            const head = u.state.selection.main.head;
            const l = u.state.doc.lineAt(head);
            cb.current.onCursor?.(l.number, head - l.from + 1);
          }
        }),
        EditorView.domEventHandlers({
          keydown: (e) => {
            // ⌘⇧V / Ctrl+Shift+V pastes as plain text.
            plainPaste.current = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "v";
            return false;
          },
          paste: (e, v) => {
            if (handleImages(e.clipboardData?.files, e, v, v.state.selection.main.head)) return true;
            if (plainPaste.current) {
              plainPaste.current = false;
              return false;
            }
            const md = clipboardToMarkdown(e.clipboardData);
            if (md === null) return false;
            e.preventDefault();
            v.dispatch(v.state.replaceSelection(md), { scrollIntoView: true, userEvent: "input.paste" });
            return true;
          },
          drop: (e, v) => handleImages(e.dataTransfer?.files, e, v, v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head),
          scroll: (_e, v) => {
            const top = v.lineBlockAtHeight(v.scrollDOM.scrollTop);
            cb.current.onTopLineChange?.(v.state.doc.lineAt(top.from).number);
          },
        }),
      ],
    });
    if (view.current) {
      view.current.setState(state);
    } else {
      view.current = new EditorView({ state, parent: host.current! });
    }
    if (cached) view.current.dispatch({ effects: cached.scroll });
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    cb.current.onCursor?.(line.number, head - line.from + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey]);

  useEffect(
    () => () => {
      view.current?.destroy();
      view.current = null;
    },
    [],
  );

  // Push diagnostics from Rust into the lint layer.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const cm: CmDiagnostic[] = props.diagnostics.map((d) => {
      let from = 0;
      let to = 0;
      if (d.range) {
        from = byteOffsetToPos(doc, d.range.start.offset);
        to = Math.max(from, byteOffsetToPos(doc, d.range.end.offset));
      }
      if (to === from) to = Math.min(doc.length, doc.lineAt(from).to);
      return { from, to, severity: d.severity, message: d.message, source: `${d.source} · ${d.rule}` };
    });
    v.dispatch(setDiagnostics(v.state, cm));
  }, [props.diagnostics]);

  useImperativeHandle(ref, () => ({
    gotoLine(line, column = 1) {
      const v = view.current;
      if (!v) return;
      const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
      const pos = Math.min(l.to, l.from + column - 1);
      v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      v.focus();
    },
    insertSnippet(template) {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      snippet(template)(v, null, from, to);
      v.focus();
    },
    focus: () => view.current?.focus(),
    forget(docKey) {
      cache.current.delete(docKey);
      if (currentKey.current === docKey) currentKey.current = null;
    },
    replaceAll(text) {
      const v = view.current;
      if (!v) return;
      const old = v.state.doc.toString();
      if (old !== text) v.dispatch({ changes: minimalChange(old, text) });
    },
    replaceIn(docKey, text) {
      const v = view.current;
      const cached = cache.current.get(docKey);
      const state = docKey === currentKey.current ? v?.state : cached?.state;
      if (!state || state.doc.toString() === text) return;
      const changes = minimalChange(state.doc.toString(), text);
      if (docKey === currentKey.current) v!.dispatch({ changes });
      else cache.current.set(docKey, { ...cached!, state: state.update({ changes }).state });
    },
    setFrontmatter(raw) {
      const v = view.current;
      if (!v) return;
      const m = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(v.state.doc.toString());
      const block = raw.trim() ? `---\n${raw.replace(/\s+$/, "")}\n---\n` : "";
      v.dispatch(m ? { changes: { from: 0, to: m[0].length, insert: block } } : { changes: { from: 0, insert: block ? `${block}\n` : "" } });
    },
  }));

  return <div className="editor" ref={host} />;
});
