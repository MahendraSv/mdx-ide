// Pasting rich text (copied from a browser, chat, docs...) inserts Markdown, not flattened text.

import { gfm } from "@truto/turndown-plugin-gfm";
import TurndownService from "turndown";

// Only convert HTML that actually carries structure. Code copied from an editor is HTML made of
// styled <span>s; converting that would only add escaping, so those keep their plain text.
const SEMANTIC = /<(h[1-6]|ul|ol|li|strong|b|em|i|pre|blockquote|table|a\s[^>]*href|img|hr)[\s>]/i;

let service: TurndownService | null = null;

function turndown(): TurndownService {
  if (!service) {
    service = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "_",
      hr: "---",
    });
    service.use(gfm);
  }
  return service;
}

/** Markdown for the clipboard's HTML, or null when the paste should stay plain text. */
export function clipboardToMarkdown(data: DataTransfer | null): string | null {
  const html = data?.getData("text/html");
  if (!html || !SEMANTIC.test(html)) return null;
  try {
    const md = turndown().turndown(html).trim();
    return md || null;
  } catch {
    return null;
  }
}
