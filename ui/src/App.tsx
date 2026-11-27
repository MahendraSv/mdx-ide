import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, onWorkspaceChanged, type Blame, type Branch, type ChangedFile, type Diagnostic, type DocumentAnalysis, type WorkspaceInfo, type PreviewPage, type ComponentSpec } from "./api";
import { Editor, type EditorHandle } from "./editor/Editor";
import { canMove, Explorer, NewFileIcon, NewFolderIcon, type Draft, type Entry, type EntryKind } from "./panels/Explorer";
import { Outline, Palette, Problems, Search, SlideList, type SlideIssue } from "./panels/Panels";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { FrontmatterPanel } from "./FrontmatterPanel";
import { TabStrip } from "./TabStrip";
import { DiffView, type DiffMode } from "./git/DiffView";
import { GitPanel, pathsOf, type RemoteActivity } from "./git/GitPanel";
import { errorToast, Toast, type ToastMessage } from "./git/Toast";
import { explorerMarks, workspacePath, type DiffTarget } from "./git/model";
import { useGit } from "./git/useGit";
import { Preview, type PreviewHandle } from "./Preview";
import type { SlideState } from "./preview-protocol";
import { presentationKey, SlideNav, withSlideTags } from "./Slides";

type SideTab = "files" | "search" | "components" | "git";
const SIDE_TITLES: Record<SideTab, string> = { files: "Explorer", search: "Search", components: "Components", git: "Source control" };
type ViewMode = "code" | "split" | "preview";
type Theme = "dark" | "light";
type Device = "desktop" | "mobile";
const DEVICE_KEY = "mdx-ide.previewDevice";
const initialDevice = (): Device => {
  try {
    if (localStorage.getItem(DEVICE_KEY) === "mobile") return "mobile";
  } catch {}
  return "desktop";
};

const THEME_KEY = "mdx-ide.theme";
const SIDEBAR_KEY = "mdx-ide.sidebar";
const DEFAULT_SIDEBAR_WIDTH = 264;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 520;
const clampWidth = (w: number) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w));
const loadSidebarPrefs = (): { open: boolean; width: number } => {
  try {
    const v = JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? "null");
    if (v && typeof v.open === "boolean" && typeof v.width === "number") return { open: v.open, width: clampWidth(v.width) };
  } catch {}
  return { open: true, width: DEFAULT_SIDEBAR_WIDTH };
};
const IS_MAC = /Mac/i.test(navigator.platform);

/** Follow a drag on a resize handle. Pointer capture keeps events coming over the preview iframe. */
function dragFrom(e: React.PointerEvent<HTMLElement>, onMove: (dx: number, dy: number) => void) {
  e.preventDefault();
  const handle = e.currentTarget;
  const { clientX, clientY, pointerId } = e;
  const move = (ev: PointerEvent) => onMove(ev.clientX - clientX, ev.clientY - clientY);
  const end = () => {
    document.body.classList.remove("resizing");
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("lostpointercapture", end);
  };
  // The preview is a separate frame: while dragging it must not swallow the pointer.
  document.body.classList.add("resizing");
  handle.setPointerCapture(pointerId);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("lostpointercapture", end);
}

const SPLIT_KEY = "mdx-ide.split";
const DEFAULT_SPLIT = 0.5;
/** Neither side of the split may get narrower than this, in pixels. */
const MIN_PANE = 240;
/** The editor's share of the split, kept as a ratio so it survives window resizing. */
const clampSplit = (ratio: number, width: number) => {
  const min = width > 0 ? Math.min(0.5, MIN_PANE / width) : 0.2;
  return Math.min(1 - min, Math.max(min, ratio));
};
const initialSplit = () => {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    if (v > 0 && v < 1) return v;
  } catch {}
  return DEFAULT_SPLIT;
};

const PROBLEMS_KEY = "mdx-ide.problems";
const DEFAULT_PROBLEMS_HEIGHT = 150;
const MIN_PROBLEMS_HEIGHT = 80;
const maxProblemsHeight = () => Math.round(window.innerHeight * 0.7);
const clampHeight = (h: number) => Math.min(maxProblemsHeight(), Math.max(MIN_PROBLEMS_HEIGHT, h));
const loadProblemsPrefs = (): { open: boolean; height: number } => {
  try {
    const v = JSON.parse(localStorage.getItem(PROBLEMS_KEY) ?? "null");
    if (v && typeof v.open === "boolean" && typeof v.height === "number") return { open: v.open, height: clampHeight(v.height) };
  } catch {}
  return { open: true, height: DEFAULT_PROBLEMS_HEIGHT };
};
const initialTheme = (): Theme => {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "dark" || t === "light") return t;
  } catch {}
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const Icon = ({ children, size = 20, sw = 1.8 }: { children: React.ReactNode; size?: number; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const EMPTY: DocumentAnalysis = { outline: [], links: [], components: [], frontmatter: null, importedNames: [], diagnostics: [], wordCount: 0 };
const DEBOUNCE_MS = 150;

/** An open file: its live text, what is on disk, and cached results for instant tab switching. */
interface Buffer {
  text: string;
  saved: string;
  /** Changes whenever the contents are replaced from outside the editor. */
  version: number;
  /** Last successfully compiled preview module. */
  page: PreviewPage | null;
  schema: object | null;
}

export default function App() {
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  /** The active tab. */
  const [path, setPath] = useState<string | null>(null);
  /** Open files, in tab order. */
  const [tabs, setTabs] = useState<string[]>([]);
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
  // Bumped when a buffer is replaced from disk, so the editor picks up the new contents.
  const [, setReloads] = useState(0);
  const [analysis, setAnalysis] = useState<DocumentAnalysis>(EMPTY);
  const [compileError, setCompileError] = useState<Diagnostic | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  /** Set while the preview shows a slide deck. */
  const [slides, setSlides] = useState<SlideState | null>(null);
  /** Documentation for the tags built into slide decks. */
  const [slideTags, setSlideTags] = useState<ComponentSpec[]>([]);
  useEffect(() => {
    api.slideComponents().then(setSlideTags, (e) => setError(String(e)));
  }, []);
  const [tab, setTab] = useState<SideTab>("files");
  const [view, setView] = useState<ViewMode>("split");
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [fmSchema, setFmSchema] = useState<object | null>(null);
  // mdxlint rules run in a Node process, so they are debounced separately and arrive later.
  const [lintDiags, setLintDiags] = useState<Diagnostic[]>([]);
  const [lintError, setLintError] = useState<string | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(() => loadProblemsPrefs().open);
  const [problemsHeight, setProblemsHeight] = useState(() => loadProblemsPrefs().height);
  useEffect(() => {
    try {
      localStorage.setItem(PROBLEMS_KEY, JSON.stringify({ open: problemsOpen, height: problemsHeight }));
    } catch {}
  }, [problemsOpen, problemsHeight]);
  const startResize = (e: React.PointerEvent<HTMLElement>) => {
    const startH = problemsHeight;
    dragFrom(e, (_dx, dy) => setProblemsHeight(clampHeight(startH - dy)));
  };
  const [sidebarOpen, setSidebarOpen] = useState(() => loadSidebarPrefs().open);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarPrefs().width);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, JSON.stringify({ open: sidebarOpen, width: sidebarWidth }));
    } catch {}
  }, [sidebarOpen, sidebarWidth]);
  const showSide = (t: SideTab) => {
    setTab(t);
    setSidebarOpen(true);
  };
  /** Explorer: the folder new entries go into (null follows the open file) and the entry being named. */
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The entry whose destination folder is being picked. */
  const [moving, setMoving] = useState<Entry | null>(null);
  // A half-typed name is abandoned when the explorer is hidden.
  useEffect(() => {
    if (!sidebarOpen || tab !== "files") setDraft(null);
  }, [sidebarOpen, tab]);
  const [fmOpen, setFmOpen] = useState(false);
  const git = useGit(ws);
  /** The file whose changes fill the main area; null shows the editor and preview. */
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>("source");
  const diffRef = useRef(diff);
  diffRef.current = diff;
  /** The preview fills the screen. */
  const [presenting, setPresenting] = useState(false);
  /** Whether the window was already full screen, so leaving restores what was there. */
  const wasFullscreen = useRef(false);
  const [exporting, setExporting] = useState(false);
  const exitButton = useRef<HTMLButtonElement>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [gitActivity, setGitActivity] = useState<RemoteActivity | null>(null);
  /** The result of the last Git action. */
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastId = useRef(0);
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [blameOn, setBlameOn] = useState(false);
  const [blame, setBlame] = useState<{ path: string; value: Blame } | null>(null);
  /** Bumped by typing while blame is shown. */
  const [typed, setTyped] = useState(0);
  // The preview loads the team's component bundle once, when it starts. Bumping this restarts it.
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const [split, setSplit] = useState(initialSplit);
  const splitRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_KEY, String(split));
    } catch {}
  }, [split]);
  const splitWidth = () => splitRef.current?.getBoundingClientRect().width ?? 0;
  const [device, setDevice] = useState<Device>(initialDevice);
  useEffect(() => {
    try {
      localStorage.setItem(DEVICE_KEY, device);
    } catch {}
  }, [device]);
  const [palette, setPalette] = useState<"files" | "all" | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const dark = theme === "dark";
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Result of the last rename or move. */
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // On macOS Ctrl+B moves the cursor in the editor, so only ⌘B toggles the sidebar there.
      if (e.key === "s") {
        // The editor handles ⌘S itself; this covers focus elsewhere, e.g. after renaming in the explorer.
        if (e.defaultPrevented) return;
        e.preventDefault();
        void save();
      } else if (e.key === "b" && (IS_MAC ? e.metaKey : e.ctrlKey)) {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      } else if (e.key === "k") {
        e.preventDefault();
        setPalette("all");
      } else if (e.key === "p") {
        e.preventDefault();
        setPalette("files");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const lintTimer = useRef<number | undefined>(undefined);
  const lintSeq = useRef(0);
  const scheduleLint = useCallback((p: string, source: string) => {
    window.clearTimeout(lintTimer.current);
    if (!wsRef.current?.mdxlintRules) return;
    const seq = ++lintSeq.current;
    lintTimer.current = window.setTimeout(async () => {
      try {
        const d = await api.lintMdx(p, source);
        if (seq !== lintSeq.current || pathRef.current !== p) return;
        setLintDiags(d);
        setLintError(null);
      } catch (e) {
        if (seq === lintSeq.current) {
          setLintDiags([]);
          setLintError(String(e));
        }
      }
    }, 700);
  }, []);

  const wsRef = useRef(ws);
  wsRef.current = ws;
  const buffers = useRef(new Map<string, Buffer>());
  const nextVersion = useRef(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const editor = useRef<EditorHandle>(null);
  const preview = useRef<PreviewHandle>(null);
  const timer = useRef<number | undefined>(undefined);
  const pathRef = useRef(path);
  pathRef.current = path;

  const refresh = useCallback((p: string, source: string) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const [a, c, schema] = await Promise.all([api.analyze(p, source), api.compilePreview(p, source, true), api.frontmatterSchema(p)]);
        if (pathRef.current !== p) return;
        setAnalysis(a);
        scheduleLint(p, source);
        setFmSchema((schema as object | null) ?? null);
        const buffer = buffers.current.get(p);
        if (buffer) buffer.schema = (schema as object | null) ?? null;
        if (c.status === "ok") {
          setCompileError(null);
          if (buffer) buffer.page = c;
          preview.current?.render(c, p);
        } else {
          setCompileError(c.diagnostic);
        }
      } catch (e) {
        setError(String(e));
      }
    }, DEBOUNCE_MS);
  }, [scheduleLint]);

  const markDirty = useCallback((p: string, dirty: boolean) => {
    setDirtyPaths((current) => {
      if (current.has(p) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(p);
      else next.delete(p);
      return next;
    });
  }, []);

  /** Show an already-loaded buffer (or nothing) in the editor and preview. */
  const activate = useCallback(
    (p: string | null) => {
      window.clearTimeout(timer.current);
      window.clearTimeout(lintTimer.current);
      lintSeq.current++;
      pathRef.current = p;
      setPath(p);
      setDiff(null);
      setSelectedDir(null);
      setAnalysis(EMPTY);
      setCompileError(null);
      setRuntimeError(null);
      setSlides(null);
      setLintDiags([]);
      const buffer = p ? buffers.current.get(p) : undefined;
      setFmSchema(buffer?.schema ?? null);
      // Show the file's last good render at once; never leave another file's preview up.
      if (p && buffer?.page) preview.current?.render(buffer.page, p);
      else preview.current?.clear();
      if (p && buffer) refresh(p, buffer.text);
    },
    [refresh],
  );

  const openFile = async (p: string, line?: number, column?: number) => {
    // The editor mounts / swaps its state in an effect, so jump two frames later.
    const jump = () => line && requestAnimationFrame(() => requestAnimationFrame(() => editor.current?.gotoLine(line, column)));
    try {
      if (!buffers.current.has(p)) {
        const contents = await api.readFile(p);
        if (!buffers.current.has(p)) {
          buffers.current.set(p, { text: contents, saved: contents, version: ++nextVersion.current, page: null, schema: null });
          setTabs((t) => (t.includes(p) ? t : [...t, p]));
        }
      }
      if (pathRef.current !== p) activate(p);
      else setDiff(null);
      jump();
    } catch (e) {
      setError(String(e));
    }
  };

  /** Close tabs without asking, then show a neighbour if the active one went. */
  const dropTabs = useCallback(
    (paths: string[]) => {
      const before = tabsRef.current;
      const gone = new Set(paths);
      const rest = before.filter((p) => !gone.has(p));
      tabsRef.current = rest;
      setTabs(rest);
      for (const p of paths) {
        const buffer = buffers.current.get(p);
        if (buffer) editor.current?.forget(String(buffer.version));
        buffers.current.delete(p);
        markDirty(p, false);
      }
      const active = pathRef.current;
      if (active && gone.has(active)) {
        const index = before.indexOf(active);
        activate(before.slice(index + 1).find((p) => !gone.has(p)) ?? rest[rest.length - 1] ?? null);
      }
    },
    [activate, markDirty],
  );

  const closeTab = useCallback(
    async (p: string) => {
      const buffer = buffers.current.get(p);
      if (!buffer) return;
      if (buffer.text !== buffer.saved) {
        const discard = await confirm(`${p} has unsaved changes. Close it and discard them?`, { title: "Unsaved changes", kind: "warning", okLabel: "Discard", cancelLabel: "Keep open" });
        if (!discard) return;
      }
      dropTabs([p]);
    },
    [dropTabs],
  );

  const openFolder = async (given?: string) => {
    const dir = given ?? (await open({ directory: true, title: "Open docs folder" }));
    if (typeof dir !== "string") return;
    const unsaved = [...buffers.current.values()].filter((b) => b.text !== b.saved).length;
    if (unsaved && !(await confirm(`Discard unsaved changes in ${unsaved} open ${unsaved === 1 ? "file" : "files"}?`, { title: "Unsaved changes", kind: "warning" }))) return;
    try {
      const info = await api.openWorkspace(dir);
      setWs(info);
      setPreviewGeneration((n) => n + 1);
      buffers.current.clear();
      tabsRef.current = [];
      setTabs([]);
      setDirtyPaths(new Set());
      activate(null);
      setDraft(null);
      setInfo(null);
      setCommitMessage("");
      setBlame(null);
      setToast(null);
      setTab("files");
      const first =
        info.files.find((f) => /(^|\/)(intro|index|readme)\.mdx$/i.test(f.path) && f.path.split("/").length <= 2) ?? info.files[0];
      if (first) void openFile(first.path);
    } catch (e) {
      setError(String(e));
    }
  };

  const startDraft = (kind: EntryKind, parent?: string, slides?: boolean) => {
    const open = pathRef.current;
    const dir = parent ?? selectedDir ?? (open?.includes("/") ? open.slice(0, open.lastIndexOf("/")) : "");
    showSide("files");
    setDraft({ kind, parent: dir, slides });
  };

  /** Create the named file or folder; returns an error message to show under the field. */
  const submitDraft = async (name: string): Promise<string | null> => {
    if (!draft) return null;
    const relative = draft.parent ? `${draft.parent}/${name}` : name;
    try {
      if (draft.kind === "folder") {
        const created = await api.createFolder(relative);
        setWs(await api.listFiles());
        setSelectedDir(created);
        setDraft(null);
      } else {
        if (/\.(md|txt|tsx?|jsx?|json|ya?ml|html?|css)$/i.test(name)) return "Only .mdx files can be created";
        const file = /\.mdx$/i.test(relative) ? relative.replace(/\.mdx$/i, ".mdx") : `${relative}.mdx`;
        const created = await api.createFile(file, new Date().toLocaleDateString("en-CA"), !!draft.slides);
        setWs(await api.listFiles());
        setDraft(null);
        await openFile(created, 1);
      }
      return null;
    } catch (e) {
      return String(e);
    }
  };

  /** Point open tabs at their new paths after `from` (a file or folder) became `to`. */
  const followRename = (from: string, to: string) => {
    const moved = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    buffers.current = new Map(
      [...buffers.current].map(([p, buffer]) => {
        // The cached preview resolved relative paths against the old location.
        if (moved(p) !== p) buffer.page = null;
        return [moved(p), buffer];
      }),
    );
    tabsRef.current = tabsRef.current.map(moved);
    setTabs(tabsRef.current);
    setDirtyPaths((current) => new Set([...current].map(moved)));
    setSelectedDir((d) => (d ? moved(d) : d));
    const active = pathRef.current;
    if (active && moved(active) !== active) {
      const next = moved(active);
      pathRef.current = next;
      setPath(next);
      setLintDiags([]);
      refresh(next, buffers.current.get(next)!.text);
    }
  };

  /** Rename or move on disk, updating links. Returns an error message, or null on success. */
  const moveEntry = async (from: string, to: string): Promise<string | null> => {
    // What each open page held when we asked, to notice typing that happens meanwhile.
    const sent = new Map([...buffers.current.values()].map((b) => [b, { text: b.text, dirty: b.text !== b.saved }]));
    const unsaved = Object.fromEntries([...buffers.current].filter(([, b]) => b.text !== b.saved).map(([p, b]) => [p, b.text]));
    try {
      const report = await api.renameEntry(from, to, unsaved);
      followRename(from, report.path);
      const problems = [...report.skipped];
      for (const file of report.files) {
        const buffer = buffers.current.get(file.path);
        const before = buffer && sent.get(buffer);
        if (!buffer || !before) continue;
        // Saved contents first: applying the new text compares against them.
        if (file.disk !== null) buffer.saved = file.disk;
        const next = before.dirty ? file.buffer : file.disk;
        if (next !== null) {
          if (buffer.text !== before.text) problems.push(`${file.path}: edited during the move, its open text was not updated`);
          else {
            buffer.text = next;
            editor.current?.replaceIn(String(buffer.version), next);
          }
        }
        buffer.page = null;
        markDirty(file.path, buffer.text !== buffer.saved);
        if (pathRef.current === file.path) refresh(file.path, buffer.text);
      }
      const links = report.files.reduce((n, f) => n + f.links, 0);
      const messages = links ? [`Updated ${links} ${links === 1 ? "link" : "links"} in ${report.files.length} ${report.files.length === 1 ? "page" : "pages"}.`] : [];
      if (problems.length) messages.push(`Not updated — ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; and ${problems.length - 3} more` : ""}.`);
      setInfo(messages.join(" ") || null);
      setWs(await api.listFiles());
      return null;
    } catch (e) {
      return String(e);
    }
  };

  const renameEntry = async (from: string, name: string): Promise<string | null> => {
    if (name.includes("/")) return "Use “Move to…” to change folders";
    const isFile = !!ws?.files.some((f) => f.path === from);
    if (isFile && /\.(md|txt|tsx?|jsx?|json|ya?ml|html?|css)$/i.test(name)) return "Pages must keep the .mdx extension";
    const fileName = isFile ? (/\.mdx$/i.test(name) ? name.replace(/\.mdx$/i, ".mdx") : `${name}.mdx`) : name;
    const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
    return moveEntry(from, parent + fileName);
  };

  const moveInto = async (from: string, folder: string) => {
    const name = from.slice(from.lastIndexOf("/") + 1);
    const message = await moveEntry(from, folder ? `${folder}/${name}` : name);
    if (message) setError(message);
  };

  /** Drag and drop is easy to do by accident, so it asks first. */
  const dropInto = async (from: string, folder: string) => {
    const ok = await confirm(`Move "${from}" into ${folder ? `"${folder}"` : "the top level"}?\n\nLinks affected by the move are updated.`, { title: "Move", okLabel: "Move", cancelLabel: "Cancel" });
    if (ok) await moveInto(from, folder);
  };

  const deleteEntry = async ({ path: target, kind }: Entry) => {
    try {
      const under = (p: string) => p === target || p.startsWith(`${target}/`);
      const lines = [`Move "${target}" to the Trash?`];
      if (kind === "folder") {
        const count = await api.entryFileCount(target);
        lines.push(count ? `It contains ${count} ${count === 1 ? "file" : "files"}, including any the explorer does not show.` : "The folder is empty.");
      }
      const unsaved = [...buffers.current].filter(([p, b]) => under(p) && b.text !== b.saved).length;
      if (unsaved) lines.push(`Unsaved changes in ${unsaved} open ${unsaved === 1 ? "file" : "files"} will be lost.`);
      if (!(await confirm(lines.join("\n\n"), { title: "Delete", kind: "warning", okLabel: "Move to Trash", cancelLabel: "Cancel" }))) return;
      await api.trashEntry(target);
      dropTabs(tabsRef.current.filter(under));
      setSelectedDir((d) => (d && under(d) ? null : d));
      setWs(await api.listFiles());
    } catch (e) {
      setError(String(e));
    }
  };

  // An open diff follows its file between "staged" and "unstaged", and closes when it is clean.
  useEffect(() => {
    if (!diff || !git.status) return;
    const file = git.status.files.find((f) => f.path === diff.path);
    const has = (staged: boolean) => !!file && (staged ? !!file.staged : !!file.unstaged || file.conflicted);
    if (!has(diff.staged)) setDiff(has(!diff.staged) ? { path: diff.path, staged: !diff.staged } : null);
  }, [git.status]);

  // Blame the text on screen, shortly after it, the file or the repository changes.
  useEffect(() => {
    const buffer = path ? buffers.current.get(path) : undefined;
    if (!blameOn || !path || !buffer || !git.status) return setBlame(null);
    let current = true;
    const timer = window.setTimeout(() => {
      api.gitBlame(path, buffer.text).then(
        (value) => current && setBlame({ path, value }),
        (e) => {
          if (!current) return;
          setBlameOn(false);
          setToast(errorToast(++toastId.current, "Blame failed", e));
        },
      );
    }, blame?.path === path ? 600 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [blameOn, path, typed, git.revision]);

  const succeeded = (title: string, detail: string) => setToast({ id: ++toastId.current, kind: "ok", title, detail });
  const failed = (title: string, error: unknown) => setToast(errorToast(++toastId.current, title, error));
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

  /** Run a git command, then show the new state. A failure is reported in git's own words. */
  const gitAction = async (failure: string, work: () => Promise<void>) => {
    if (gitBusy) return;
    setGitBusy(true);
    setToast(null);
    try {
      await work();
    } catch (e) {
      failed(failure, e);
    } finally {
      await git.refresh();
      setGitBusy(false);
    }
  };

  const stage = (paths: string[]) => void gitAction("Couldn’t stage", () => api.gitStage(paths));
  const unstage = (paths: string[]) => void gitAction("Couldn’t unstage", () => api.gitUnstage(paths));

  const commit = () =>
    void gitAction("Commit failed", async () => {
      const unsaved = [...buffers.current.values()].filter((b) => b.text !== b.saved).length;
      if (
        unsaved &&
        !(await confirm(`${unsaved} open ${unsaved === 1 ? "file has" : "files have"} unsaved changes that will not be in this commit. Commit anyway?`, { title: "Unsaved changes", okLabel: "Commit", cancelLabel: "Cancel" }))
      )
        return;
      const files = git.status?.files.filter((f) => f.staged).length ?? 0;
      const branch = git.status?.branch;
      await api.gitCommit(commitMessage);
      setCommitMessage("");
      succeeded(branch ? `Committed to ${branch}` : "Committed", `${count(files, "file")} changed${git.status?.remotes.length ? " · ready to push" : ""}`);
    });

  /**
   * Bring open files up to date with the disk, closing those that no longer exist. Without
   * `only`, files whose saved contents are unchanged keep their unsaved edits and history;
   * with it, exactly those files are reloaded, dropping whatever was in the editor.
   */
  const reloadFromDisk = async (only?: ReadonlySet<string>) => {
    const gone: string[] = [];
    for (const [p, buffer] of [...buffers.current]) {
      if (only && !only.has(p)) continue;
      try {
        const contents = await api.readFile(p);
        if (contents === (only ? buffer.text : buffer.saved) && contents === buffer.saved) continue;
        editor.current?.forget(String(buffer.version));
        Object.assign(buffer, { text: contents, saved: contents, version: ++nextVersion.current, page: null });
        markDirty(p, false);
      } catch {
        gone.push(p);
      }
    }
    dropTabs(gone);
    setReloads((n) => n + 1);
    setWs(await api.listFiles());
    setPreviewGeneration((n) => n + 1);
    const active = pathRef.current;
    const buffer = active ? buffers.current.get(active) : undefined;
    if (active && buffer) refresh(active, buffer.text);
  };

  /** Revert unstaged changes, after asking: this cannot be undone. */
  const discard = (files: ChangedFile[]) =>
    void gitAction("Couldn’t discard", async () => {
      const status = git.status;
      const targets = files.filter((f) => f.unstaged && !f.conflicted);
      if (!status || !targets.length) return;
      const open = new Set(targets.map((f) => workspacePath(status, f.path)).filter((p): p is string => p !== null));
      const fresh = targets.filter((f) => f.unstaged === "U" || f.unstaged === "A").length;
      const unsaved = [...open].filter((p) => dirtyPaths.has(p)).length;
      const what = targets.length === 1 ? `“${targets[0].path}”` : count(targets.length, "file");
      const lines = [`Discard changes to ${what}? This can’t be undone.`];
      if (fresh) lines.push(fresh === targets.length ? `${targets.length === 1 ? "It is" : "They are"} new to Git, so ${targets.length === 1 ? "it" : "they"} will be moved to the Trash.` : `${count(fresh, "new file")} will be moved to the Trash.`);
      if (unsaved) lines.push(`Unsaved edits in ${count(unsaved, "open file")} will also be lost.`);
      if (!(await confirm(lines.join("\n\n"), { title: "Discard changes", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" }))) return;
      await api.gitDiscard(targets.map((f) => f.path));
      await reloadFromDisk(open);
      succeeded("Discarded changes", count(targets.length, "file"));
    });

  const switchBranch = (name: string) =>
    void gitAction("Couldn’t switch branch", async () => {
      // Saving afterwards would write this branch's text over the other branch's file.
      const unsaved = [...buffers.current].filter(([, b]) => b.text !== b.saved).map(([p]) => p);
      if (unsaved.length) throw `Save or close these files before switching branches: ${unsaved.join(", ")}`;
      await api.gitSwitch(name);
      setDiff(null);
      await reloadFromDisk();
      succeeded(`Switched to ${name}`, "Open files are up to date");
    });

  const createBranch = (name: string) =>
    void gitAction("Couldn’t create the branch", async () => {
      await api.gitCreateBranch(name);
      succeeded(`Created ${name}`, "Switched to the new branch");
    });

  /** A command that talks to the remote, with a spinner on its button meanwhile. */
  const remoteAction = (kind: RemoteActivity, failure: string, work: () => Promise<void>) =>
    void gitAction(failure, async () => {
      setGitActivity(kind);
      try {
        await work();
      } finally {
        setGitActivity(null);
      }
    });

  const fetchRemote = () =>
    remoteAction("fetch", "Fetch failed", async () => {
      await api.gitFetch();
      const behind = (await git.refresh())?.behind ?? 0;
      succeeded("Fetched", behind ? `${count(behind, "commit")} to pull` : "Nothing new to pull");
    });

  const pull = () =>
    remoteAction("pull", "Pull failed", async () => {
      // Pulling changes files; saving afterwards would undo what arrived.
      const unsaved = [...buffers.current].filter(([, b]) => b.text !== b.saved).map(([p]) => p);
      if (unsaved.length) throw `Save or close these files before pulling: ${unsaved.join(", ")}`;
      const from = git.status?.upstream ?? "the remote";
      const received = await api.gitPull();
      if (received) await reloadFromDisk();
      succeeded(received ? `Pulled ${count(received, "commit")}` : "Already up to date", `from ${from} · just now`);
    });

  const push = () =>
    remoteAction("push", "Push failed", async () => {
      const branch = git.status?.branch;
      const { target, published, commits } = await api.gitPush();
      if (published) succeeded(`Published ${branch}`, `to ${target}`);
      else succeeded(`Pushed ${count(commits, "commit")}`, `to ${target}`);
    });

  const openBranches = async () => {
    try {
      setBranches(await api.gitBranches());
    } catch (e) {
      failed("Couldn’t list branches", e);
    }
  };

  /** Save the active file. */
  const save = useCallback(async () => {
    const p = pathRef.current;
    const buffer = p ? buffers.current.get(p) : undefined;
    if (!p || !buffer) return;
    try {
      // Format on save with mdxlint. A formatter failure never blocks saving.
      if (wsRef.current?.formatOnSave) {
        try {
          const source = buffer.text;
          const formatted = await api.formatMdx(p, source);
          // Apply only if this file is still in the editor and wasn't edited meanwhile.
          if (pathRef.current === p && buffer.text === source && formatted !== source) editor.current?.replaceAll(formatted);
          setNotice(null);
        } catch (e) {
          setNotice(`Saved without formatting: ${String(e)}`);
        }
      }
      // The file may have been renamed, moved or deleted while formatting ran.
      const target = [...buffers.current].find(([, b]) => b === buffer)?.[0];
      if (!target) return;
      const written = buffer.text;
      await api.writeFile(target, written);
      buffer.saved = written;
      markDirty(target, buffer.text !== written);
    } catch (e) {
      setError(String(e));
    }
  }, [markDirty]);

  const onChange = (t: string) => {
    const p = pathRef.current;
    const buffer = p ? buffers.current.get(p) : undefined;
    if (!p || !buffer) return;
    buffer.text = t;
    if (blameOn) setTyped((n) => n + 1);
    markDirty(p, t !== buffer.saved);
    refresh(p, t);
  };

  // Closing the window or quitting: ask before throwing away unsaved files.
  useEffect(() => {
    let asking = false;
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      const unsaved = [...buffers.current].filter(([, b]) => b.text !== b.saved).map(([p]) => p);
      if (!unsaved.length) return;
      if (asking) return event.preventDefault();
      asking = true;
      try {
        const list = unsaved.slice(0, 8).join("\n") + (unsaved.length > 8 ? `\n…and ${unsaved.length - 8} more` : "");
        const quit = await confirm(`These files have unsaved changes:\n\n${list}\n\nQuit and discard them?`, {
          title: "Unsaved changes",
          kind: "warning",
          okLabel: "Discard and quit",
          cancelLabel: "Keep editing",
        });
        if (!quit) event.preventDefault();
      } finally {
        asking = false;
      }
    });
    return () => void unlisten.then((f) => f());
  }, []);

  /** Show only the preview, filling the screen. The preview is not reloaded, so components keep their state. */
  const present = async () => {
    if (!pathRef.current || presenting) return;
    setDiff(null);
    setPresenting(true);
    preview.current?.setCursor(0); // no editor cursor outline while presenting
    try {
      const window_ = getCurrentWindow();
      wasFullscreen.current = await window_.isFullscreen();
      if (!wasFullscreen.current) await window_.setFullscreen(true);
    } catch (e) {
      setError(`Could not make the window full screen: ${String(e)}`);
    }
  };

  const stopPresenting = async () => {
    setPresenting(false);
    preview.current?.setCursor(cursor.line);
    requestAnimationFrame(() => editor.current?.focus());
    try {
      if (!wasFullscreen.current) await getCurrentWindow().setFullscreen(false);
    } catch (e) {
      setError(`Could not leave full screen: ${String(e)}`);
    }
  };

  useEffect(() => {
    if (!presenting) return;
    // Slides are driven from the keyboard, so they take it; otherwise it goes to the exit button.
    if (slides) preview.current?.focus();
    else exitButton.current?.focus();
  }, [presenting]);
  useEffect(() => {
    if (presenting && !path) void stopPresenting();
  }, [path]);

  // Escape leaves full screen; ⌘⇧Enter / Ctrl+Shift+Enter toggles it.
  const shortcuts = useRef<{ escape(): boolean; present(): void; slide(e: KeyboardEvent): boolean }>({ escape: () => false, present: () => {}, slide: () => false });
  shortcuts.current = {
    escape: () => {
      // An open palette closes first, and so does the slide overview.
      if (!presenting || palette || branches || moving) return false;
      if (slides?.grid) preview.current?.slide("close-grid");
      else void stopPresenting();
      return true;
    },
    present: () => void (presenting ? stopPresenting() : present()),
    // Keys pressed while a floating control has the keyboard still drive the presentation.
    slide: (e) => {
      if (!presenting || !slides || palette || branches || moving) return false;
      const command = presentationKey(e);
      if (command) preview.current?.slide(command);
      return !!command;
    },
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Escape" && shortcuts.current.escape()) || shortcuts.current.slide(e)) {
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        shortcuts.current.present();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /** Write the page, as it currently looks in the preview, to a PDF the user chooses. */
  const exportPdf = async () => {
    const page = pathRef.current;
    if (!page || exporting) return;
    if (compileError || runtimeError) {
      setToast(errorToast(++toastId.current, "Export failed", "Fix the error shown in the preview first, so the PDF matches the page."));
      return;
    }
    if (slides?.errors.length) {
      setToast(errorToast(++toastId.current, "Export failed", "Fix the slide errors listed in Problems first, so the PDF matches the deck."));
      return;
    }
    setExporting(true);
    try {
      // Captured now, so the PDF shows what was on screen when export was chosen.
      const cut = slides?.overflow.map((slide) => slide + 1) ?? [];
      const snapshot = await preview.current!.snapshot();
      const name = page.slice(page.lastIndexOf("/") + 1).replace(/\.mdx$/i, "");
      const target = await saveDialog({ title: "Export to PDF", defaultPath: `${name}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
      if (!target) return;
      await api.exportPdf(snapshot, name, target);
      const saved = target.slice(target.lastIndexOf("/") + 1);
      const warning = cut.length ? `. Content is cut off on ${cut.length === 1 ? "slide" : "slides"} ${cut.join(", ")}` : "";
      setToast({ id: ++toastId.current, kind: "ok", title: "Exported to PDF", detail: saved + warning });
    } catch (e) {
      setToast(errorToast(++toastId.current, "Export failed", e instanceof Error ? e.message : e));
    } finally {
      setExporting(false);
    }
  };

  // Tab shortcuts: ⌘W / Ctrl+W closes, Ctrl+Tab / Ctrl+Shift+Tab cycles.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const current = pathRef.current;
      const closing = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === "w";
      if (closing && diffRef.current) {
        e.preventDefault();
        setDiff(null);
        return;
      }
      if (!current) return;
      if (closing) {
        e.preventDefault();
        void closeTab(current);
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const open = tabsRef.current;
        const next = open[(open.indexOf(current) + (e.shiftKey ? open.length - 1 : 1)) % open.length];
        if (next && next !== current) activate(next);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activate, closeTab]);

  // `mdx-ide path/to/repo` opens that folder on launch.
  useEffect(() => {
    void api.initialFolder().then((dir) => {
      if (dir) void openFolder(dir);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External changes: refresh the file list; reload open files that have no local edits.
  useEffect(() => {
    if (!ws) return;
    const un = onWorkspaceChanged(async ({ paths, configChanged }) => {
      const info = await api.listFiles();
      setWs(info);
      if (configChanged) setPreviewGeneration((n) => n + 1);
      for (const p of paths) {
        const buffer = buffers.current.get(p);
        if (!buffer || buffer.text !== buffer.saved) continue;
        try {
          const contents = await api.readFile(p);
          if (contents === buffer.text) continue;
          editor.current?.forget(String(buffer.version));
          Object.assign(buffer, { text: contents, saved: contents, version: ++nextVersion.current, page: null });
          setReloads((n) => n + 1);
        } catch {
          // Deleted or renamed on disk: keep the tab so nothing disappears under the user.
        }
      }
      const active = pathRef.current;
      const buffer = active ? buffers.current.get(active) : undefined;
      if (active && buffer && (configChanged || paths.includes(active))) refresh(active, buffer.text);
    });
    return () => void un.then((f) => f());
  }, [ws?.root, refresh]);

  // A restarted preview needs the cursor position again for its outline.
  useEffect(() => {
    preview.current?.setCursor(cursor.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewGeneration]);

  const diagnostics = [...(compileError ? [compileError] : []), ...analysis.diagnostics, ...lintDiags];
  /** The active page as a slide deck, from its last successful compile. */
  const deck = path ? (buffers.current.get(path)?.page?.slides ?? null) : null;
  const slideIssues: SlideIssue[] = [
    ...(slides?.errors ?? []).map((e) => ({ line: deck?.starts[e.slide] ?? 1, message: `Slide ${e.slide + 1}: ${e.message}`, severity: "error" as const })),
    ...(slides?.overflow ?? []).map((slide) => ({ line: deck?.starts[slide] ?? 1, message: `Slide ${slide + 1}: the content does not fit. It scrolls on screen and is cut off in the PDF.`, severity: "warning" as const })),
  ];
  const errors = diagnostics.filter((d) => d.severity === "error").length + (runtimeError ? 1 : 0) + slideIssues.filter((i) => i.severity === "error").length;
  const warnings = [...diagnostics, ...slideIssues].filter((d) => d.severity === "warning").length;
  const problems = errors + warnings;
  const fileName = path ? path.slice(path.lastIndexOf("/") + 1) : null;
  const activeBuffer = path ? buffers.current.get(path) : undefined;
  const dirty = !!path && dirtyPaths.has(path);
  const dirName = path && path.includes("/") ? path.slice(0, path.lastIndexOf("/")).split("/") : [];
  const wsName = ws ? ws.root.split("/").filter(Boolean).pop() : null;
  const showEditor = view !== "preview";
  // The form edits YAML; TOML frontmatter is left to the editor.
  const hasFmPanel = !!path && (analysis.frontmatter?.format as string | undefined) !== "toml";
  const fmErrors = diagnostics.filter((d) => d.source === "frontmatter").length;
  const showPreview = view !== "code";

  const commands: PaletteCommand[] = [
    { id: "open-folder", label: "Open folder…", run: () => void openFolder() },
    { id: "new-file", label: "New file…", run: () => startDraft("file") },
    { id: "new-deck", label: "New slide deck…", run: () => startDraft("file", undefined, true) },
    { id: "new-folder", label: "New folder…", run: () => startDraft("folder") },
    ...(path
      ? [
          { id: "move-file", label: "Move current file…", run: () => setMoving({ path, kind: "file" }) },
          { id: "delete-file", label: "Delete current file…", run: () => void deleteEntry({ path, kind: "file" }) },
        ]
      : []),
    ...(git.status
      ? [
          { id: "git-panel", label: "Git: Show source control", run: () => showSide("git") },
          { id: "git-branch", label: "Git: Switch or create branch…", run: () => void openBranches() },
          ...(git.status.remotes.length
            ? [
                { id: "git-fetch", label: "Git: Fetch", run: fetchRemote },
                { id: "git-pull", label: "Git: Pull", run: pull },
                { id: "git-push", label: "Git: Push", run: push },
              ]
            : []),
          ...(path ? [{ id: "git-blame", label: blameOn ? "Git: Hide blame" : "Git: Show blame", run: () => setBlameOn((b) => !b) }] : []),
          ...git.status.files
            .filter((f) => path && workspacePath(git.status!, f.path) === path)
            .map((f) => ({ id: "git-diff", label: "Git: Show changes in current file", run: () => setDiff({ path: f.path, staged: !f.unstaged && !f.conflicted }) })),
        ]
      : []),
    { id: "toggle-sidebar", label: "Toggle sidebar", hint: "⌘B", run: () => setSidebarOpen((o) => !o) },
    { id: "save", label: "Save file", hint: "⌘S", run: () => void save() },
    { id: "close-tab", label: "Close tab", hint: "⌘W", run: () => path && void closeTab(path) },
    { id: "view-code", label: "View: Code", run: () => setView("code") },
    { id: "view-split", label: "View: Split", run: () => setView("split") },
    { id: "view-preview", label: "View: Preview", run: () => setView("preview") },
    ...(path
      ? [
          { id: "present", label: presenting ? "Preview: Exit full screen" : slides ? "Slides: Present" : "Preview: Full screen", hint: "⌘⇧↵", run: () => shortcuts.current.present() },
          { id: "export-pdf", label: "Export to PDF…", run: () => void exportPdf() },
        ]
      : []),
    { id: "device-desktop", label: "Preview: Desktop width", run: () => setDevice("desktop") },
    { id: "device-mobile", label: "Preview: Mobile width", run: () => setDevice("mobile") },
    { id: "theme-light", label: "Theme: Light", run: () => setTheme("light") },
    { id: "theme-dark", label: "Theme: Dark", run: () => setTheme("dark") },
    { id: "side-files", label: "Show Explorer", run: () => showSide("files") },
    { id: "side-search", label: "Search in files", run: () => showSide("search") },
    { id: "side-components", label: "Show Components", run: () => showSide("components") },
  ];

  const changeCount = git.status?.files.length ?? 0;
  // One toast: at the bottom of the Source Control panel, or of the window when that is hidden.
  const panelShown = sidebarOpen && tab === "git" && !!ws;
  const toastView = <Toast toast={toast} onDismiss={() => setToast(null)} />;

  const railBtn = (t: SideTab, label: string, icon: React.ReactNode) => (
    // Clicking the active icon again hides the sidebar.
    <button type="button" className="rail-btn" aria-label={label} aria-pressed={sidebarOpen && tab === t} onClick={() => (sidebarOpen && tab === t ? setSidebarOpen(false) : showSide(t))}>
      {icon}
    </button>
  );

  return (
    <div className="app">
      <header className="titlebar" inert={presenting}>
        <div className="brand">
          <div className="brand-mark">
            <Icon size={14} sw={2.6}><path d="M4 18V6l5 6 5-6v12" /><path d="M18 9v9" /><path d="M15.5 15.5 18 18l2.5-2.5" /></Icon>
          </div>
          <span className="brand-name">MDX IDE</span>
          {wsName && <span className="brand-ws">/ {wsName}</span>}
        </div>

        <button type="button" className="cmdk" aria-label="Search files and run commands" onClick={() => setPalette("all")}>
          <Icon size={15} sw={2}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></Icon>
          <span>Search files and run commands…</span>
          <kbd>⌘K</kbd>
        </button>

        <div className="title-right">
          <button type="button" className="btn-ghost" onClick={() => void openFolder()}>Open folder…</button>
          <button type="button" className="btn-ghost" onClick={save} disabled={!dirty}>Save</button>
          <div role="group" aria-label="Theme" className="group">
            <button type="button" className="themebtn" aria-label="Light theme" aria-pressed={!dark} onClick={() => setTheme("light")}>
              <Icon size={14} sw={2}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>
            </button>
            <button type="button" className="themebtn" aria-label="Dark theme" aria-pressed={dark} onClick={() => setTheme("dark")}>
              <Icon size={14} sw={2}><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></Icon>
            </button>
          </div>
        </div>
      </header>

      <div className="banners" inert={presenting}>
        {error && (
          <div className="error-bar" role="alert" onClick={() => setError(null)}>
            {error} <span className="dir">(click to dismiss)</span>
          </div>
        )}
        {notice && (
          <div className="error-bar notice" role="status" onClick={() => setNotice(null)}>
            {notice} <span className="dir">(click to dismiss)</span>
          </div>
        )}
        {info && (
          <div className="error-bar info" role="status" onClick={() => setInfo(null)}>
            {info} <span className="dir">(click to dismiss)</span>
          </div>
        )}
        {ws?.configProblems.map((p) => (
          <div key={p} className="error-bar">
            Team config: {p}
          </div>
        ))}
      </div>

      <div className="body">
        <nav className="rail" aria-label="Activity" inert={presenting}>
          {railBtn("files", "Explorer", <Icon><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Icon>)}
          {railBtn("search", "Search", <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>)}
          {railBtn("components", "Components", <Icon><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="3.5" /></Icon>)}
          {railBtn(
            "git",
            changeCount ? `Source control, ${changeCount} ${changeCount === 1 ? "change" : "changes"}` : "Source control",
            <>
              <Icon><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-12 7" /></Icon>
              {changeCount > 0 && <span className="rail-badge" aria-hidden="true">{changeCount > 99 ? "99+" : changeCount}</span>}
            </>,
          )}
        </nav>

        <aside className="sidebar" style={{ width: sidebarWidth }} hidden={!sidebarOpen} inert={presenting} aria-label={SIDE_TITLES[tab]}>
          <div className="side-head">
            <span className="eyebrow">{SIDE_TITLES[tab]}</span>
            <span className="side-actions">
              {ws && tab === "files" && (
                <>
                  {/* preventDefault keeps focus where it is until the name field takes it. */}
                  <button type="button" className="icon-btn" aria-label="New file" title="New file" onMouseDown={(e) => e.preventDefault()} onClick={() => startDraft("file")}>
                    <NewFileIcon />
                  </button>
                  <button type="button" className="icon-btn" aria-label="New folder" title="New folder" onMouseDown={(e) => e.preventDefault()} onClick={() => startDraft("folder")}>
                    <NewFolderIcon />
                  </button>
                </>
              )}
              {ws && tab === "git" && (
                <button type="button" className="icon-btn" aria-label="Refresh status" title="Refresh status" onClick={() => void git.refresh()}>
                  <Icon size={14} sw={2}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></Icon>
                </button>
              )}
              <button type="button" className="icon-btn" aria-label="Collapse sidebar" title="Collapse sidebar (⌘B)" onClick={() => setSidebarOpen(false)}>
                <Icon size={14} sw={2}><path d="m11 17-5-5 5-5M18 17l-5-5 5-5" /></Icon>
              </button>
            </span>
          </div>
          <div className={`side-scroll${tab === "git" ? " fill" : ""}`}>
            {!ws ? (
              <div className="empty">
                <p>Open your docs repository to start.</p>
                <button type="button" className="btn-ghost" onClick={() => void openFolder()}>Open folder…</button>
              </div>
            ) : tab === "files" ? (
              <>
                <Explorer
                  key={ws.root}
                  files={ws.files}
                  dirs={ws.dirs}
                  current={path}
                  selectedDir={selectedDir}
                  dirtyPaths={dirtyPaths}
                  gitMarks={explorerMarks(git.status ?? null)}
                  draft={draft}
                  onOpen={(p) => void openFile(p)}
                  onSelectDir={setSelectedDir}
                  onStartDraft={startDraft}
                  onSubmitDraft={submitDraft}
                  onCancelDraft={() => setDraft(null)}
                  onRename={renameEntry}
                  onDelete={(entry) => void deleteEntry(entry)}
                  onMoveTo={setMoving}
                  onDropInto={(from, folder) => void dropInto(from, folder)}
                />
                <div className="side-section outline">
                  <span className="eyebrow">{deck ? "Slides" : "Outline"}</span>
                </div>
                {deck ? (
                  <SlideList starts={deck.starts} titles={deck.titles} current={slides?.index ?? null} onGoto={(l) => editor.current?.gotoLine(l)} />
                ) : (
                  <Outline items={analysis.outline} onGoto={(l) => editor.current?.gotoLine(l)} />
                )}
              </>
            ) : tab === "git" ? (
              <GitPanel
                status={git.status}
                error={git.error}
                message={commitMessage}
                busy={gitBusy}
                activity={gitActivity}
                selected={diff}
                toast={panelShown ? toastView : null}
                onMessage={setCommitMessage}
                onStage={stage}
                onUnstage={unstage}
                onDiscard={discard}
                onCommit={commit}
                onOpenDiff={setDiff}
                onOpenFile={(file) => {
                  const target = git.status && workspacePath(git.status, file.path);
                  if (target) void openFile(target);
                }}
                canOpenFile={(file, staged) => !!git.status && workspacePath(git.status, file.path)?.endsWith(".mdx") === true && (staged ? file.staged : file.unstaged) !== "D"}
                onBranches={() => void openBranches()}
                onRefresh={() => void git.refresh()}
                onFetch={fetchRemote}
                onPull={pull}
                onPush={push}
              />
            ) : tab === "search" ? (
              <Search onOpen={(p, l, c) => void openFile(p, l, c)} />
            ) : (
              <Palette manifest={ws.manifest} onInsert={(s) => editor.current?.insertSnippet(s)} />
            )}
          </div>
          <div
            className="side-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={sidebarWidth}
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            tabIndex={0}
            title="Drag to resize. Double-click to reset."
            onPointerDown={(e) => {
              const start = sidebarWidth;
              dragFrom(e, (dx) => setSidebarWidth(clampWidth(start + dx)));
            }}
            onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              setSidebarWidth((w) => clampWidth(w + (e.key === "ArrowRight" ? 16 : -16)));
            }}
          />
        </aside>

        <main className="main">
          <div className="tabbar" inert={presenting}>
            <TabStrip tabs={tabs} active={diff ? null : path} dirty={dirtyPaths} onSelect={(p) => (p !== path ? activate(p) : setDiff(null))} onClose={(p) => void closeTab(p)} />
            {hasFmPanel && !diff && (
              <button type="button" className="btn-ghost fm-btn" aria-expanded={fmOpen} aria-controls="frontmatter-panel" onClick={() => setFmOpen((o) => !o)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                  <path d={fmOpen ? "m6 9 6 6 6-6" : "m9 6 6 6-6 6"} />
                </svg>
                Frontmatter
                {fmErrors > 0 && <span className="fm-count">{fmErrors}</span>}
              </button>
            )}
            <div role="group" aria-label="View mode" className="group" hidden={!!diff}>
              {(["code", "split", "preview"] as ViewMode[]).map((m) => (
                <button key={m} type="button" className="seg" aria-pressed={view === m} onClick={() => setView(m)}>
                  {m[0].toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* A full-width row above the split, so the editor and preview columns stay aligned. */}
          {diff && (
            <DiffView
              target={diff}
              revision={git.revision}
              docPath={git.status ? workspacePath(git.status, diff.path) : null}
              mode={diffMode}
              dark={dark}
              previewGeneration={previewGeneration}
              unsaved={!!git.status && dirtyPaths.has(workspacePath(git.status, diff.path) ?? "")}
              onMode={setDiffMode}
              onToggleStage={() => {
                const file = git.status?.files.find((f) => f.path === diff.path);
                if (file) (diff.staged ? unstage : stage)(pathsOf(file));
              }}
              onOpenFile={() => {
                const target = git.status && workspacePath(git.status, diff.path);
                if (target) void openFile(target);
              }}
              onClose={() => setDiff(null)}
            />
          )}

          {hasFmPanel && fmOpen && !diff && (
            <FrontmatterPanel
              key={path}
              schema={fmSchema}
              raw={analysis.frontmatter?.raw ?? ""}
              diagnostics={diagnostics}
              onChange={(r) => editor.current?.setFrontmatter(r)}
              onClose={() => setFmOpen(false)}
            />
          )}

          {/* Hidden, not removed, while a diff is shown: the editor keeps its state. */}
          <div className="split" ref={splitRef} hidden={!!diff}>
            <section className="editor-pane" aria-label="MDX source" hidden={!showEditor} inert={presenting} style={view === "split" ? { flexGrow: split * 100 } : undefined}>
              {path && activeBuffer ? (
                <>
                  <div className="crumbs">
                    {dirName.map((d, i) => (
                      <span key={i} style={{ display: "contents" }}>
                        <span>{d}</span>
                        <span aria-hidden="true">›</span>
                      </span>
                    ))}
                    <span className="cur">{fileName}</span>
                    {git.status && (
                      <>
                        <span className="sp" />
                        <button type="button" className="blame-toggle" aria-pressed={blameOn} title="Show who last changed each line" onClick={() => setBlameOn((b) => !b)}>
                          Blame
                        </button>
                      </>
                    )}
                  </div>
                  <Editor
                    ref={editor}
                    docKey={String(activeBuffer.version)}
                    initialText={activeBuffer.text}
                    diagnostics={diagnostics}
                    manifest={deck ? withSlideTags(ws?.manifest, slideTags) : ws?.manifest}
                    blame={blame?.path === path ? blame.value : null}
                    onChange={onChange}
                    onSave={save}
                    onTopLineChange={(l) => preview.current?.scrollToLine(l)}
                    onImage={async (f) => api.saveAsset(path, f.name, Array.from(new Uint8Array(await f.arrayBuffer())))}
                    onImageError={setError}
                    onCursor={(line, column) => {
                      setCursor({ line, column });
                      preview.current?.setCursor(line, true);
                    }}
                  />
                </>
              ) : (
                <div className="empty center">{ws ? "Select an .mdx file" : "Open a folder to begin"}</div>
              )}
            </section>

            {view === "split" && (
              <div
                className="split-divider"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize editor and preview"
                aria-valuenow={Math.round(split * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                tabIndex={presenting ? -1 : 0}
                title="Drag to resize. Double-click for equal halves."
                onPointerDown={(e) => {
                  const width = splitWidth();
                  const start = clampSplit(split, width);
                  dragFrom(e, (dx) => setSplit(clampSplit(start + dx / width, width)));
                }}
                onDoubleClick={() => setSplit(DEFAULT_SPLIT)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  e.preventDefault();
                  setSplit((s) => clampSplit(s + (e.key === "ArrowRight" ? 0.02 : -0.02), splitWidth()));
                }}
              />
            )}

            <section className={`preview-pane${presenting ? " presenting" : ""}${slides ? " deck" : ""}`} aria-label="Preview" hidden={!showPreview && !presenting} style={view === "split" ? { flexGrow: (1 - split) * 100 } : undefined}>
              <div className="preview-head">
                <span className="live-label"><span className={`live${compileError || runtimeError ? " bad" : ""}`} />{compileError || runtimeError ? "Preview error" : slides ? "Slides" : "Live preview"}</span>
                {view === "split" && !slides && <span className="scroll-synced">Scroll synced</span>}
                <span className="sp" />
                {slides ? (
                  <SlideNav state={slides} onCommand={(command) => preview.current?.slide(command)} />
                ) : (
                  <div role="group" aria-label="Preview width" className="device">
                    <button type="button" aria-label="Desktop width" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")}>
                      <Icon size={14} sw={2}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /></Icon>
                    </button>
                    <button type="button" aria-label="Mobile width" aria-pressed={device === "mobile"} onClick={() => setDevice("mobile")}>
                      <Icon size={14} sw={2}><rect x="7" y="3" width="10" height="18" rx="2" /></Icon>
                    </button>
                  </div>
                )}
                <div className="device">
                  <button type="button" aria-label="Export to PDF" title={slides ? "Export to PDF, one slide per page" : "Export to PDF"} aria-busy={exporting || undefined} disabled={!path || exporting} onClick={() => void exportPdf()}>
                    {exporting ? <span className="sc-spinner" aria-hidden="true" /> : <Icon size={14} sw={2}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14l3 3 3-3" /></Icon>}
                  </button>
                  <button
                    ref={exitButton}
                    type="button"
                    aria-label={presenting ? "Exit full screen" : slides ? "Present slides" : "Full screen preview"}
                    title={presenting ? "Exit full screen (Esc)" : slides ? "Present from this slide (⌘⇧↵)" : "Full screen preview (⌘⇧↵)"}
                    disabled={!path}
                    onClick={() => shortcuts.current.present()}
                  >
                    <Icon size={14} sw={2}><path d={presenting ? "M8 3v5H3M16 21v-5h5M21 8h-5V3M3 16h5v5" : "M3 8V3h5M21 16v5h-5M16 3h5v5M8 21H3v-5"} /></Icon>
                  </button>
                </div>
              </div>
              {/* Slides are scaled to fit, so the device widths do not apply to them. */}
              <div className={`preview-body ${slides ? "desktop" : device}`}>
                {(compileError || runtimeError) && (
                  <div className="overlay" role="alert">
                    <strong>{compileError ? "MDX error" : "Render error"}</strong>
                    {compileError?.range && (
                      <button type="button" className="overlay-line" onClick={() => editor.current?.gotoLine(compileError.range!.start.line, compileError.range!.start.column)}>
                        line {compileError.range.start.line}
                      </button>
                    )}
                    <pre>{compileError?.message ?? runtimeError}</pre>
                    {compileError && <span className="dim">Showing the last successful render.</span>}
                  </div>
                )}
                <Preview
                  key={previewGeneration}
                  ref={preview}
                  dark={dark}
                  onLoadError={(m) => setError(`Preview could not load your components: ${m}`)}
                  onRuntimeError={setRuntimeError}
                  onSlides={setSlides}
                  presenting={presenting}
                  onShortcut={(key) => (key === "escape" ? void shortcuts.current.escape() : shortcuts.current.present())}
                  onSourceClick={(l) => !presenting && editor.current?.gotoLine(l)}
                />
              </div>
            </section>
          </div>
        </main>
      </div>

      <section className="bottom" aria-label="Problems" inert={presenting} style={{ height: problemsOpen ? problemsHeight : undefined }}>
        {problemsOpen && (
          <div
            className="resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize problems panel"
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") setProblemsHeight((h) => clampHeight(h + 24));
              else if (e.key === "ArrowDown") setProblemsHeight((h) => clampHeight(h - 24));
            }}
          />
        )}
        <div className="bottom-head">
          <button type="button" className="fm-toggle" aria-expanded={problemsOpen} onClick={() => setProblemsOpen(!problemsOpen)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <path d={problemsOpen ? "m6 9 6 6 6-6" : "m6 15 6-6 6 6"} />
            </svg>
            <span className="eyebrow">Problems</span>
            {problems > 0 && <span className={`fm-count${errors ? "" : " warn"}`}>{problems}</span>}
          </button>
          <span className="sp" />
          {problemsOpen && (
            <button
              type="button"
              className="icon-btn"
              aria-label={problemsHeight >= maxProblemsHeight() ? "Restore panel size" : "Maximize problems panel"}
              onClick={() => setProblemsHeight(problemsHeight >= maxProblemsHeight() ? DEFAULT_PROBLEMS_HEIGHT : maxProblemsHeight())}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {problemsHeight >= maxProblemsHeight() ? <path d="M8 3v5H3M16 21v-5h5M21 8h-5V3M3 16h5v5" /> : <path d="M3 8V3h5M21 16v5h-5M16 3h5v5M8 21H3v-5" />}
              </svg>
            </button>
          )}
          <button type="button" className="icon-btn" aria-label={problemsOpen ? "Minimize problems panel" : "Expand problems panel"} onClick={() => setProblemsOpen(!problemsOpen)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d={problemsOpen ? "M5 12h14" : "M12 5v14M5 12h14"} />
            </svg>
          </button>
        </div>
        {problemsOpen && (
          <Problems diagnostics={diagnostics} runtimeError={runtimeError} slideIssues={slideIssues} note={lintError ? `mdxlint rules unavailable: ${lintError}` : null} onGoto={(l, c) => editor.current?.gotoLine(l, c)} />
        )}
      </section>

      {palette && ws && (
        <CommandPalette
          mode={palette}
          files={ws.files}
          commands={commands}
          onOpenFile={(p) => void openFile(p)}
          onClose={() => {
            setPalette(null);
            requestAnimationFrame(() => editor.current?.focus());
          }}
        />
      )}

      {branches && (
        <CommandPalette
          mode="all"
          files={[]}
          placeholder="Switch to a branch, or type a new name…"
          badge="BR"
          commands={branches.map((b) => ({ id: `branch:${b.name}`, label: b.name, hint: b.current ? "current" : b.remote ? "remote" : undefined, run: () => !b.current && switchBranch(b.name) }))}
          extra={(query) => (query && !branches.some((b) => b.name === query) ? { id: "branch:new", label: `Create branch “${query}”`, hint: "from the current commit", run: () => createBranch(query) } : null)}
          onOpenFile={() => {}}
          onClose={() => setBranches(null)}
        />
      )}

      {moving && ws && (
        <CommandPalette
          mode="all"
          files={[]}
          placeholder={`Move ${moving.path} to folder…`}
          badge="DIR"
          commands={["", ...ws.dirs]
            .filter((folder) => canMove(moving.path, folder))
            .map((folder) => ({ id: `dir:${folder}`, label: folder || "(top level)", run: () => void moveInto(moving.path, folder) }))}
          onOpenFile={() => {}}
          onClose={() => setMoving(null)}
        />
      )}

      {!panelShown && <div className="toast-floating">{toastView}</div>}

      <footer className="status" inert={presenting}>
        {git.status && (
          <button type="button" className="status-branch" aria-label={`Branch ${git.status.branch ?? git.status.head}. Switch or create a branch`} title="Switch or create a branch" disabled={gitBusy} onClick={() => void openBranches()}>
            <Icon size={13} sw={2}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-12 7" /></Icon>
            <span>{git.status.branch ?? git.status.head}</span>
          </button>
        )}
        <span><span className={`ok-dot${errors ? " bad" : ""}`} />{problems} {problems === 1 ? "problem" : "problems"}</span>
        {path && <span>Ln {cursor.line}, Col {cursor.column}</span>}
        {path && <span>MDX · UTF-8 · LF</span>}
        {analysis.frontmatter && <span>frontmatter ({analysis.frontmatter.format})</span>}
        <span className="sp" />
        <span className="mono">{analysis.wordCount} words</span>
      </footer>
    </div>
  );
}
