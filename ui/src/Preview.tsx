import { convertFileSrc } from "@tauri-apps/api/core";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FromPreview, ToPreview } from "./preview-protocol";

export interface PreviewHandle {
  render(code: string, docPath: string): void;
  scrollToLine(line: number): void;
  setCursor(line: number): void;
  /** Rendered diff: mark changed blocks. */
  markChanges(kind: "added" | "removed", ranges: [number, number][]): void;
  clear(): void;
}

interface Props {
  dark: boolean;
  onRuntimeError(message: string | null): void;
  onSourceClick?(line: number): void;
  onLoadError?(message: string): void;
}

// Served by src-tauri/src/preview_protocol.rs on its own origin.
const PREVIEW_URL = convertFileSrc("", "mdxpreview");

export const Preview = forwardRef<PreviewHandle, Props>(function Preview({ dark, onRuntimeError, onSourceClick, onLoadError }, ref) {
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
        send({ type: "cursor", line: cursor.current });
        if (changes.current) send(changes.current);
      } else if (msg.type === "load-error") {
        onLoad.current?.(msg.message);
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

  useImperativeHandle(ref, () => ({
    render(code, docPath) {
      const msg: ToPreview = { type: "render", version: ++version.current, code, docPath };
      pending.current = msg;
      if (ready) send(msg);
    },
    scrollToLine(line) {
      if (ready) send({ type: "scrollToLine", line });
    },
    setCursor(line) {
      cursor.current = line;
      if (ready) send({ type: "cursor", line });
    },
    markChanges(kind, ranges) {
      changes.current = { type: "changes", kind, ranges };
      if (ready) send(changes.current);
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
