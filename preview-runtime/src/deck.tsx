// Slide decks. The compiler wraps each slide in `<section data-slide="n">`; here those sections
// are shown one at a time. Every slide stays mounted, so components keep their state while you
// move around. Each slide is laid out on a fixed canvas and scaled to fit, so it looks the same
// on a laptop and on a projector.

import { Component, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import type { SlideCommand, SlideState } from "./protocol";

// Keep in sync with `.mdx-ide-slide` in preview.css.
const WIDTH = 960;
const HEIGHT = 540;
/** Space around the slide while editing. A presentation uses the whole screen. */
const MARGIN = 16;

interface DeckStore {
  /** First source line of each slide; empty when the page is not a deck. */
  starts: number[];
  index: number;
  grid: boolean;
  presenting: boolean;
  /** How often each slide has been reset. */
  resets: Record<number, number>;
}

let store: DeckStore = { starts: [], index: 0, grid: false, presenting: false, resets: {} };
const failures = new Map<object, { slide: number; message: string }>();
const listeners = new Set<() => void>();
let report: (state: SlideState | null) => void = () => {};

function update(patch: Partial<DeckStore>) {
  store = { ...store, ...patch };
  listeners.forEach((listener) => listener());
  announce();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const useDeck = () => useSyncExternalStore(subscribe, () => store);

export function onDeckChange(handler: (state: SlideState | null) => void) {
  report = handler;
}

/** Tell the editor which slide is on screen. */
export function announce() {
  const count = store.starts.length;
  report(count ? { index: store.index, count, grid: store.grid, errors: [...failures.values()].sort((a, b) => a.slide - b.slide) } : null);
}

const clamp = (index: number, count: number) => Math.max(0, Math.min(index, count - 1));

/** The slide holding this source line. */
function slideAt(line: number, starts: number[]): number {
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1] <= line) index++;
  return index;
}

/** A deck is about to be rendered. While editing, it shows the slide under the cursor. */
export function openDeck(starts: number[], newDocument: boolean, cursorLine: number) {
  const index = !store.presenting && cursorLine > 0 ? slideAt(cursorLine, starts) : newDocument ? 0 : clamp(store.index, starts.length);
  update({ starts, index, grid: newDocument ? false : store.grid, resets: {} });
}

export function closeDeck() {
  failures.clear();
  update({ starts: [], index: 0, grid: false, resets: {} });
}

/** The editor cursor moved to another line. */
export function followCursor(line: number) {
  if (!store.starts.length || store.presenting) return;
  const index = slideAt(line, store.starts);
  if (index !== store.index) update({ index });
}

export function setPresenting(presenting: boolean) {
  update({ presenting, grid: false });
}

export function slideCommand(command: SlideCommand) {
  const count = store.starts.length;
  if (!count) return;
  const { index, grid, resets } = store;
  switch (command) {
    case "next":
      return update({ index: clamp(index + 1, count) });
    case "previous":
      return update({ index: clamp(index - 1, count) });
    case "first":
      return update({ index: 0 });
    case "last":
      return update({ index: count - 1 });
    case "grid":
      return update({ grid: !grid });
    case "close-grid":
      return update({ grid: false });
    case "reset":
      if (!grid) update({ resets: { ...resets, [index]: (resets[index] ?? 0) + 1 } });
  }
}

const KEYS: Record<string, SlideCommand> = {
  ArrowRight: "next",
  ArrowLeft: "previous",
  PageDown: "next",
  PageUp: "previous",
  " ": "next",
  Home: "first",
  End: "last",
  g: "grid",
  G: "grid",
  r: "reset",
  R: "reset",
};

const FIELDS = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
/** Widgets that move around with the arrow keys. */
const ARROW_WIDGETS = ["tab", "tablist", "slider", "spinbutton", "listbox", "menu", "menubar", "radiogroup", "grid", "tree", "combobox"]
  .map((role) => `[role='${role}']`)
  .concat("audio", "video")
  .join(", ");
const PRESSABLE = "button, a[href], summary, audio, video, [role='button'], [role='switch'], [role='checkbox']";

/** Presentation keys. Returns whether the key was used; otherwise it belongs to a component. */
export function deckKey(e: KeyboardEvent): boolean {
  if (!store.starts.length || e.metaKey || e.ctrlKey || e.altKey) return false;
  const target = e.target instanceof Element ? e.target : null;
  const field = target?.closest<HTMLElement>(FIELDS);
  if (e.key === "Escape") {
    if (store.grid) slideCommand("close-grid");
    // The first Escape leaves a field, so that the arrow keys change slides again.
    else if (field) field.blur();
    else return false;
    return true;
  }
  const command = e.key === " " && e.shiftKey ? "previous" : KEYS[e.key];
  if (!command) return false;
  // Presentation clickers send Page Up / Down: those still work after using a one-line field.
  const page = e.key === "PageUp" || e.key === "PageDown";
  if (field && !(page && field.matches("input:not([type='range'])"))) return false;
  if (/^(Arrow|Home|End)/.test(e.key) && target?.closest(ARROW_WIDGETS)) return false;
  if (e.key === " " && target?.closest(PRESSABLE)) return false;
  slideCommand(command);
  return true;
}

interface BoundaryProps {
  slide: number;
  children: ReactNode;
}

/** A component that fails takes down its own slide, not the presentation. */
class SlideBoundary extends Component<BoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    failures.set(this, { slide: this.props.slide, message: error.message });
    announce();
  }
  componentWillUnmount() {
    if (failures.delete(this)) announce();
  }
  render() {
    if (this.state.error) {
      return (
        <div className="mdx-ide-error">
          <strong>Slide {this.props.slide + 1} could not be shown</strong>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function Slide({ index, children }: { index: number; children: ReactNode }) {
  const { index: current, grid, resets } = useDeck();
  const active = index === current;
  const pick = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!grid || !active) return;
    pick.current?.focus({ preventScroll: true });
    pick.current?.scrollIntoView({ block: "nearest" });
  }, [grid, active]);
  return (
    <div className="mdx-ide-frame" data-current={active || undefined}>
      <section className="mdx-ide-doc mdx-ide-slide" aria-label={`Slide ${index + 1}`} inert={grid || !active}>
        <SlideBoundary key={resets[index] ?? 0} slide={index}>
          <div className="mdx-ide-slide-body">{children}</div>
        </SlideBoundary>
      </section>
      {grid && (
        <button ref={pick} type="button" className="mdx-ide-pick" aria-label={`Show slide ${index + 1}`} aria-current={active || undefined} onClick={() => update({ index, grid: false })}>
          <span>{index + 1}</span>
        </button>
      )}
    </div>
  );
}

/** Replaces the compiler's slide sections; other sections (e.g. footnotes) are left as they are. */
export const deckComponents = {
  section: (props: ComponentProps<"section"> & { "data-slide"?: string }) =>
    props["data-slide"] === undefined ? <section {...props} /> : <Slide index={Number(props["data-slide"])}>{props.children}</Slide>,
};

export function DeckView({ children }: { children: ReactNode }) {
  const { grid, presenting } = useDeck();
  const root = document.documentElement;

  useLayoutEffect(() => {
    root.toggleAttribute("data-deck", true);
    return () => {
      for (const name of ["data-deck", "data-grid", "data-presenting"]) root.removeAttribute(name);
    };
  }, []);
  useLayoutEffect(() => {
    root.toggleAttribute("data-grid", grid);
    root.toggleAttribute("data-presenting", presenting);
    if (!grid) window.scrollTo(0, 0);
    const fit = () => {
      const margin = presenting ? 0 : MARGIN;
      const scale = Math.min((window.innerWidth - 2 * margin) / WIDTH, (window.innerHeight - 2 * margin) / HEIGHT);
      // A hidden preview measures zero; it is measured again when shown.
      root.style.setProperty("--slide-scale", String(Math.max(scale, 0.05)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [grid, presenting]);

  return <div className="mdx-ide-deck">{children}</div>;
}
