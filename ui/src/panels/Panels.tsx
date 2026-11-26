import { useState } from "react";
import { api, type ComponentManifest, type Diagnostic, type OutlineItem, type SearchHit } from "../api";

export function Outline({ items, onGoto }: { items: OutlineItem[]; onGoto(line: number): void }) {
  return (
    <div className="tree-list">
      {items.map((o, i) => (
        <button type="button" key={i} className="tree" style={{ paddingLeft: 10 + (o.depth - 1) * 12 }} onClick={() => o.range && onGoto(o.range.start.line)} title={`#${o.slug}`}>
          <span className="tag">H{o.depth}</span>
          <span className="name">{o.text || <em>(empty heading)</em>}</span>
        </button>
      ))}
      {items.length === 0 && <div className="empty">No headings</div>}
    </div>
  );
}

export function Search({ onOpen }: { onOpen(path: string, line: number, column: number): void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    try {
      setError(null);
      setHits(await api.search(query));
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="panel">
      <input
        className="panel-filter"
        placeholder="Search in .mdx files (Enter)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && run()}
      />
      {error && <div className="empty">{error}</div>}
      <ul className="list">
        {hits.map((h, i) => (
          <li key={i} onClick={() => onOpen(h.path, h.line, h.column)}>
            <div className="dir">
              {h.path}:{h.line}
            </div>
            <div className="hit">{h.preview}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Component palette: browse the team manifest and insert snippets. */
export function Palette({ manifest, onInsert }: { manifest: ComponentManifest | null; onInsert(snippet: string): void }) {
  if (!manifest?.components.length) {
    return <div className="empty">No component manifest. Add <code>.mdx-ide/component-manifest.json</code> (see README).</div>;
  }
  const groups = new Map<string, typeof manifest.components>();
  for (const c of manifest.components) {
    const g = c.category ?? "Components";
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  return (
    <div className="panel palette">
      {[...groups].map(([group, comps]) => (
        <section key={group}>
          <h4>{group}</h4>
          {comps.map((c) => (
            <button key={c.name} className="palette-item" title={c.description} onClick={() => onInsert(snippetFor(c))}>
              <strong>&lt;{c.name}&gt;</strong>
              <span>{c.description}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

function snippetFor(c: ComponentManifest["components"][number]): string {
  if (c.snippet) return `<${c.snippet}`;
  const req = c.props
    .filter((p) => p.required && p.name !== "children")
    .map((p, i) => ` ${p.name}="\${${i + 1}:${p.values[0] ?? ""}}"`)
    .join("");
  return c.acceptsChildren ? `<${c.name}${req}>\n  \${}\n</${c.name}>` : `<${c.name}${req} />`;
}

export function Problems({ diagnostics, runtimeError, note, onGoto }: { diagnostics: Diagnostic[]; runtimeError: string | null; note?: string | null; onGoto(line: number, column: number): void }) {
  return (
    <ul className="list problems">
      {runtimeError && (
        <li className="sev-error">
          <span className="badge">preview</span> {runtimeError}
        </li>
      )}
      {note && <li className="empty">{note}</li>}
      {diagnostics.map((d, i) => (
        <li key={i} className={`sev-${d.severity}`} title={`${d.source} · ${d.rule}`} onClick={() => d.range && onGoto(d.range.start.line, d.range.start.column)}>
          <span className="badge">{d.source === "mdxlint" ? d.rule : d.source}</span> {d.message}
          {d.range && <span className="dir"> — line {d.range.start.line}</span>}
        </li>
      ))}
      {diagnostics.length === 0 && !runtimeError && <li className="empty">No problems</li>}
    </ul>
  );
}
