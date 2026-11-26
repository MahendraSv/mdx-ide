import type { ChangedFile, GitStatus } from "../api";
import { describe, letterFor, type DiffTarget } from "./model";

interface Props {
  /** null: not a repository; undefined: still loading. */
  status: GitStatus | null | undefined;
  error: string | null;
  message: string;
  busy: boolean;
  /** What a running network command is doing, e.g. "Pushing…". */
  activity: string | null;
  selected: DiffTarget | null;
  onMessage(message: string): void;
  onStage(paths: string[]): void;
  onUnstage(paths: string[]): void;
  onCommit(): void;
  onOpen(target: DiffTarget): void;
  onBranches(): void;
  onRefresh(): void;
  onFetch(): void;
  onPull(): void;
  onPush(): void;
}

/** A rename is two paths in git's eyes: both need staging or unstaging. */
export const pathsOf = (f: ChangedFile) => (f.origPath ? [f.origPath, f.path] : [f.path]);

const Plus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const Minus = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14" />
  </svg>
);

export function GitPanel(props: Props) {
  const { status, error, message, busy, selected } = props;
  if (status === undefined) return <div className="empty">{error ?? "Reading repository…"}</div>;
  if (status === null) {
    return (
      <div className="empty">
        <p>This folder is not in a Git repository.</p>
        <p>
          Run <code>git init</code> in it, then press Refresh.
        </p>
        <button type="button" className="btn-ghost" onClick={props.onRefresh}>Refresh</button>
      </div>
    );
  }

  const conflicts = status.files.filter((f) => f.conflicted);
  const staged = status.files.filter((f) => f.staged);
  const changes = status.files.filter((f) => f.unstaged);
  const canCommit = !busy && staged.length > 0 && conflicts.length === 0 && message.trim() !== "";
  // Say why the button is disabled.
  const blocker = conflicts.length
    ? "Resolve each conflict, then stage the file."
    : staged.length === 0
      ? changes.length
        ? "Nothing is staged. Press + next to a file under Changes, then commit."
        : null
      : message.trim() === ""
        ? "Enter a commit message."
        : null;
  const repoName = status.repoRoot.split("/").filter(Boolean).pop();
  const tracking = !!status.upstream && !status.upstreamGone;
  const publish = !tracking;
  const canPush = !busy && !!status.branch && !!status.head && (publish || status.ahead > 0);

  const section = (title: string, files: ChangedFile[], isStaged: boolean) => {
    if (!files.length) return null;
    const act = isStaged ? props.onUnstage : props.onStage;
    const verb = isStaged ? "Unstage" : "Stage";
    return (
      <section className="git-section" aria-label={title}>
        <div className="git-section-head">
          <span className="eyebrow">{title}</span>
          <span className="git-count">{files.length}</span>
          <span className="sp" />
          <button type="button" className="icon-btn" aria-label={`${verb} all in ${title}`} title={`${verb} all`} disabled={busy} onClick={() => act(files.flatMap(pathsOf))}>
            {isStaged ? <Minus /> : <Plus />}
          </button>
        </div>
        <div className="tree-list">
          {files.map((f) => {
            const letter = letterFor(f, isStaged);
            const slash = f.path.lastIndexOf("/");
            const active = selected?.path === f.path && selected.staged === isStaged;
            return (
              <div className="tree-row git-row" key={f.path}>
                <button type="button" className={`tree${active ? " active" : ""}`} title={f.origPath ? `${f.origPath} → ${f.path}` : f.path} onClick={() => props.onOpen({ path: f.path, staged: isStaged })}>
                  <span className={`git-letter letter-${letter === "!" ? "conflict" : letter}`} role="img" aria-label={describe(letter)}>{letter}</span>
                  <span className="name">
                    {f.path.slice(slash + 1)}
                    {slash >= 0 && <span className="dim"> {f.path.slice(0, slash)}</span>}
                  </span>
                </button>
                <span className="tree-actions">
                  <button type="button" className="icon-btn" aria-label={`${verb} ${f.path}`} title={f.conflicted ? "Stage (mark resolved)" : verb} disabled={busy} onClick={() => act(pathsOf(f))}>
                    {isStaged ? <Minus /> : <Plus />}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="git-panel">
      <div className="git-branch">
        <button type="button" className="chip-pill" aria-label={`Current branch ${status.branch ?? status.head}. Switch or create a branch`} onClick={props.onBranches} disabled={busy}>
          {status.branch ?? `detached at ${status.head}`}
        </button>
        <span className="sp" />
        <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={props.onRefresh}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-.6 4M20 4v7h-7" />
          </svg>
        </button>
      </div>
      {status.remotes.length === 0 ? (
        <div className="git-note">
          No remote. Add one in a terminal with <code>git remote add origin &lt;url&gt;</code>.
        </div>
      ) : (
        <div className="git-sync" role="group" aria-label="Remote">
          <button type="button" className="btn-ghost" disabled={busy} title="Check the remote for new commits" onClick={props.onFetch}>
            Fetch
          </button>
          <button type="button" className="btn-ghost" disabled={busy || !status.branch || !tracking} title={tracking ? `Fast-forward from ${status.upstream}` : "No upstream branch to pull from"} onClick={props.onPull}>
            Pull{tracking && status.behind > 0 && ` ↓${status.behind}`}
          </button>
          <button
            type="button"
            className={canPush ? "btn-accent" : "btn-ghost"}
            disabled={!canPush}
            title={publish ? "Upload this branch and track it" : status.ahead > 0 ? `Upload to ${status.upstream}` : "Nothing to push"}
            onClick={props.onPush}
          >
            {publish ? "Publish branch" : `Push${status.ahead > 0 ? ` ↑${status.ahead}` : ""}`}
          </button>
        </div>
      )}
      <div className="git-note" role="status" hidden={!props.activity}>{props.activity}</div>
      {status.workspacePrefix && <div className="git-note">Showing the whole repository “{repoName}”, which contains this folder.</div>}
      {error && <div className="git-note git-error" role="alert">{error}</div>}

      <div className="git-commit">
        <textarea
          aria-label="Commit message"
          placeholder={`Commit message (${/Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+"}Enter)`}
          rows={3}
          value={message}
          onChange={(e) => props.onMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (canCommit) props.onCommit();
            }
          }}
        />
        <button type="button" className="btn-accent" disabled={!canCommit} aria-describedby={blocker ? "git-blocker" : undefined} onClick={props.onCommit}>
          Commit {staged.length > 0 && `${staged.length} ${staged.length === 1 ? "file" : "files"}`}
        </button>
        {blocker && <div id="git-blocker" className="git-hint">{blocker}</div>}
      </div>

      {section("Conflicts", conflicts, false)}
      {section("Staged", staged, true)}
      {section("Changes", changes, false)}
      {status.files.length === 0 && <div className="empty">Nothing to commit.</div>}
    </div>
  );
}
