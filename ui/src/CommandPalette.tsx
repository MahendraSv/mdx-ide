import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "./api";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run(): void;
}

interface Props {
  files: FileEntry[];
  commands: PaletteCommand[];
  /** "files" (⌘P) lists only files; "all" (⌘K) lists commands and files. */
  mode: "files" | "all";
  onOpenFile(path: string): void;
  onClose(): void;
  /** Overrides for reusing the palette as a picker. */
  placeholder?: string;
  badge?: string;
}

/** Subsequence fuzzy match; lower score is better, null = no match. */
export function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let ti = 0;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += last >= 0 ? i - last - 1 : i; // gaps cost
    last = i;
    ti = i + 1;
  }
  // Prefer matches in the file name over the directory.
  const base = t.lastIndexOf("/") + 1;
  return score + (t.indexOf(q[0], base) >= 0 ? 0 : 5) + t.length * 0.01;
}

type Item = { key: string; label: string; hint?: string; kind: "command" | "file"; run(): void };

export function CommandPalette({ files, commands, mode, onOpenFile, onClose, placeholder, badge }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const prev = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    input.current?.focus();
    const opener = prev.current as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);

  const items = useMemo<Item[]>(() => {
    const out: { item: Item; score: number }[] = [];
    if (mode === "all") {
      for (const c of commands) {
        const s = fuzzy(query, c.label);
        if (s !== null) out.push({ score: s - 1, item: { key: c.id, label: c.label, hint: c.hint, kind: "command", run: c.run } });
      }
    }
    for (const f of files) {
      const s = fuzzy(query, f.path);
      if (s !== null) {
        const i = f.path.lastIndexOf("/");
        out.push({ score: s, item: { key: f.path, label: f.path.slice(i + 1), hint: i >= 0 ? f.path.slice(0, i + 1) : "", kind: "file", run: () => onOpenFile(f.path) } });
      }
    }
    return out.sort((a, b) => a.score - b.score).slice(0, 50).map((x) => x.item);
  }, [query, files, commands, mode, onOpenFile]);

  useEffect(() => setIndex(0), [query]);

  const choose = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    it.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[index]);
    } else if (e.key === "Tab") {
      // Focus trap: the input is the only tabbable element.
      e.preventDefault();
      input.current?.focus();
    }
  };

  useEffect(() => {
    dialog.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette-modal" role="dialog" aria-modal="true" aria-label="Command palette" ref={dialog} onKeyDown={onKeyDown}>
        <input
          ref={input}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[index] ? `pal-${index}` : undefined}
          placeholder={placeholder ?? (mode === "files" ? "Go to file…" : "Search files, run commands…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="palette-results" id="palette-list" role="listbox">
          {items.map((it, i) => (
            <li key={it.key} id={`pal-${i}`} data-i={i} role="option" aria-selected={i === index} className={i === index ? "sel" : ""} onMouseMove={() => setIndex(i)} onClick={() => choose(it)}>
              <span className={`badge-ext ${it.kind === "file" ? "mdx" : ""}`}>{it.kind === "file" ? "MDX" : (badge ?? "CMD")}</span>
              <span className="pal-label">{it.label}</span>
              {it.hint && <span className="pal-hint">{it.hint}</span>}
            </li>
          ))}
          {items.length === 0 && <li className="empty" role="presentation">No results</li>}
        </ul>
        <div className="palette-foot">
          <kbd>↑↓</kbd> navigate <kbd>↵</kbd> open <kbd>Esc</kbd> close
        </div>
      </div>
    </div>
  );
}
