import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "../api";
import { describe } from "../git/model";

export type EntryKind = "file" | "folder";
/** A new file or folder being named inside `parent` ("" = workspace root). */
export interface Draft {
  kind: EntryKind;
  parent: string;
  /** A new page that starts as a slide deck. */
  slides?: boolean;
}

interface Props {
  files: FileEntry[];
  dirs: string[];
  current: string | null;
  /** The folder new entries go into; null follows the open file. */
  selectedDir: string | null;
  dirtyPaths?: ReadonlySet<string>;
  /** Git change letters by path. */
  gitMarks?: ReadonlyMap<string, string>;
  draft: Draft | null;
  onOpen(path: string): void;
  onSelectDir(path: string | null): void;
  onStartDraft(kind: EntryKind, parent: string): void;
  /** Resolves to an error message, or null once the entry exists. */
  onSubmitDraft(name: string): Promise<string | null>;
  onCancelDraft(): void;
  /** Resolves to an error message, or null once renamed. */
  onRename(path: string, name: string): Promise<string | null>;
  onDelete(entry: Entry): void;
  /** Open the "Move to…" folder picker. */
  onMoveTo(entry: Entry): void;
  /** Drag and drop onto a folder ("" = top level). */
  onDropInto(path: string, folder: string): void;
}

/** An existing file or folder. */
export interface Entry {
  path: string;
  kind: EntryKind;
}

const DRAG_TYPE = "application/x-mdx-ide-path";
/** Moving into itself or into the folder it is already in does nothing. */
export const canMove = (path: string, folder: string) => folder !== parentOf(path) && folder !== path && !folder.startsWith(`${path}/`);

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: FileEntry[];
}

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const ancestorsOf = (dir: string) => dir.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));

function buildTree(files: FileEntry[], dirs: string[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  const byPath = new Map<string, Folder>([["", root]]);
  const folder = (path: string): Folder => {
    let node = byPath.get(path);
    if (!node) {
      node = { name: baseName(path), path, folders: [], files: [] };
      byPath.set(path, node);
      folder(parentOf(path)).folders.push(node);
    }
    return node;
  };
  dirs.forEach(folder);
  for (const f of files) folder(parentOf(f.path)).files.push(f);
  for (const node of byPath.values()) {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.path.localeCompare(b.path));
  }
  return root;
}

export const NewFileIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6" />
  </svg>
);
export const NewFolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5" />
  </svg>
);
const Chevron = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d={open ? "m6 9 6 6 6-6" : "m9 6 6 6-6 6"} />
  </svg>
);

export function Explorer(props: Props) {
  const { files, dirs, current, selectedDir, dirtyPaths, draft } = props;
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const query = filter.trim().toLowerCase();
  const [renaming, setRenaming] = useState<Entry | null>(null);
  const [menu, setMenu] = useState<{ entry: Entry; x: number; y: number; opener: HTMLElement | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);

  const tree = useMemo(
    () => (query ? buildTree(files.filter((f) => f.path.toLowerCase().includes(query)), []) : buildTree(files, dirs)),
    [files, dirs, query],
  );

  const reveal = (dir: string) =>
    setClosed((c) => {
      const next = new Set(c);
      for (const a of ancestorsOf(dir)) next.delete(a);
      return next.size === c.size ? c : next;
    });
  // Make sure the open file, and the place a new entry is being named, are visible.
  useEffect(() => {
    if (current) reveal(parentOf(current));
  }, [current]);
  useEffect(() => {
    if (draft) {
      setRenaming(null);
      setFilter("");
      reveal(draft.parent);
    }
  }, [draft]);

  const toggle = (path: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const indent = (depth: number) => 10 + depth * 20;

  const openMenu = (entry: Entry, x: number, y: number, opener: HTMLElement | null) => setMenu({ entry, x, y, opener });
  const startRename = (entry: Entry) => {
    props.onCancelDraft();
    setRenaming(entry);
  };

  /** Context menu, keyboard shortcuts and dragging, shared by file and folder rows. */
  const rowProps = (entry: Entry) => ({
    draggable: true,
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
      openMenu(entry, e.clientX, e.clientY, e.currentTarget);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        startRename(entry);
      } else if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) {
        e.preventDefault();
        props.onDelete(entry);
      }
    },
    onDragStart: (e: React.DragEvent) => {
      dragged.current = entry.path;
      e.dataTransfer.setData(DRAG_TYPE, entry.path);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => {
      dragged.current = null;
      setDropTarget(null);
    },
  });

  const dropProps = (folder: string) => ({
    onDragOver: (e: React.DragEvent) => {
      e.stopPropagation(); // the innermost folder wins
      if (dragged.current === null || !canMove(dragged.current, folder)) return setDropTarget(null);
      e.preventDefault();
      setDropTarget(folder);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const path = e.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(null);
      if (path && canMove(path, folder)) props.onDropInto(path, folder);
    },
  });

  const moreButton = (entry: Entry) => (
    <button
      type="button"
      className="icon-btn"
      aria-label={`More actions for ${entry.path}`}
      aria-haspopup="menu"
      title="Rename, move, delete"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(entry, r.left, r.bottom + 2, e.currentTarget);
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="19" cy="12" r="1.8" />
      </svg>
    </button>
  );

  const renameField = (entry: Entry, depth: number) => (
    <NameField
      key={`rename:${entry.path}`}
      kind={entry.kind}
      initial={baseName(entry.path)}
      label={`Rename ${entry.path}`}
      indent={indent(depth)}
      onSubmit={async (name) => {
        const error = await props.onRename(entry.path, name);
        if (!error) setRenaming(null);
        return error;
      }}
      onCancel={() => setRenaming(null)}
    />
  );

  const render = (node: Folder, depth: number): React.ReactNode => (
    <>
      {draft && draft.parent === node.path && (
        <NameField
          key={`${draft.kind}:${draft.parent}:${draft.slides ?? false}`}
          kind={draft.kind}
          label={`New ${draft.slides ? "slide deck" : draft.kind} name${draft.parent ? ` in ${draft.parent}` : ""}`}
          placeholder={draft.slides ? "Slide deck name" : undefined}
          indent={indent(depth)}
          onSubmit={props.onSubmitDraft}
          onCancel={props.onCancelDraft}
        />
      )}
      {node.folders.map((d) => {
        const open = !!query || !closed.has(d.path);
        const entry: Entry = { path: d.path, kind: "folder" };
        return (
          <div key={d.path} className={`tree-group${dropTarget === d.path ? " drop" : ""}`} {...dropProps(d.path)}>
            {renaming?.path === d.path ? (
              renameField(entry, depth)
            ) : (
              <div className="tree-row">
                <button
                  type="button"
                  className={`tree${selectedDir === d.path ? " selected" : ""}`}
                  style={{ paddingLeft: indent(depth) }}
                  aria-expanded={open}
                  title={d.path}
                  onClick={() => {
                    props.onSelectDir(d.path);
                    toggle(d.path);
                  }}
                  {...rowProps(entry)}
                >
                  <Chevron open={open} />
                  <span className="name">{d.name}</span>
                </button>
                <span className="tree-actions">
                  <button type="button" className="icon-btn" aria-label={`New file in ${d.path}`} title="New file" onMouseDown={(e) => e.preventDefault()} onClick={() => props.onStartDraft("file", d.path)}>
                    <NewFileIcon />
                  </button>
                  <button type="button" className="icon-btn" aria-label={`New folder in ${d.path}`} title="New folder" onMouseDown={(e) => e.preventDefault()} onClick={() => props.onStartDraft("folder", d.path)}>
                    <NewFolderIcon />
                  </button>
                  {moreButton(entry)}
                </span>
              </div>
            )}
            {open && render(d, depth + 1)}
          </div>
        );
      })}
      {node.files.map((f) => {
        const ext = baseName(f.path).split(".").pop()!.toLowerCase();
        const entry: Entry = { path: f.path, kind: "file" };
        const mark = props.gitMarks?.get(f.path);
        if (renaming?.path === f.path) return renameField(entry, depth);
        return (
          <div key={f.path} className="tree-row file">
            <button
              type="button"
              className={`tree${f.path === current ? " active" : ""}`}
              style={{ paddingLeft: indent(depth) }}
              title={f.path}
              onClick={() => {
                props.onSelectDir(null);
                props.onOpen(f.path);
              }}
              {...rowProps(entry)}
            >
              <span className={`badge-ext ${ext}`}>{ext.toUpperCase()}</span>
              <span className="name">{baseName(f.path)}</span>
              {dirtyPaths?.has(f.path) && <span className="dot" role="img" aria-label="Unsaved changes" />}
              {mark && (
                <span className={`git-letter tail letter-${mark === "!" ? "conflict" : mark}`} role="img" aria-label={`Git: ${describe(mark)}`} title={describe(mark)}>
                  {mark}
                </span>
              )}
            </button>
            <span className="tree-actions">{moreButton(entry)}</span>
          </div>
        );
      })}
    </>
  );

  const empty = !draft && tree.folders.length === 0 && tree.files.length === 0;
  return (
    <div className="panel">
      <input className="panel-filter" aria-label="Filter files" placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {/* Clicking the empty space below the entries targets the workspace root; so does dropping there. */}
      <div className={`tree-list explorer${dropTarget === "" ? " drop" : ""}`} onClick={(e) => e.target === e.currentTarget && props.onSelectDir("")} {...dropProps("")}>
        {render(tree, 0)}
        {empty && <div className="empty">{query ? "No matching files" : "No .mdx files"}</div>}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.entry.path}`}
          items={[
            ...(menu.entry.kind === "folder"
              ? [
                  { label: "New file", run: () => props.onStartDraft("file", menu.entry.path) },
                  { label: "New folder", run: () => props.onStartDraft("folder", menu.entry.path) },
                ]
              : []),
            { label: "Rename", hint: "F2", run: () => startRename(menu.entry) },
            { label: "Move to…", run: () => props.onMoveTo(menu.entry) },
            { label: "Delete", hint: /Mac/i.test(navigator.platform) ? "⌘⌫" : "Del", danger: true, run: () => props.onDelete(menu.entry) },
          ]}
          onClose={(restoreFocus) => {
            if (restoreFocus) menu.opener?.focus();
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  run(): void;
}

/** Right-click / "more" menu. Arrow keys move, Escape or clicking elsewhere closes. */
function ContextMenu({ x, y, label, items, onClose }: { x: number; y: number; label: string; items: MenuItem[]; onClose(restoreFocus: boolean): void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    // Keep the whole menu on screen.
    const { width, height } = menu.current!.getBoundingClientRect();
    setPosition({ left: Math.max(4, Math.min(x, innerWidth - width - 4)), top: Math.max(4, Math.min(y, innerHeight - height - 4)) });
    menu.current!.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [x, y]);

  useEffect(() => {
    const outside = (e: Event) => !menu.current?.contains(e.target as Node) && close.current(false);
    const away = () => close.current(false);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", away);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", away);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = Array.from(menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(at + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  };

  return (
    <div className="context-menu" role="menu" aria-label={label} ref={menu} style={position} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? "danger" : undefined}
          onClick={() => {
            onClose(true);
            item.run();
          }}
        >
          <span>{item.label}</span>
          {item.hint && <kbd>{item.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}

/** Inline name field for new and renamed entries. Enter confirms, Escape or leaving cancels. */
interface NameFieldProps {
  kind: EntryKind;
  label: string;
  indent: number;
  initial?: string;
  placeholder?: string;
  onSubmit(name: string): Promise<string | null>;
  onCancel(): void;
}

function NameField({ kind, label, indent, initial = "", placeholder, onSubmit, onCancel }: NameFieldProps) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  // Focus after a menu or the command palette (if either opened this) has handed focus back.
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const el = input.current;
        if (!el) return;
        el.focus();
        // Renaming a page selects the name but not ".mdx".
        const dot = kind === "file" ? el.value.lastIndexOf(".") : -1;
        el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [kind]);

  const submit = async () => {
    if (busy.current) return;
    if (!name.trim() || name.trim() === initial) return onCancel();
    busy.current = true;
    const message = await onSubmit(name.trim());
    busy.current = false;
    if (message) setError(message);
  };

  return (
    <div className="tree-draft">
      <div className="tree-input" style={{ paddingLeft: indent }}>
        {kind === "file" ? <NewFileIcon /> : <NewFolderIcon />}
        <input
          ref={input}
          aria-label={label}
          aria-invalid={!!error}
          placeholder={placeholder ?? (kind === "file" ? "page-name.mdx" : "folder-name")}
          spellCheck={false}
          autoCapitalize="off"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => !busy.current && onCancel()}
        />
      </div>
      {error && <div className="tree-error" role="alert">{error}</div>}
    </div>
  );
}
