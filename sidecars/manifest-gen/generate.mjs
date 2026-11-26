#!/usr/bin/env node
// Generate `component-manifest.json` from React + TypeScript components.
//
//   node generate.mjs --src "packages/ui/src/**/*.tsx" --package @team/ui \
//        --out path/to/docs-repo/.mdx-ide/component-manifest.json [--tsconfig packages/ui/tsconfig.json]
//
// Run it in your design system's CI and commit the result to the docs repo
// (or publish it inside the package and point `component_manifest` at it).
//
// JSDoc tags read from each component:
//   @category Feedback        palette group
//   @mdxSnippet <Callout type="${1:info}">${2}</Callout>   custom insert snippet (leading "<" optional)
//   @mdxIgnore                leave the component out of the manifest
//
// Uses TypeScript 5.x on purpose: react-docgen-typescript needs the JS compiler API.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import fg from "fast-glob";
import docgen from "react-docgen-typescript";

const { values: args } = parseArgs({
  options: {
    src: { type: "string", multiple: true },
    package: { type: "string" },
    out: { type: "string", default: ".mdx-ide/component-manifest.json" },
    tsconfig: { type: "string" },
  },
});

if (!args.src?.length) {
  console.error('Usage: generate.mjs --src "src/**/*.tsx" [--package @team/ui] [--out file] [--tsconfig tsconfig.json]');
  process.exit(1);
}

const files = await fg(args.src, { ignore: ["**/*.test.*", "**/*.stories.*", "**/node_modules/**"], absolute: true });
const options = {
  savePropValueAsString: true,
  shouldExtractLiteralValuesFromEnum: true,
  shouldRemoveUndefinedFromOptional: true,
  // We need `children` to know whether a component wraps content.
  skipChildrenPropWithoutDoc: false,
  // Skip inherited DOM props (onClick, aria-*, ...): they'd drown out the real API.
  propFilter: (prop) => !prop.parent || !/node_modules/.test(prop.parent.fileName),
};
const parser = args.tsconfig ? docgen.withCustomConfig(args.tsconfig, options) : docgen.withDefaultConfig(options);

const unquote = (v) => String(v).replace(/^["'`](.*)["'`]$/, "$1");

const components = parser
  .parse(files)
  .filter((c) => /^[A-Z]/.test(c.displayName) && !("mdxIgnore" in (c.tags ?? {})))
  // A component re-exported from an index file is reported once per file; keep one.
  .filter((c, i, all) => all.findIndex((other) => other.displayName === c.displayName) === i)
  .map((c) => {
    const props = Object.values(c.props)
      .filter((p) => p.name !== "key" && p.name !== "ref")
      .map((p) => {
        const isEnum = p.type.name === "enum" && Array.isArray(p.type.value);
        const values = isEnum ? p.type.value.map((v) => v.value).filter((v) => /^["'`]/.test(v)).map(unquote) : [];
        return {
          name: p.name,
          type: isEnum ? p.type.value.map((v) => v.value).join(" | ") : (p.type.raw ?? p.type.name),
          required: p.required,
          ...(p.defaultValue?.value !== undefined ? { default: unquote(p.defaultValue.value) } : {}),
          ...(values.length ? { values } : {}),
          description: p.description ?? "",
        };
      });
    const snippet = c.tags?.mdxSnippet?.replace(/^</, "");
    return {
      name: c.displayName,
      description: c.description?.split("\n")[0] ?? "",
      ...(c.tags?.category ? { category: c.tags.category } : {}),
      acceptsChildren: props.some((p) => p.name === "children"),
      ...(snippet ? { snippet } : {}),
      props: props.filter((p) => p.name !== "children"),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const manifest = { $generated: new Date().toISOString(), ...(args.package ? { package: args.package } : {}), components };
mkdirSync(dirname(resolve(args.out)), { recursive: true });
writeFileSync(args.out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${components.length} components to ${args.out}`);
