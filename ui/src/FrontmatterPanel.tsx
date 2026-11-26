import { useEffect, useRef, useState } from "react";
import YAML from "yaml";
import type { Diagnostic } from "./api";

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  title?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
};

interface Props {
  schema: Schema | null;
  /** Raw frontmatter text (without the `---` fences); "" when the document has none. */
  raw: string;
  diagnostics: Diagnostic[];
  onChange(raw: string): void;
  onClose(): void;
}

const typeOf = (s: Schema) => (Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type);

/** Frontmatter editor generated from the team's JSON Schema, with a raw YAML toggle. */
export function FrontmatterPanel({ schema, raw, diagnostics, onChange, onClose }: Props) {
  // The schema arrives after the first analysis, so default to the form and fall back below.
  const [mode, setMode] = useState<"form" | "yaml">("form");
  const effective = schema ? mode : "yaml";

  const doc = YAML.parseDocument(raw || "");
  const parseError = doc.errors[0]?.message;
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  const errors = diagnostics.filter((d) => d.source === "frontmatter");

  const set = (key: string, value: unknown) => {
    // Edit the parsed document in place so comments and key order survive.
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) doc.delete(key);
    else doc.set(key, value);
    // An empty map serialises as `{}`; drop the block instead.
    onChange(Object.keys((doc.toJS() ?? {}) as object).length ? doc.toString().trimEnd() : "");
  };

  const fields = Object.entries(schema?.properties ?? {});
  const errorFor = (key: string) => errors.filter((d) => d.message.startsWith(`${key} `) || d.message.startsWith(`${key}.`) || d.message.startsWith(`"${key}" `)).map((d) => d.message);
  const claimed = new Set(fields.flatMap(([key]) => errorFor(key)));
  const requiredCount = fields.filter(([key]) => schema?.required?.includes(key)).length;

  return (
    <section className="fm" id="frontmatter-panel" aria-label="Frontmatter">
      <div className="fm-head">
        <h2 className="fm-title">Frontmatter</h2>
        {schema?.title && <span className="fm-schema">{schema.title}</span>}
        {schema && (
          <span className="fm-meta">
            {fields.length} {fields.length === 1 ? "field" : "fields"} · {requiredCount} required
          </span>
        )}
        <span className="sp" />
        {schema && (
          <div role="group" aria-label="Frontmatter view" className="group">
            {(["form", "yaml"] as const).map((m) => (
              <button key={m} type="button" className="seg" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === "form" ? "Form" : "YAML"}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="icon-btn" aria-label="Close frontmatter" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      {parseError && <div className="fm-error" role="alert">{parseError}</div>}
      {effective === "yaml" || !schema ? (
        <div className="fm-raw">
          <textarea className="fm-yaml" aria-label="Frontmatter YAML" spellCheck={false} rows={Math.min(12, Math.max(3, raw.split("\n").length + 1))} value={raw} onChange={(e) => onChange(e.target.value)} />
          {!schema && <div className="fm-meta">No schema matches this file. Add one under <code>[[schemas]]</code> in .mdx-ide/config.toml for a form.</div>}
          {errors.map((d, i) => <div key={i} className="fm-error">{d.message}</div>)}
        </div>
      ) : (
        <div className="fm-grid">
          {packRows(fields).map(({ key, prop, span }) => (
            <Field key={key} name={key} prop={prop} span={span} required={!!schema.required?.includes(key)} value={data[key]} errors={errorFor(key)} onChange={(v) => set(key, v)} />
          ))}
          {errors.filter((d) => !claimed.has(d.message)).map((d, i) => (
            <div key={i} className="fm-error fm-span-12">{d.message}</div>
          ))}
        </div>
      )}
    </section>
  );
}

type Span = 3 | 6 | 9 | 12;

/** Column span (of 12) from the field's type and expected length. */
function spanFor(prop: Schema): Span {
  const t = typeOf(prop);
  if (t === "array" || t === "object") return 12;
  if (prop.enum || t === "boolean" || t === "integer" || t === "number") return 3;
  if (prop.maxLength !== undefined) return prop.maxLength > 80 ? 9 : prop.maxLength <= 40 ? 3 : 6;
  return 6;
}

/** Fill each row with the next fields that fit, so DOM (tab) order matches what is on screen. */
export function packRows(fields: [string, Schema][]) {
  const queue = fields.map(([key, prop]) => ({ key, prop, span: spanFor(prop) }));
  const out: typeof queue = [];
  let free = 12;
  while (queue.length) {
    let i = queue.findIndex((f) => f.span <= free);
    if (i < 0) {
      free = 12;
      i = 0;
    }
    const [f] = queue.splice(i, 1);
    free -= f.span;
    out.push(f);
  }
  return out;
}

const humanize = (key: string) => {
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function Field({ name, prop, span, required, value, errors, onChange }: { name: string; prop: Schema; span: Span; required: boolean; value: unknown; errors: string[]; onChange(v: unknown): void }) {
  const id = `fm-${name}`;
  const t = typeOf(prop);
  const isText = !prop.enum && (t === "string" || t === undefined);
  const counted = isText && prop.maxLength !== undefined;
  const length = typeof value === "string" ? [...value].length : 0;
  // The right of the label line: a character counter, the array hint, or the schema description.
  const help = counted ? `${length} / ${prop.maxLength}` : t === "array" ? "Press Enter or comma to add" : prop.description;
  const describedBy = [help ? `${id}-help` : "", errors.length ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const a11y = { id, "aria-describedby": describedBy, "aria-invalid": errors.length ? true : undefined, "aria-required": required || undefined };

  let control: React.ReactNode;
  if (prop.enum) {
    const current = value === undefined || value === null ? "" : String(value);
    control = (
      <div className="fm-control fm-select">
        {current && <span className="fm-dot" data-value={current.toLowerCase()} aria-hidden="true" />}
        <select {...a11y} value={current} onChange={(e) => onChange(prop.enum!.find((o) => String(o) === e.target.value))}>
          <option value="">Select…</option>
          {prop.enum.map((o) => <option key={String(o)} value={String(o)}>{typeof o === "string" ? humanize(o) : String(o)}</option>)}
        </select>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
    );
  } else if (t === "boolean") {
    const on = value === true;
    control = (
      <div className="fm-control">
        <button {...a11y} type="button" role="switch" aria-checked={on} className="fm-switch" onClick={() => onChange(!on)}>
          <span className="fm-knob" />
        </button>
        <span aria-hidden="true">{on ? "On" : "Off"}</span>
      </div>
    );
  } else if (t === "integer" || t === "number") {
    const n = typeof value === "number" ? value : undefined;
    const clamp = (v: number) => Math.min(prop.maximum ?? Infinity, Math.max(prop.minimum ?? -Infinity, v));
    const step = (d: number) => onChange(clamp(n === undefined ? (prop.minimum ?? 0) : n + d));
    control = (
      <div className="fm-control fm-stepper">
        <button type="button" aria-label={`Decrease ${humanize(name)}`} disabled={n !== undefined && prop.minimum !== undefined && n <= prop.minimum} onClick={() => step(-1)}>−</button>
        <SyncedInput {...a11y} type="number" placeholder="—" min={prop.minimum} max={prop.maximum} value={n === undefined ? "" : String(n)} onChange={(v) => onChange(v === "" ? undefined : Number(v))} />
        <button type="button" aria-label={`Increase ${humanize(name)}`} disabled={n !== undefined && prop.maximum !== undefined && n >= prop.maximum} onClick={() => step(1)}>+</button>
      </div>
    );
  } else if (t === "array") {
    control = <ChipBox a11y={a11y} items={Array.isArray(value) ? value : []} itemType={prop.items ? typeOf(prop.items) : undefined} onChange={onChange} />;
  } else {
    control = (
      <div className="fm-control">
        <SyncedInput {...a11y} type="text" placeholder={counted ? prop.description : undefined} value={value === undefined || value === null ? "" : String(value)} onChange={onChange} />
      </div>
    );
  }

  return (
    <div className={`fm-field fm-span-${span}${errors.length ? " bad" : ""}`}>
      <div className="fm-label">
        <label htmlFor={id}>{humanize(name)}</label>
        {required && <span className="fm-required" aria-hidden="true">Required</span>}
        {help && <span id={`${id}-help`} className="fm-help" title={help}>{help}</span>}
      </div>
      {control}
      {errors.length > 0 && (
        <div id={`${id}-error`} className="fm-error">
          {errors.map((m, i) => <div key={i}>{m}</div>)}
        </div>
      )}
    </div>
  );
}

/** Array editor: chips with remove buttons; Enter or comma adds, Backspace removes the last. */
function ChipBox({ a11y, items, itemType, onChange }: { a11y: React.InputHTMLAttributes<HTMLInputElement>; items: unknown[]; itemType?: string; onChange(v: unknown[]): void }) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const add = (text: string) => {
    const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
    const numeric = itemType === "integer" || itemType === "number";
    const next = [...items];
    for (const part of parts) {
      const v = numeric && !Number.isNaN(Number(part)) ? Number(part) : part;
      if (!next.includes(v)) next.push(v);
    }
    setDraft("");
    if (next.length !== items.length) onChange(next);
  };
  return (
    <div className="fm-control fm-chips" onClick={(e) => e.target === e.currentTarget && input.current?.focus()}>
      {items.map((item, i) => (
        <span key={`${String(item)}-${i}`} className="fm-chip">
          {String(item)}
          <button
            type="button"
            aria-label={`Remove ${String(item)}`}
            onClick={() => {
              onChange(items.filter((_, j) => j !== i));
              input.current?.focus();
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        {...a11y}
        ref={input}
        type="text"
        placeholder={items.length ? "" : "Add a tag…"}
        value={draft}
        onChange={(e) => (e.target.value.includes(",") ? add(e.target.value) : setDraft(e.target.value))}
        onBlur={() => add(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && items.length) {
            onChange(items.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

/** Controlled input that keeps its own text while focused, because the document value
 *  round-trips through the (debounced) analysis and would otherwise fight the caret. */
function SyncedInput({ value, onChange, ...rest }: { value: string; onChange(v: string): void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);
  return (
    <input
      {...rest}
      value={local}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        setLocal(value);
      }}
      onChange={(e) => {
        setLocal(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}
