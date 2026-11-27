// JSX-aware autocompletion backed by the Rust component manifest.
//
//   <Cal|                    → component names (inserts a snippet with required props)
//   <Callout ty|             → props not used yet
//   <Callout type="|"        → allowed values for string-union props

import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { api, type CompletionItem } from "../api";

const TAG_NAME = /<([A-Z][\w.]*)$/;
const ATTR_VALUE = /<([A-Z][\w.]*)\b[^<>]*?\s([\w-]+)=["']([^"']*)$/;
const ATTR_NAME = /<([A-Z][\w.]*)\b([^<>]*?)\s([\w-]*)$/;

function toCompletion(item: CompletionItem): Completion {
  const base: Completion = {
    label: item.label,
    type: item.type,
    detail: item.detail ?? undefined,
    info: item.info ?? undefined,
  };
  return item.snippet ? snippetCompletion(item.snippet, base) : base;
}

export async function mdxCompletionSource(cx: CompletionContext): Promise<CompletionResult | null> {
  // Look back a bounded window: tags can span lines.
  const from = Math.max(0, cx.pos - 2000);
  const before = cx.state.sliceDoc(from, cx.pos);
  // Enough of the document to read its frontmatter.
  const head = cx.state.sliceDoc(0, 4000);

  const value = ATTR_VALUE.exec(before);
  if (value) {
    const [, component, prop, typed] = value;
    const items = await api.completePropValues(component, prop, head);
    return items.length ? { from: cx.pos - typed.length, options: items.map(toCompletion), validFor: /^[\w-]*$/ } : null;
  }

  const tag = TAG_NAME.exec(before);
  if (tag) {
    const items = await api.completeComponents(head);
    return { from: cx.pos - tag[1].length, options: items.map(toCompletion), validFor: /^[\w.]*$/ };
  }

  const attr = ATTR_NAME.exec(before);
  if (attr && !attr[2].includes(">")) {
    const [, component, existing, typed] = attr;
    const already = Array.from(existing.matchAll(/\s([\w-]+)(?==|\s|$)/g), (m) => m[1]);
    const items = await api.completeProps(component, already, head);
    return items.length ? { from: cx.pos - typed.length, options: items.map(toCompletion), validFor: /^[\w-]*$/ } : null;
  }
  return null;
}
