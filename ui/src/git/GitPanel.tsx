// The Source Control panel. Layout and states follow the source control design handoff.

import { useRef, useState } from "react";
import type { ChangedFile, GitStatus } from "../api";
import { describe, letterFor, type DiffTarget } from "./model";

/** "Write with AI" waits for an AI integration. Its space in the commit box is kept. */
const AI_COMMIT_MESSAGES = false;

export type RemoteActivity = "fetch" | "pull" | "push";

interface Props {
  /** null: not a repository; undefined: still loading. */
  status: GitStatus | null | undefined;
  /** The status could not be read. */
  error: string | null;
  message: string;
  busy: boolean;
  /** The remote command that is running, shown as a spinner on its button. */
  activity: RemoteActivity | null;
  selected: DiffTarget | null;
  /** The notification, pinned to the bottom of the panel. */
  toast: React.ReactNode;
  onMessage(message: string): void;
  onStage(paths: string[]): void;
  onUnstage(paths: string[]): void;
  /** Asks for confirmation before reverting. */
  onDiscard(files: ChangedFile[]): void;
  onCommit(): void;
  onOpenDiff(target: DiffTarget): void;
  /** Open the file in the editor; false from `canOpenFile` hides the button. */
  onOpenFile(file: ChangedFile): void;
  canOpenFile(file: ChangedFile, staged: boolean): boolean;
  onBranches(): void;
  onRefresh(): void;
  onFetch(): void;
  onPull(): void;
  onPush(): void;
}

/** A rename is two paths in git's eyes: both need staging or unstaging. */
export const pathsOf = (f: ChangedFile) => (f.origPath ? [f.origPath, f.path] : [f.path]);

const ICONS = {
  branch: "M6 7v10M18 10c0 4-6 3-12 7M4 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M4 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0M16 8a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
  down: "m6 9 6 6 6-6",
  right: "m9 6 6 6-6 6",
  fetch: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  pull: "M12 5v14M6 13l6 6 6-6",
  push: "M12 19V5M6 11l6-6 6 6",
  check: "m5 12 5 5 9-10",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  discard: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
};

export function Icon({ name, size = 14, width = 2.2 }: { name: keyof typeof ICONS; size?: number; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function GitPanel(props: Props) {
  const { status, error, message, busy, activity, selected } = props;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const box = useRef<HTMLTextAreaElement>(null);
  const mac = /Mac/i.test(navigator.platform);

  const frame = (content: React.ReactNode) => (
    <div className="sc">
      <div className="sc-scroll">{content}</div>
      {props.toast}
    </div>
  );

  if (status === undefined) return frame(<div className="empty">{error ?? "Reading repository…"}</div>);
  if (status === null) {
    return frame(
      <div className="empty">
        <p>This folder is not in a Git repository.</p>
        <p>
          Run <code>git init</code> in it, then press Refresh.
        </p>
        <button type="button" className="btn-ghost" onClick={props.onRefresh}>Refresh</button>
      </div>,
    );
  }

  const conflicts = status.files.filter((f) => f.conflicted);
  const staged = status.files.filter((f) => f.staged);
  const changes = status.files.filter((f) => f.unstaged);
  const branch = status.branch ?? `detached at ${status.head}`;
  const repoName = status.repoRoot.split("/").filter(Boolean).pop();

  const hasRemote = status.remotes.length > 0;
  const tracking = !!status.upstream && !status.upstreamGone;
  const publish = hasRemote && !tracking;
  const pushable = hasRemote && !!status.branch && !!status.head && (publish || status.ahead > 0);

  const committable = staged.length > 0 && conflicts.length === 0;
  const commit = () => {
    if (!committable || busy) return;
    // An empty message blocks the commit and puts the cursor where it is needed.
    if (!message.trim()) box.current?.focus();
    else props.onCommit();
  };

  const syncButton = (kind: RemoteActivity, label: string, enabled: boolean, title: string, run: () => void) => (
    <button
      type="button"
      className={`sc-sync-btn ${kind}${activity === kind ? " running" : ""}`}
      disabled={busy || !enabled}
      aria-busy={activity === kind || undefined}
      title={title}
      onClick={run}
    >
      {activity === kind ? <span className="sc-spinner" aria-hidden="true" /> : <Icon name={kind} size={13} width={kind === "push" && enabled ? 2.2 : 2} />}
      {label}
    </button>
  );

  const action = (label: string, icon: keyof typeof ICONS, run: () => void, size = 14, disabled = busy) => (
    <button type="button" className="sc-action" aria-label={label} title={label} disabled={disabled} onClick={run}>
      <Icon name={icon} size={size} />
    </button>
  );

  const section = (id: "conflicts" | "staged" | "changes", title: string, files: ChangedFile[], headerActions: React.ReactNode) => {
    const open = !collapsed.has(id);
    const isStaged = id === "staged";
    const names = files.map((f) => baseName(f.path));
    return (
      <section className={`sc-section ${id}`} aria-label={title}>
        <div className="sc-section-head">
          <button
            type="button"
            className="sc-section-toggle"
            aria-expanded={open}
            onClick={() =>
              setCollapsed((c) => {
                const next = new Set(c);
                if (!next.delete(id)) next.add(id);
                return next;
              })
            }
          >
            <Icon name={open ? "down" : "right"} size={11} width={2.6} />
            <span className="eyebrow">{title}</span>
            <span className="sc-count">{files.length}</span>
          </button>
          {headerActions}
        </div>
        {open &&
          (files.length === 0 ? (
            <div className="sc-clean">
              <Icon name="check" width={2.4} />
              Working tree clean
            </div>
          ) : (
            <ul className="sc-files">
              {files.map((f, i) => {
                const letter = letterFor(f, isStaged);
                const name = names[i];
                const folder = f.path.slice(0, -name.length - 1);
                const active = selected?.path === f.path && selected.staged === isStaged;
                const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
                return (
                  <li className={`sc-row${active ? " active" : ""}`} key={f.path}>
                    <button type="button" className="sc-file" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path} onClick={() => props.onOpenDiff({ path: f.path, staged: isStaged })}>
                      <span className="sc-badge">{extension.slice(0, 4).toUpperCase() || "FILE"}</span>
                      <span className="sc-name">{name}</span>
                      {/* The folder only matters when two files share a name. */}
                      {folder && names.indexOf(name) !== names.lastIndexOf(name) && <span className="sc-folder">{folder}</span>}
                    </button>
                    <span className="sc-actions">
                      {props.canOpenFile(f, isStaged) && action("Open file", "file", () => props.onOpenFile(f), 13, false)}
                      {id === "changes" && action("Discard changes", "discard", () => props.onDiscard([f]), 13)}
                      {isStaged
                        ? action("Unstage file", "minus", () => props.onUnstage(pathsOf(f)))
                        : action(f.conflicted ? "Stage file (mark resolved)" : "Stage file", "plus", () => props.onStage(pathsOf(f)))}
                    </span>
                    <span className="sc-letter" data-letter={letter} role="img" aria-label={describe(letter)} title={describe(letter)}>
                      {letter}
                    </span>
                  </li>
                );
              })}
            </ul>
          ))}
      </section>
    );
  };

  return frame(
    <>
      <div className="sc-remote">
        <button
          type="button"
          className="sc-branch"
          aria-label={`Switch branch, current branch ${branch}${tracking ? `, ${status.behind} behind, ${status.ahead} ahead` : publish ? ", not published" : ""}`}
          disabled={busy}
          onClick={props.onBranches}
        >
          <span className="sc-branch-icon"><Icon name="branch" size={15} width={2} /></span>
          <span className="sc-branch-name">{branch}</span>
          <span className="sc-track">{tracking ? `↓${status.behind} ↑${status.ahead}` : publish ? "not published" : ""}</span>
          <span className="sc-chevron"><Icon name="down" size={12} width={2.4} /></span>
        </button>
        <div className="sc-sync" role="group" aria-label="Sync with remote">
          {syncButton("fetch", "Fetch", hasRemote, hasRemote ? "Check the remote for new commits" : "No remote", props.onFetch)}
          {syncButton("pull", "Pull", tracking && !!status.branch, tracking ? `Fast-forward from ${status.upstream}` : "No upstream branch to pull from", props.onPull)}
          {syncButton(
            "push",
            publish ? "Publish" : status.ahead > 0 && tracking ? `Push ${status.ahead}` : "Push",
            pushable,
            !hasRemote ? "No remote" : publish ? "Upload this branch and track it" : status.ahead > 0 ? `Upload to ${status.upstream}` : "Nothing to push",
            props.onPush,
          )}
        </div>
        <span className="visually-hidden" role="status">{activity ? `${activity === "push" ? "Pushing" : activity === "pull" ? "Pulling" : "Fetching"}…` : ""}</span>
      </div>
      {!hasRemote && (
        <div className="sc-note">
          No remote. Add one with <code>git remote add origin &lt;url&gt;</code>.
        </div>
      )}
      {status.workspacePrefix && <div className="sc-note">Showing the whole repository “{repoName}”, which contains this folder.</div>}
      {error && <div className="sc-note sc-note-error" role="alert">{error}</div>}

      <div className="sc-commit">
        <div className="sc-box">
          <textarea
            ref={box}
            aria-label="Commit message"
            placeholder="Commit message"
            rows={2}
            value={message}
            onChange={(e) => props.onMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              }
            }}
          />
          <div className="sc-toolbar">
            <button type="button" className={`sc-ai${AI_COMMIT_MESSAGES ? "" : " unavailable"}`} disabled={!AI_COMMIT_MESSAGES}>
              <Icon name="sparkle" size={12} />
              Write with AI
            </button>
            <kbd className="sc-key" title={`${mac ? "⌘" : "Ctrl+"}Enter commits`}>{mac ? "⌘↵" : "Ctrl ↵"}</kbd>
          </div>
        </div>
        <button type="button" className={`sc-commit-btn${committable ? " ready" : ""}`} disabled={!committable || busy} onClick={commit}>
          {committable ? (
            <>
              <Icon name="check" width={2.4} />
              <span>
                Commit {staged.length} {staged.length === 1 ? "file" : "files"}
                {status.branch && ` to ${status.branch}`}
              </span>
            </>
          ) : conflicts.length ? (
            "Resolve conflicts to commit"
          ) : (
            "Stage a file to commit"
          )}
        </button>
      </div>

      {conflicts.length > 0 && section("conflicts", "Conflicts", conflicts, null)}
      {staged.length > 0 && section("staged", "Staged", staged, action("Unstage all", "minus", () => props.onUnstage(staged.flatMap(pathsOf))))}
      {section(
        "changes",
        "Changes",
        changes,
        changes.length > 0 && (
          <>
            {action("Discard all changes", "discard", () => props.onDiscard(changes), 13)}
            {action("Stage all changes", "plus", () => props.onStage(changes.flatMap(pathsOf)))}
          </>
        ),
      )}
    </>,
  );
}
