// Messages exchanged between the editor window and the preview iframe via
// postMessage. Keep in sync with preview-runtime/src/protocol.ts.

export type ToPreview =
  | { type: "render"; version: number; code: string; docPath: string }
  | { type: "scrollToLine"; line: number }
  /** Outline the component under the editor cursor. */
  | { type: "cursor"; line: number }
  /** Rendered diff: mark the blocks overlapping these source line ranges. */
  | { type: "changes"; kind: "added" | "removed"; ranges: [number, number][] }
  /** Ask for a static copy of the page as it currently looks (PDF export). */
  | { type: "snapshot"; id: number }
  /** Empty the document (switching to a file that has not rendered yet). */
  | { type: "clear" }
  | { type: "theme"; dark: boolean };

export type FromPreview =
  | { type: "ready" }
  | { type: "click"; line: number }
  | { type: "snapshot"; id: number; body: string; styles: string; theme: string }
  /** A window shortcut pressed while the preview has the keyboard. */
  | { type: "shortcut"; key: "escape" | "present" }
  /** The team component bundle could not be loaded. */
  | { type: "load-error"; message: string }
  | { type: "rendered"; version: number }
  | { type: "error"; version: number; message: string; stack?: string };
