// A tiny team component bundle for the MDX IDE preview.
//
// Rules for a bundle:
//   * one ES module file;
//   * `react`, `react/jsx-runtime` and `react-dom` stay as imports (do not bundle them);
//   * no other imports, including relative ones;
//   * every export whose name starts with a capital letter becomes an MDX component.
//
// It is written by hand so it works without a build step.

import { useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

/** Lets documents write `import { Stat } from "@demo/ui"`. */
export const packageName = "@demo/ui";

export function Stat({ label, value }) {
  return jsxs("div", {
    className: "demo-stat",
    children: [
      jsx("span", { className: "demo-stat-value", children: value }),
      jsx("span", { className: "demo-stat-label", children: label }),
    ],
  });
}

/** Uses a hook, which proves the bundle shares the preview's copy of React. */
export function Counter({ start = 0 }) {
  const [count, setCount] = useState(Number(start));
  return jsxs("button", {
    type: "button",
    className: "demo-counter",
    onClick: () => setCount(count + 1),
    children: ["Clicked ", count, " times"],
  });
}
