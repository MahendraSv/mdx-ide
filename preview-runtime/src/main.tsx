import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { builtinComponents } from "./components";
import { importFromSource, registerTeamPackage } from "./modules";
import type { FromPreview, ToPreview } from "./protocol";
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

const overrides = {
  img: (props: Record<string, unknown>) => <img {...props} src={resolveAsset(props.src)} />,
};

class ErrorBoundary extends Component<{ version: number; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
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
// React commits asynchronously; re-apply the outline whenever the document changes.
new MutationObserver(highlightActive).observe(document.getElementById("root")!, { childList: true, subtree: true });

async function render(msg: Extract<ToPreview, { type: "render" }>) {
  currentVersion = msg.version;
  // Keep the scroll position while editing one file; start at the top of a different one.
  const scrollY = msg.docPath === docPath ? window.scrollY : 0;
  docPath = msg.docPath;
  try {
    const mod = await importFromSource<{ default: MDXContent }>(msg.code);
    if (msg.version !== currentVersion) return; // a newer edit arrived meanwhile
    const Content = mod.default;
    root.render(
      <ErrorBoundary key={msg.version} version={msg.version}>
        <article className="mdx-ide-doc">
          <div className="mdx-ide-crumbs">{breadcrumb(msg.docPath)}</div>
          <Content components={{ ...components, ...overrides }} />
        </article>
      </ErrorBoundary>,
    );
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
    post({ type: "rendered", version: msg.version });
  } catch (e) {
    const err = e as Error;
    post({ type: "error", version: msg.version, message: err.message, stack: err.stack });
  }
}

function scrollToLine(line: number) {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-line]"));
  let best: HTMLElement | undefined;
  for (const n of nodes) {
    if (Number(n.dataset.line) <= line) best = n;
    else break;
  }
  (best ?? nodes[0])?.scrollIntoView({ block: "start", behavior: "smooth" });
}

// Click-to-source: report the source line of the nearest annotated element.
document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-line]");
  if (!el) return;
  // Let links behave normally inside a sandbox: never navigate the preview away.
  if ((e.target as HTMLElement).closest("a")) e.preventDefault();
  post({ type: "click", line: Number(el.dataset.line) });
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
      highlightActive();
      break;
    case "clear":
      currentVersion = -1; // discard any render still importing
      docPath = "";
      root.render(null);
      break;
    case "theme":
      document.documentElement.dataset.theme = msg.dark ? "dark" : "light";
      break;
  }
});

loadTeamComponents().finally(() => post({ type: "ready" }));
