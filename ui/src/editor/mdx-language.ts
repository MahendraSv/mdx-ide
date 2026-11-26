import { javascriptLanguage } from "@codemirror/lang-javascript";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { languages } from "@codemirror/language-data";
import { parseMixed, type SyntaxNodeRef, type Input } from "@lezer/common";
import type { MarkdownConfig } from "@lezer/markdown";

const jsx = javascriptLanguage.configure({ dialect: "jsx" }).parser;
const esm = javascriptLanguage.parser;
const ESM_START = /^\s*(import|export)\b/;

// MDX = Markdown whose JSX elements (HTMLBlock / HTMLTag nodes) and
// `import` / `export` paragraphs are re-parsed with the JavaScript grammar.
// The JS parser is error-tolerant, so lone opening / closing tags still highlight.
// A JSX tag whose attributes may hold quoted strings and `{expressions}` (which CommonMark's
// HTML rules reject, so such tags arrive as plain Paragraph text).
const JSX_TAG = /<\/?[A-Za-z][\w.:-]*(?:"[^"]*"|'[^']*'|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}|[^>{}"'])*?\/?>|<>|<\/>/g;

const mixed = parseMixed((node: SyntaxNodeRef, input: Input) => {
  switch (node.name) {
    case "HTMLBlock":
    case "HTMLTag":
      return { parser: jsx };
    case "Paragraph":
    {
      if (ESM_START.test(input.read(node.from, Math.min(node.to, node.from + 40)))) return { parser: esm };
      const text = input.read(node.from, node.to);
      const overlay = [...text.matchAll(JSX_TAG)].map((m) => ({ from: node.from + m.index!, to: node.from + m.index! + m[0].length }));
      return overlay.length ? { parser: jsx, overlay } : null;
    }
    default:
      return null;
  }
});

const mdxExtension: MarkdownConfig = { wrap: mixed };

/** MDX: YAML frontmatter + Markdown (GFM) + JSX + ESM + fenced-code languages. */
export const mdxLanguage = () =>
  yamlFrontmatter({
    content: markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [mdxExtension] }),
  });
