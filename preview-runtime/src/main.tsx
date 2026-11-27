import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { builtinComponents } from "./components";
import { announce, closeDeck, deckComponents, deckKey, DeckView, followCursor, onDeckChange, openDeck, setPresenting, slideCommand } from "./deck";
import { importFromSource, registerTeamPackage } from "./modules";
import type { FromPreview, ToPreview } from "./protocol";
import { takeSnapshot } from "./snapshot";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "./preview.css";

type MDXContent = ComponentType<{ components?: Record<string, unknown> }>;

const root = createRoot(document.getElementById("root")!);
let components: Record<string, unknown> = { ...builtinComponents };
let currentVersion = 0;
let docPath = "";
let cursorLine = 0;
/** What is on screen, if it rendered without error. Rendering it again would only reset
 *  component state (the selected tab, an opened section), which PDF export must keep. */
let shown: { code: string; docPath: string } | null = null;

function post(msg: FromPreview) {
  // The parent is the editor window. Our origin is opaque (sandboxed), and the
  // editor checks `event.source`, so "*" is fine for outgoing messages.
  window.parent.postMessage(msg, "*");
}

/** Load the team's prebundled component library, if the repo configures one. */
async function loadTeamComponents() {
  try {
    const res = await fetch("/team/components.js");
    if (!res.ok) return; // not configured → built-in demo components
    const ns = await importFromSource(await res.text());
    const exported = Object.fromEntries(Object.entries(ns).filter(([k]) => /^[A-Z]/.test(k)));
    components = { ...builtinComponents, ...exported };
    const pkg = (ns as { packageName?: string }).packageName ?? "@team/ui";
    registerTeamPackage(pkg, ns);
  } catch (e) {
    console.error("[preview] could not load team components", e);
    post({ type: "load-error", message: (e as Error).message });
  }
  for (let i = 0; ; i++) {
    const res = await fetch(`/team/css/${i}`).catch(() => null);
    if (!res?.ok) break;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `/team/css/${i}`;
    document.head.append(link);
  }
}

/** Resolve image paths relative to the document, served via /ws/. */
function resolveAsset(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  if (/^([a-z][a-z0-9+.-]*:|\/\/|data:|blob:)/i.test(src)) return src;
  if (src.startsWith("/")) return `/static${src}`; // resolved against config.static_dirs
  const dir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/") + 1) : "";
  return `/ws/${dir}${src}`;
}

onDeckChange((state) => post({ type: "slides", state }));

/** Stand-ins for components that do not exist. Without them one unknown name stops the whole
 *  page; with them only the slide that uses it fails. */
function missingComponents(names: string[]): Record<string, unknown> {
  return Object.fromEntries(
    names
      .filter((name) => !name.includes(".") && !(name in components))
      .map((name) => [
        name,
        () => {
          throw new Error(`Expected component \`${name}\` to be defined: it is not one of your components.`);
        },
      ]),
  );
}

const overrides = {
  img: (props: Record<string, unknown>) => <img {...props} src={resolveAsset(props.src)} />,
};

class ErrorBoundary extends Component<{ version: number; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    shown = null;
    post({ type: "error", version: this.props.version, message: error.message, stack: error.stack });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="mdx-ide-error">
          <strong>Render error</strong>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/** `docs/getting-started.mdx` → "Docs / Getting started". */
function breadcrumb(path: string): string {
  return path
    .replace(/\.mdx$/i, "")
    .split("/")
    .map((part) => {
      const words = part.replace(/[-_]+/g, " ").trim();
      return words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join(" / ");
}

/** Dashed outline and `<Tag> · line N` label on the component that contains the cursor. */
function highlightActive() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-tag]")) {
    const start = Number(el.dataset.line);
    const active = cursorLine >= start && cursorLine <= Number(el.dataset.lineEnd ?? start);
    el.classList.toggle("mdx-ide-active", active);
    if (active) el.dataset.label = `<${el.dataset.tag}> · line ${start}`;
  }
}
/** Rendered diff: which top-level blocks differ from the other version. */
let changes: { kind: "added" | "removed"; ranges: [number, number][] } | null = null;
let scrolledToChange = false;

function highlightChanges() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-line]")) {
    const start = Number(el.dataset.line);
    const end = Number(el.dataset.lineEnd ?? start);
    const changed = !!changes?.ranges.some(([from, to]) => start <= to && end >= from);
    el.classList.toggle("mdx-ide-added", changed && changes?.kind === "added");
    el.classList.toggle("mdx-ide-removed", changed && changes?.kind === "removed");
  }
  const first = document.querySelector(".mdx-ide-added, .mdx-ide-removed");
  if (first && !scrolledToChange) {
    scrolledToChange = true;
    first.scrollIntoView({ block: "center" });
  }
}

// React commits asynchronously; re-apply the highlights whenever the document changes.
new MutationObserver(() => {
  highlightActive();
  if (changes) highlightChanges();
}).observe(document.getElementById("root")!, { childList: true, subtree: true });

async function render(msg: Extract<ToPreview, { type: "render" }>) {
  currentVersion = msg.version;
  // e.g. after saving: the same module for the same page.
  if (shown && shown.code === msg.code && shown.docPath === msg.docPath) {
    post({ type: "rendered", version: msg.version });
    announce();
    return;
  }
  // Keep the scroll position while editing one file; start at the top of a different one.
  const newDocument = msg.docPath !== docPath;
  const scrollY = newDocument || msg.slides ? 0 : window.scrollY;
  docPath = msg.docPath;
  try {
    const mod = await importFromSource<{ default: MDXContent }>(msg.code);
    if (msg.version !== currentVersion) return; // a newer edit arrived meanwhile
    const Content = mod.default;
    if (msg.slides) openDeck(msg.slides.starts, newDocument, cursorLine);
    else closeDeck();
    root.render(
      <ErrorBoundary key={msg.version} version={msg.version}>
        {msg.slides ? (
          <DeckView>
            <Content components={{ ...missingComponents(msg.slides.components), ...components, ...overrides, ...deckComponents }} />
          </DeckView>
        ) : (
          <article className="mdx-ide-doc">
            <div className="mdx-ide-crumbs">{breadcrumb(msg.docPath)}</div>
            <Content components={{ ...components, ...overrides }} />
          </article>
        )}
      </ErrorBoundary>,
    );
    shown = { code: msg.code, docPath: msg.docPath };
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
    post({ type: "rendered", version: msg.version });
  } catch (e) {
    const err = e as Error;
    post({ type: "error", version: msg.version, message: err.message, stack: err.stack });
  }
}

function scrollToLine(line: number) {
  // A deck shows the slide under the cursor instead.
  if (document.documentElement.hasAttribute("data-deck")) return;
  const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-line]"));
  let best: HTMLElement | undefined;
  for (const n of nodes) {
    if (Number(n.dataset.line) <= line) best = n;
    else break;
  }
  (best ?? nodes[0])?.scrollIntoView({ block: "start", behavior: "smooth" });
}

const CONTROLS = ["button", "input", "select", "textarea", "label", "summary", "audio", "video", "[contenteditable]:not([contenteditable='false'])"]
  .concat(["button", "tab", "switch", "checkbox", "radio", "slider", "menuitem", "option", "combobox", "textbox"].map((role) => `[role='${role}']`))
  .join(", ");

// Click-to-source: report the source line of the nearest annotated element.
document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-line]");
  if (!el) return;
  // Let links behave normally inside a sandbox: never navigate the preview away.
  if ((e.target as HTMLElement).closest("a")) e.preventDefault();
  // Using a control is not a request to see its source: the editor would take the keyboard from it.
  if ((e.target as HTMLElement).closest(CONTROLS)) return;
  post({ type: "click", line: Number(el.dataset.line) });
});

// Keys pressed inside the preview never reach the editor window, so forward the ones it needs.
window.addEventListener("keydown", (e) => {
  // A component that used the key (closing its own pop-up, say) marks it as handled.
  if (e.defaultPrevented) return;
  if (deckKey(e)) {
    e.preventDefault();
    return;
  }
  const key = e.key === "Escape" ? "escape" : e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey) ? "present" : null;
  if (!key) return;
  e.preventDefault();
  post({ type: "shortcut", key });
});

window.addEventListener("message", (event: MessageEvent<ToPreview>) => {
  if (event.source !== window.parent) return;
  const msg = event.data;
  switch (msg?.type) {
    case "render":
      void render(msg);
      break;
    case "scrollToLine":
      scrollToLine(msg.line);
      break;
    case "cursor":
      cursorLine = msg.line;
      if (msg.moved) followCursor(msg.line);
      highlightActive();
      break;
    case "slide":
      slideCommand(msg.command);
      break;
    case "present":
      setPresenting(msg.on);
      break;
    case "focus":
      window.focus();
      break;
    case "changes":
      changes = { kind: msg.kind, ranges: msg.ranges };
      scrolledToChange = false;
      highlightChanges();
      break;
    case "snapshot": {
      const page = takeSnapshot();
      post({ type: "snapshot", id: msg.id, ...(page ?? { body: "", styles: "", theme: "light" }) });
      break;
    }
    case "clear":
      currentVersion = -1; // discard any render still importing
      shown = null;
      docPath = "";
      root.render(null);
      closeDeck();
      break;
    case "theme":
      document.documentElement.dataset.theme = msg.dark ? "dark" : "light";
      break;
  }
});

loadTeamComponents().finally(() => post({ type: "ready" }));
