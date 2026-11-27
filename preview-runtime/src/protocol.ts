// Messages exchanged between the editor window and the preview iframe via
// postMessage. Keep in sync with ui/src/preview-protocol.ts.

/** What the compiler reports about a slide deck (`mdx_compile::Deck`). */
export interface Deck {
  /** The source line each slide starts on; one entry per slide. */
  starts: number[];
  /** Component names used in the page. */
  components: string[];
}

/** A compiled page, ready to render. */
export interface PreviewPage {
  code: string;
  slides: Deck | null;
}

export type SlideCommand = "next" | "previous" | "first" | "last" | "grid" | "close-grid" | "reset";

export interface SlideState {
  /** The slide on screen, from 0. */
  index: number;
  count: number;
  /** The overview of all slides is open. */
  grid: boolean;
  /** Slides that could not be shown. */
  errors: { slide: number; message: string }[];
}

export type ToPreview =
  /** `slides` is set when the module is a slide deck. */
  | { type: "render"; version: number; code: string; docPath: string; slides: Deck | null }
  /** Slide decks: move between slides. */
  | { type: "slide"; command: SlideCommand }
  /** The preview now fills the screen (or no longer does). */
  | { type: "present"; on: boolean }
  /** Take the keyboard, so presentation keys reach the slides. */
  | { type: "focus" }
  | { type: "scrollToLine"; line: number }
  /** Outline the component under the editor cursor. `moved`: the person just put the cursor
   *  there, so a slide deck shows that slide. */
  | { type: "cursor"; line: number; moved: boolean }
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
  /** `null` when the page shown is not a deck. */
  | { type: "slides"; state: SlideState | null }
  | { type: "error"; version: number; message: string; stack?: string };
