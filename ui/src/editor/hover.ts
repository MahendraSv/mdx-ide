// Hover docs for JSX components and their props, driven by the component manifest.

import { hoverTooltip, type Tooltip } from "@codemirror/view";
import type { ComponentManifest, ComponentSpec, PropSpec } from "../api";

const WORD = /[\w.-]/;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function componentCard(c: ComponentSpec): HTMLElement {
  const root = el("div", "hover-card");
  root.append(el("div", "hover-title", `<${c.name}>`));
  if (c.description) root.append(el("div", "hover-desc", c.description));
  if (c.props.length) {
    const ul = el("ul", "hover-props");
    for (const p of c.props) {
      const li = el("li", "");
      li.append(el("code", "", `${p.name}${p.required ? "" : "?"}`), el("span", "hover-type", `: ${typeOf(p)}`));
      ul.append(li);
    }
    root.append(ul);
  }
  return root;
}

const typeOf = (p: PropSpec) => (p.values.length ? p.values.map((v) => JSON.stringify(v)).join(" | ") : p.type);

function propCard(c: ComponentSpec, p: PropSpec): HTMLElement {
  const root = el("div", "hover-card");
  root.append(el("div", "hover-title", `${c.name}.${p.name}${p.required ? "" : "?"}: ${typeOf(p)}`));
  if (p.description) root.append(el("div", "hover-desc", p.description));
  if (p.required) root.append(el("div", "hover-desc dim", "Required"));
  return root;
}

export function mdxHover(getManifest: () => ComponentManifest | null) {
  return hoverTooltip((view, pos): Tooltip | null => {
    const manifest = getManifest();
    if (!manifest) return null;
    const doc = view.state.doc;
    const line = doc.lineAt(pos);
    let s = pos - line.from;
    let e = s;
    while (s > 0 && WORD.test(line.text[s - 1])) s--;
    while (e < line.text.length && WORD.test(line.text[e])) e++;
    if (s === e) return null;
    const word = line.text.slice(s, e);
    const from = line.from + s;

    // Find the enclosing `<Tag ...` (tags may span lines).
    const winStart = Math.max(0, from - 2000);
    const before = view.state.sliceDoc(winStart, from);
    const lt = before.lastIndexOf("<");
    if (lt < 0 || before.indexOf(">", lt) !== -1 && !/^\/?$/.test(before.slice(lt + 1))) return null;
    const head = before.slice(lt + 1); // text between `<` and the word
    const tagMatch = /^\/?([A-Z][\w.]*)/.exec(head + word);
    if (!tagMatch) return null;
    const comp = manifest.components.find((c) => c.name === tagMatch[1]);
    if (!comp) return null;

    if (/^\/?$/.test(head)) {
      return { pos: from, end: line.from + e, above: true, create: () => ({ dom: componentCard(comp) }) };
    }
    const prop = comp.props.find((p) => p.name === word);
    if (prop && /\s$/.test(head)) {
      return { pos: from, end: line.from + e, above: true, create: () => ({ dom: propCard(comp, prop) }) };
    }
    return null;
  });
}
