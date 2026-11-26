import { useEffect, useRef } from "react";

interface Props {
  tabs: string[];
  active: string | null;
  dirty: ReadonlySet<string>;
  onSelect(path: string): void;
  onClose(path: string): void;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Open-file tabs. Click to switch; × or middle-click to close. */
export function TabStrip({ tabs, active, dirty, onSelect, onClose }: Props) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs]);

  return (
    <div className="tabs" ref={strip} role="group" aria-label="Open files">
      {tabs.map((p) => {
        const name = baseName(p);
        // Two files with the same name also show their folder.
        const twin = tabs.some((other) => other !== p && baseName(other) === name);
        const folder = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
        return (
          <div
            key={p}
            className={`tab${p === active ? " active" : ""}${dirty.has(p) ? " dirty" : ""}`}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => e.button === 1 && onClose(p)}
          >
            <button type="button" className="tab-label" aria-current={p === active ? "true" : undefined} title={p} onClick={() => onSelect(p)}>
              {name}
              {twin && <span className="tab-folder">{folder}</span>}
            </button>
            <button type="button" className="tab-close" aria-label={`Close ${name}${dirty.has(p) ? " (unsaved changes)" : ""}`} onClick={() => onClose(p)}>
              {dirty.has(p) && <span className="dot" aria-hidden="true" />}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
