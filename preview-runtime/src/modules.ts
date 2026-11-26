// Turns compiled MDX (an ES module string) into a live module.
//
// Compiled MDX imports bare specifiers like `react/jsx-runtime`. The sandboxed
// iframe has no bundler and no import map we can rely on across webviews
// (WebKitGTK, WKWebView, WebView2), so we rewrite known specifiers to blob:
// "shim" modules that re-export this runtime's own React instance. That keeps
// one React copy for the runtime, the team components and the document.

import { parse } from "es-module-lexer/js";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";

const IDENT = /^[A-Za-z_$][\w$]*$/;

function shimFor(globalKey: string, ns: Record<string, unknown>): string {
  const names = Object.keys(ns).filter((k) => IDENT.test(k) && k !== "default");
  const src =
    `const ns = globalThis.__MDX_IDE__.${globalKey};\n` +
    `export default (ns.default ?? ns);\n` +
    names.map((n) => `export const ${n} = ns[${JSON.stringify(n)}];`).join("\n");
  return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
}

declare global {
  // eslint-disable-next-line no-var
  var __MDX_IDE__: Record<string, unknown>;
}

globalThis.__MDX_IDE__ = { React, JsxRuntime, ReactDOM, team: {} };

const shims: Record<string, string> = {
  react: shimFor("React", React as never),
  "react/jsx-runtime": shimFor("JsxRuntime", JsxRuntime as never),
  "react-dom": shimFor("ReactDOM", ReactDOM as never),
};

/** Register the team package name (e.g. `@team/ui`) so `import { X } from "@team/ui"` works in docs. */
export function registerTeamPackage(name: string, ns: Record<string, unknown>) {
  (globalThis.__MDX_IDE__ as Record<string, unknown>).team = ns;
  if (shims[name]) URL.revokeObjectURL(shims[name]);
  shims[name] = shimFor("team", ns);
}

export class UnsupportedImportError extends Error {}

export function rewriteImports(code: string): string {
  // A real module lexer, so import-like text in comments and strings is left alone.
  // The asm.js build runs under the preview's CSP, which blocks WebAssembly.
  const [imports] = parse(code);
  let out = "";
  let last = 0;
  for (const found of imports) {
    // `import.meta` and `import(someVariable)` have no static specifier.
    if (found.type === "import-meta") continue;
    const { specifier: spec, start, end } = found;
    if (spec == null || spec.startsWith("blob:")) continue;
    const target = shims[spec];
    if (!target) {
      // TODO(v1): resolve relative imports (./Chart.tsx) through the Rust core (Oxc transform) and serve via mdxpreview://.
      throw new UnsupportedImportError(
        `Preview can't resolve import "${spec}" yet. Use a component from the team manifest, or "${Object.keys(shims).join('", "')}".`,
      );
    }
    // Static specifier ranges exclude the quotes; dynamic `import("x")` ranges include them.
    out += code.slice(last, start) + (found.type === "dynamic" ? JSON.stringify(target) : target);
    last = end;
  }
  return out + code.slice(last);
}

/** Import an ES module from source text. Returns the module namespace. */
export async function importFromSource<T = Record<string, unknown>>(code: string): Promise<T> {
  const url = URL.createObjectURL(new Blob([rewriteImports(code)], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ url)) as T;
  } finally {
    URL.revokeObjectURL(url);
  }
}
