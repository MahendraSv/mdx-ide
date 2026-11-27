// A static copy of the page as it looks right now, for PDF export.
//
// Component state lives in React and in form elements. Whatever React has rendered (the selected
// tab, an opened section, a counter) is already in the DOM; what the DOM keeps only as live
// properties (typed text, ticked boxes, chosen options, canvas drawings) is written back into
// the copy as attributes and images. The copy contains no scripts.

export interface Snapshot {
  /** Inner HTML of `<body>`, including anything components rendered outside the document. */
  body: string;
  /** CSS added at run time (e.g. by CSS-in-JS). Linked stylesheets are loaded again instead. */
  styles: string;
  theme: string;
  /** The page is a slide deck: it prints one slide per page. */
  slides: boolean;
}

const REMOVE = "script, noscript, iframe, frame, object, embed, meta, base, link";

/** `null` while there is no rendered page: exporting then would produce blank paper. */
export function takeSnapshot(source: HTMLElement = document.body): Snapshot | null {
  if (!source.querySelector(".mdx-ide-doc")) return null;
  const copy = source.cloneNode(true) as HTMLElement;
  // Both trees are walked in document order, so positions correspond until anything is removed.
  const originals = source.querySelectorAll<HTMLElement>("*");
  const copies = copy.querySelectorAll<HTMLElement>("*");
  originals.forEach((original, i) => syncState(original, copies[i]));

  copy.querySelectorAll(REMOVE).forEach((el) => el.remove());
  // Slides print complete: every step shown, without speaker notes or overview buttons.
  copy.querySelectorAll(".mdx-ide-pick, .mdx-ide-notes").forEach((el) => el.remove());
  for (const el of copy.querySelectorAll(".mdx-ide-slide, .mdx-ide-step")) {
    el.removeAttribute("data-pending");
    el.removeAttribute("inert");
  }
  for (const el of copy.querySelectorAll("*")) {
    for (const { name, value } of Array.from(el.attributes)) {
      if (name.startsWith("on") || (/^(href|src|action|formaction|xlink:href)$/i.test(name) && /^\s*javascript:/i.test(value))) el.removeAttribute(name);
    }
    // The editor's own cursor and diff markers are not part of the page.
    el.classList.remove("mdx-ide-active", "mdx-ide-added", "mdx-ide-removed");
    el.removeAttribute("data-label");
  }
  const slides = !!copy.querySelector(".mdx-ide-deck");
  return { body: copy.innerHTML, styles: runtimeStyles(), theme: document.documentElement.dataset.theme ?? "light", slides };
}

function syncState(original: Element, copy: Element) {
  if (original instanceof HTMLInputElement) {
    if (original.type === "checkbox" || original.type === "radio") copy.toggleAttribute("checked", original.checked);
    // A file input cannot be given a value, and a password has no place in a document.
    else if (original.type !== "file" && original.type !== "password") copy.setAttribute("value", original.value);
    else copy.removeAttribute("value");
  } else if (original instanceof HTMLTextAreaElement) {
    copy.textContent = original.value;
  } else if (original instanceof HTMLOptionElement) {
    copy.toggleAttribute("selected", original.selected);
  } else if (original instanceof HTMLCanvasElement) {
    replaceWithImage(original, copy, () => original.toDataURL());
  } else if (original instanceof HTMLImageElement && original.src.startsWith("blob:")) {
    // A blob: URL only exists in this frame; embed the picture itself.
    replaceWithImage(original, copy, () => {
      const canvas = document.createElement("canvas");
      canvas.width = original.naturalWidth;
      canvas.height = original.naturalHeight;
      canvas.getContext("2d")!.drawImage(original, 0, 0);
      return canvas.toDataURL();
    });
  }
}

function replaceWithImage(original: Element, copy: Element, read: () => string) {
  let url: string;
  try {
    url = read();
  } catch {
    return; // e.g. a canvas holding cross-origin pixels
  }
  const image = document.createElement("img");
  image.src = url;
  image.className = original.getAttribute("class") ?? "";
  const style = original.getAttribute("style");
  // The layout size: a slide is scaled on screen, which the copy must not be.
  const { offsetWidth: width, offsetHeight: height } = original as HTMLElement;
  // Keep the on-screen size (a hidden preview measures zero; the picture's own size then applies).
  image.setAttribute("style", `${style ? `${style};` : ""}${width ? `width:${width}px;height:${height}px;` : ""}`);
  if (original instanceof HTMLImageElement) image.alt = original.alt;
  copy.replaceWith(image);
}

function runtimeStyles(): string {
  const sheets = [...Array.from(document.styleSheets).filter((s) => s.ownerNode instanceof HTMLStyleElement), ...(document.adoptedStyleSheets ?? [])];
  return sheets
    .map((sheet) => {
      try {
        return Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
      } catch {
        return "";
      }
    })
    .join("\n");
}
