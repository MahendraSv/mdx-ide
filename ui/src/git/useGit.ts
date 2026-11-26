import { useCallback, useEffect, useRef, useState } from "react";
import { api, type GitStatus, type WorkspaceInfo } from "../api";

/**
 * The repository status of the open folder. It is re-read when the workspace changes (saves,
 * file operations, watcher events), when the window regains focus, and on demand.
 */
export function useGit(ws: WorkspaceInfo | null) {
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const open = !!ws;

  const refresh = useCallback(async () => {
    const mine = ++sequence.current;
    try {
      const next = await api.gitStatus();
      // A slower, older read must not replace a newer one.
      if (mine !== sequence.current) return next;
      setStatus(next);
      setError(null);
      setRevision((r) => r + 1);
      return next;
    } catch (e) {
      if (mine === sequence.current) setError(String(e));
    }
  }, []);

  useEffect(() => {
    sequence.current++;
    setStatus(undefined);
    setError(null);
  }, [ws?.root]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(refresh, 200);
    return () => window.clearTimeout(timer);
  }, [ws, open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, refresh]);

  return { status, error, revision, refresh };
}
