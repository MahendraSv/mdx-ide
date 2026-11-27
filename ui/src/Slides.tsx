import type { ComponentManifest, ComponentSpec } from "./api";
import type { SlideCommand, SlideState } from "./preview-protocol";

/** The component docs of a deck: the team's components plus the slide tags. */
export function withSlideTags(manifest: ComponentManifest | null | undefined, tags: ComponentSpec[]): ComponentManifest {
  const own = manifest?.components ?? [];
  // A team component of the same name wins, as it does in the preview.
  return { ...manifest, components: [...own, ...tags.filter((tag) => !own.some((c) => c.name === tag.name))] } as ComponentManifest;
}

/** The command for a presentation key pressed in the editor window. Mirrors `deck.tsx` in the
 *  preview, which handles the same keys when a slide has the keyboard. */
export function presentationKey(e: KeyboardEvent): SlideCommand | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  // Space presses a focused button.
  if (e.key === " " && e.target instanceof Element && e.target.closest("button")) return null;
  if (e.key === " ") return e.shiftKey ? "previous" : "next";
  const keys: Record<string, SlideCommand> = { ArrowRight: "next", ArrowLeft: "previous", PageDown: "next", PageUp: "previous", Home: "first", End: "last", g: "grid", G: "grid", r: "reset", R: "reset" };
  return keys[e.key] ?? null;
}

const Icon = ({ d }: { d: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export function SlideNav({ state, onCommand }: { state: SlideState; onCommand(command: SlideCommand): void }) {
  const button = (command: SlideCommand, label: string, d: string, props: { disabled?: boolean; pressed?: boolean } = {}) => (
    <button type="button" aria-label={label} title={label} disabled={props.disabled} aria-pressed={props.pressed} onClick={() => onCommand(command)}>
      <Icon d={d} />
    </button>
  );
  return (
    <div role="group" aria-label="Slides" className="device slide-nav">
      {button("previous", "Previous", "M15 6l-6 6 6 6", { disabled: !state.hasPrevious })}
      <span className="count" aria-live="polite">
        {state.index + 1} / {state.count}
      </span>
      {state.overflow.includes(state.index) && (
        <span className="slide-warning" role="img" aria-label="This slide's content does not fit" title="This slide's content does not fit">
          !
        </span>
      )}
      {button("next", "Next", "M9 6l6 6-6 6", { disabled: !state.hasNext })}
      {button("grid", "All slides (G)", "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z", { pressed: state.grid })}
      {button("reset", "Reset this slide (R)", "M3 12a9 9 0 1 0 3-6.7M3 4v4h4", { disabled: state.grid })}
    </div>
  );
}
