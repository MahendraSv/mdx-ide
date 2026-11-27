// Slide decks. The compiler wraps each slide in `<section data-slide="n">`; here those sections
// are shown one at a time. Every slide stays mounted, so components keep their state while you
// move around. Each slide is laid out on a fixed canvas and scaled to fit, so it looks the same
// on a laptop and on a projector.
//
// The tags authors can use on slides (`<Columns>`, `<Step>`, `<Notes>`) are defined here too.
// `mdx-intel/src/slides.rs` describes them to the editor. `<Slide layout>` is handled by the
// compiler.

import { Component, createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SlideCommand, SlideState } from "./protocol";

// Keep in sync with `.mdx-ide-slide` in preview.css.
const WIDTH = 960;
const HEIGHT = 540;
/** Space around the slide while editing. A presentation uses the whole screen. */
const MARGIN = 16;
const NOTES_HEIGHT = 130;
/** Every step of a slide is shown. */
const ALL = Number.MAX_SAFE_INTEGER;

interface DeckStore {
  /** First source line of each slide; empty when the page is not a deck. */
  starts: number[];
  index: number;
  grid: boolean;
  presenting: boolean;
  /** How often each slide has been reset. */
  resets: Record<number, number>;
  /** Steps revealed on each slide while presenting. */
  revealed: Record<number, number>;
  /** The slide of each `<Notes>` on the page. */
  notes: ReadonlyMap<string, number>;
}

let store: DeckStore = { starts: [], index: 0, grid: false, presenting: false, resets: {}, revealed: {}, notes: new Map() };
const failures = new Map<object, { slide: number; message: string }>();
const stepCounts = new Map<number, number>();
/** Slides whose content does not fit. */
const overflowing = new Set<number>();
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

/** Steps are revealed one at a time only in a presentation; otherwise the whole slide shows. */
const stepping = () => store.presenting && !store.grid;

function stepsOfCurrentSlide() {
  const total = stepCounts.get(store.index) ?? 0;
  return { total, shown: stepping() ? Math.min(store.revealed[store.index] ?? 0, total) : total };
}

/** Tell the editor which slide is on screen. */
export function announce() {
  const { starts, index, grid } = store;
  const count = starts.length;
  if (!count) return report(null);
  const { total, shown } = stepsOfCurrentSlide();
  report({
    index,
    count,
    grid,
    errors: [...failures.values()].sort((a, b) => a.slide - b.slide),
    overflow: [...overflowing].filter((slide) => slide < count).sort((a, b) => a - b),
    hasPrevious: index > 0 || (stepping() && shown > 0),
    hasNext: index < count - 1 || (stepping() && shown < total),
  });
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
  update({ starts, index, grid: newDocument ? false : store.grid, resets: {}, revealed: {} });
}

export function closeDeck() {
  failures.clear();
  stepCounts.clear();
  overflowing.clear();
  update({ starts: [], index: 0, grid: false, resets: {}, revealed: {} });
}

/** The editor cursor moved to another line. */
export function followCursor(line: number) {
  if (!store.starts.length || store.presenting) return;
  const index = slideAt(line, store.starts);
  if (index !== store.index) update({ index });
}

export function setPresenting(presenting: boolean) {
  // A presentation starts with the steps of this slide and the following ones still to come.
  const revealed = presenting ? Object.fromEntries(Object.entries(store.revealed).filter(([slide]) => Number(slide) < store.index)) : store.revealed;
  update({ presenting, grid: false, revealed });
}

export function slideCommand(command: SlideCommand) {
  const count = store.starts.length;
  if (!count) return;
  const { index, grid, resets, revealed } = store;
  const { total, shown } = stepsOfCurrentSlide();
  const reveal = (slide: number, steps: number) => ({ ...revealed, [slide]: steps });
  switch (command) {
    case "next":
      if (stepping() && shown < total) return update({ revealed: reveal(index, shown + 1) });
      return update({ index: clamp(index + 1, count) });
    case "previous":
      if (stepping() && shown > 0) return update({ revealed: reveal(index, shown - 1) });
      if (index === 0) return;
      // Going back shows the earlier slide as it was left: complete.
      return update({ index: index - 1, revealed: stepping() ? reveal(index - 1, ALL) : revealed });
    case "first":
      return update({ index: 0 });
    case "last":
      return update({ index: count - 1 });
    case "grid":
      return update({ grid: !grid });
    case "close-grid":
      return update({ grid: false });
    case "reset":
      if (!grid) update({ resets: { ...resets, [index]: (resets[index] ?? 0) + 1 }, revealed: reveal(index, 0) });
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

function setStepCount(slide: number, count: number) {
  if (stepCounts.get(slide) === count) return;
  stepCounts.set(slide, count);
  announce();
}

function setOverflow(slide: number, overflows: boolean) {
  if (overflowing.has(slide) === overflows) return;
  if (overflows) overflowing.add(slide);
  else overflowing.delete(slide);
  announce();
}

const SlideContext = createContext<{ index: number; notesHost: HTMLElement | null } | null>(null);

function Slide({ index, layout, children }: { index: number; layout?: string; children: ReactNode }) {
  const { index: current, grid, presenting, resets, revealed } = useDeck();
  const active = index === current;
  const reset = resets[index] ?? 0;
  const shown = presenting && !grid ? (revealed[index] ?? 0) : ALL;
  const section = useRef<HTMLElement>(null);
  const pick = useRef<HTMLButtonElement>(null);
  const [notesHost, setNotesHost] = useState<HTMLElement | null>(null);
  const context = useMemo(() => ({ index, notesHost }), [index, notesHost]);

  // Hide the steps still to come, including any a component adds later.
  useLayoutEffect(() => {
    const slide = section.current!;
    const apply = () => {
      const steps = slide.querySelectorAll<HTMLElement>(".mdx-ide-step");
      steps.forEach((step, i) => {
        step.toggleAttribute("data-pending", i >= shown);
        step.inert = i >= shown;
      });
      setStepCount(index, steps.length);
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(slide, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [index, shown]);

  // Report content that does not fit, as it changes size (a section opening, an image loading).
  useEffect(() => {
    const slide = section.current!;
    const measure = () => setOverflow(index, slide.scrollHeight > slide.clientHeight + 1 || slide.scrollWidth > slide.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    if (slide.firstElementChild) observer.observe(slide.firstElementChild);
    return () => {
      observer.disconnect();
      setOverflow(index, false);
    };
  }, [index, reset]);

  useEffect(() => {
    if (!grid || !active) return;
    pick.current?.focus({ preventScroll: true });
    pick.current?.scrollIntoView({ block: "nearest" });
  }, [grid, active]);

  return (
    <div className="mdx-ide-frame" data-current={active || undefined}>
      <section ref={section} className="mdx-ide-doc mdx-ide-slide" data-layout={layout} aria-label={`Slide ${index + 1}`} inert={grid || !active}>
        <SlideContext.Provider value={context}>
          <SlideBoundary key={reset} slide={index}>
            <div className="mdx-ide-slide-body">{children}</div>
          </SlideBoundary>
        </SlideContext.Provider>
      </section>
      {/* Speaker notes appear here, below the slide, while editing. */}
      {!presenting && <div ref={setNotesHost} className="mdx-ide-notes" aria-label="Speaker notes" />}
      {grid && (
        <button ref={pick} type="button" className="mdx-ide-pick" aria-label={`Show slide ${index + 1}`} aria-current={active || undefined} onClick={() => update({ index, grid: false })}>
          <span>{index + 1}</span>
        </button>
      )}
    </div>
  );
}

function Notes({ children }: { children?: ReactNode }) {
  const slide = useContext(SlideContext);
  const id = useId();
  const index = slide?.index;
  useEffect(() => {
    if (index === undefined) return;
    update({ notes: new Map(store.notes).set(id, index) });
    return () => {
      const notes = new Map(store.notes);
      notes.delete(id);
      update({ notes });
    };
  }, [id, index]);
  // Outside a deck (e.g. the rendered Git diff) notes are part of the page.
  if (!slide) {
    return (
      <aside className="mdx-ide-page-notes">
        <strong>Speaker notes</strong>
        {children}
      </aside>
    );
  }
  return slide.notesHost ? createPortal(children, slide.notesHost) : null;
}

/** Tags available on slides. Team components with the same names take their place. */
export const slideComponents = {
  // The compiler takes `<Slide>` out of the slide it configures; this covers one nested deeper.
  Slide: ({ children }: { layout?: string; children?: ReactNode }) => <>{children}</>,
  Columns: ({ children }: { children?: ReactNode }) => <div className="mdx-ide-columns">{children}</div>,
  Column: ({ children }: { children?: ReactNode }) => <div className="mdx-ide-column">{children}</div>,
  Step: ({ children }: { children?: ReactNode }) => <div className="mdx-ide-step">{children}</div>,
  Notes,
};

/** Replaces the compiler's slide sections; other sections (e.g. footnotes) are left as they are. */
export const deckComponents = {
  section: (props: ComponentProps<"section"> & { "data-slide"?: string; "data-layout"?: string }) =>
    props["data-slide"] === undefined ? (
      <section {...props} />
    ) : (
      <Slide index={Number(props["data-slide"])} layout={props["data-layout"]}>
        {props.children}
      </Slide>
    ),
};

export function DeckView({ children }: { children: ReactNode }) {
  const { grid, presenting, index, notes } = useDeck();
  const hasNotes = !grid && !presenting && [...notes.values()].includes(index);
  const root = document.documentElement;

  useLayoutEffect(() => {
    root.toggleAttribute("data-deck", true);
    return () => {
      for (const name of ["data-deck", "data-grid", "data-presenting", "data-notes"]) root.removeAttribute(name);
    };
  }, []);
  useLayoutEffect(() => {
    root.toggleAttribute("data-grid", grid);
    root.toggleAttribute("data-presenting", presenting);
    root.toggleAttribute("data-notes", hasNotes);
    if (!grid) window.scrollTo(0, 0);
    const fit = () => {
      const margin = presenting ? 0 : MARGIN;
      const notesHeight = hasNotes ? Math.min(NOTES_HEIGHT, Math.round(window.innerHeight * 0.3)) : 0;
      root.style.setProperty("--notes-height", `${notesHeight}px`);
      const scale = Math.min((window.innerWidth - 2 * margin) / WIDTH, (window.innerHeight - notesHeight - 2 * margin) / HEIGHT);
      // A hidden preview measures zero; it is measured again when shown.
      root.style.setProperty("--slide-scale", String(Math.max(scale, 0.05)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [grid, presenting, hasNotes]);

  return <div className="mdx-ide-deck">{children}</div>;
}
