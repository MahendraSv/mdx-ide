import { convertFileSrc } from "@tauri-apps/api/core";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FromPreview, PreviewPage, SlideCommand, SlideState, ToPreview } from "./preview-protocol";

export interface PreviewHandle {
  render(page: PreviewPage, docPath: string): void;
  /** Slide decks: move between slides. */
  slide(command: SlideCommand): void;
  /** Give the preview the keyboard. */
  focus(): void;
  scrollToLine(line: number): void;
  /** `moved`: the person just put the cursor there. */
  setCursor(line: number, moved?: boolean): void;
  /** Rendered diff: mark changed blocks. */
  markChanges(kind: "added" | "removed", ranges: [number, number][]): void;
  clear(): void;
  /** A static copy of the page as it currently looks. */
  snapshot(): Promise<PreviewSnapshot>;
}

export interface PreviewSnapshot {
  body: string;
  styles: string;
  theme: string;
  /** A slide deck, printed one slide per page. */
  slides: boolean;
}

interface Props {
  dark: boolean;
  onRuntimeError(message: string | null): void;
  onSourceClick?(line: number): void;
  onLoadError?(message: string): void;
  onShortcut?(key: "escape" | "present"): void;
  /** The slide on screen; `null` when the page is not a deck. */
  onSlides?(state: SlideState | null): void;
  /** The preview fills the screen. */
  presenting?: boolean;
}

// Served by src-tauri/src/preview_protocol.rs on its own origin.
const PREVIEW_URL = convertFileSrc("", "mdxpreview");

export const Preview = forwardRef<PreviewHandle, Props>(function Preview({ dark, onRuntimeError, onSourceClick, onLoadError, onShortcut, onSlides, presenting = false }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const version = useRef(0);
  const pending = useRef<ToPreview | null>(null);
  const cursor = useRef(1);
  const changes = useRef<ToPreview | null>(null);
  const onError = useRef(onRuntimeError);
  onError.current = onRuntimeError;
  const onClick = useRef(onSourceClick);
  onClick.current = onSourceClick;
  const onLoad = useRef(onLoadError);
  onLoad.current = onLoadError;
  const shortcut = useRef(onShortcut);
  shortcut.current = onShortcut;
  const slides = useRef(onSlides);
  slides.current = onSlides;
  const snapshots = useRef(new Map<number, (s: PreviewSnapshot) => void>());
  const snapshotId = useRef(0);

  const send = (msg: ToPreview) => {
    // Sandboxed iframe → opaque origin → target "*" is the only option; we never send secrets.
    frame.current?.contentWindow?.postMessage(msg, "*");
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent<FromPreview>) => {
      if (e.source !== frame.current?.contentWindow) return;
      const msg = e.data;
      if (msg.type === "ready") {
        setReady(true);
        if (pending.current) send(pending.current);
        send({ type: "cursor", line: cursor.current, moved: false });
        if (changes.current) send(changes.current);
      } else if (msg.type === "load-error") {
        onLoad.current?.(msg.message);
      } else if (msg.type === "snapshot") {
        snapshots.current.get(msg.id)?.({ body: msg.body, styles: msg.styles, theme: msg.theme, slides: msg.slides });
      } else if (msg.type === "slides") {
        slides.current?.(msg.state);
      } else if (msg.type === "shortcut") {
        shortcut.current?.(msg.key);
      } else if (msg.type === "click") {
        onClick.current?.(msg.line);
      } else if (msg.type === "rendered" && msg.version === version.current) {
        onError.current(null);
      } else if (msg.type === "error" && msg.version === version.current) {
        onError.current(msg.message);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (ready) send({ type: "theme", dark });
  }, [ready, dark]);

  useEffect(() => {
    if (ready) send({ type: "present", on: presenting });
  }, [ready, presenting]);

  useImperativeHandle(ref, () => ({
    render(page, docPath) {
      const msg: ToPreview = { type: "render", version: ++version.current, code: page.code, docPath, slides: page.slides };
      pending.current = msg;
      if (ready) send(msg);
    },
    slide(command) {
      if (ready) send({ type: "slide", command });
    },
    focus() {
      frame.current?.focus();
      if (ready) send({ type: "focus" });
    },
    scrollToLine(line) {
      if (ready) send({ type: "scrollToLine", line });
    },
    setCursor(line, moved = false) {
      cursor.current = line;
      if (ready) send({ type: "cursor", line, moved });
    },
    markChanges(kind, ranges) {
      changes.current = { type: "changes", kind, ranges };
      if (ready) send(changes.current);
    },
    snapshot() {
      const id = ++snapshotId.current;
      return new Promise<PreviewSnapshot>((resolve, reject) => {
        // A component stuck in a loop would never answer.
        const timer = window.setTimeout(() => {
          snapshots.current.delete(id);
          reject(new Error("the preview did not respond"));
        }, 10_000);
        snapshots.current.set(id, (s) => {
          window.clearTimeout(timer);
          snapshots.current.delete(id);
          if (s.body) resolve(s);
          else reject(new Error("the preview has not finished showing the page. Try again in a moment"));
        });
        if (ready) send({ type: "snapshot", id });
        else reject(new Error("the preview is still loading"));
      });
    },
    clear() {
      pending.current = null;
      version.current++;
      if (ready) send({ type: "clear" });
    },
  }));

  return (
    <iframe
      ref={frame}
      className="preview-frame"
      title="Preview"
      src={PREVIEW_URL}
      // No allow-same-origin: the document's JS runs on an opaque origin with no access to the app or IPC.
      sandbox="allow-scripts"
    />
  );
});
