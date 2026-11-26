// Messages exchanged between the editor window and the preview iframe via
// postMessage. Keep in sync with preview-runtime/src/protocol.ts.

export type ToPreview =
  | { type: "render"; version: number; code: string; docPath: string }
  | { type: "scrollToLine"; line: number }
  /** Outline the component under the editor cursor. */
  | { type: "cursor"; line: number }
  /** Empty the document (switching to a file that has not rendered yet). */
  | { type: "clear" }
  | { type: "theme"; dark: boolean };

export type FromPreview =
  | { type: "ready" }
  | { type: "click"; line: number }
  /** The team component bundle could not be loaded. */
  | { type: "load-error"; message: string }
  | { type: "rendered"; version: number }
  | { type: "error"; version: number; message: string; stack?: string };
