import { useEffect, useRef, useState } from "react";

export interface ToastMessage {
  /** Distinguishes repeats of the same text, so each one gets its full time on screen. */
  id: number;
  kind: "ok" | "error";
  title: string;
  detail: string;
  /** The full output of a failed command, shown behind "Details". */
  details?: string;
}

const DURATION_MS = 5000;

/**
 * The result of the last Git action. Successes leave after five seconds (the clock stops while
 * hovered or focused); errors stay until dismissed. The live region is always present so that
 * new messages are announced.
 */
export function Toast({ toast, onDismiss }: { toast: ToastMessage | null; onDismiss(): void }) {
  return (
    <div className="toast-region" role="status">
      {toast && <Card key={toast.id} toast={toast} onDismiss={onDismiss} />}
    </div>
  );
}

function Card({ toast, onDismiss }: { toast: ToastMessage; onDismiss(): void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const remaining = useRef(DURATION_MS);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const paused = hovered || focused;

  useEffect(() => {
    if (toast.kind === "error" || paused) return;
    const started = Date.now();
    const timer = window.setTimeout(() => dismiss.current(), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [toast.kind, paused]);

  return (
    <div
      className={`toast ${toast.kind}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
    >
      <span className="toast-icon" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d={toast.kind === "ok" ? "m5 12 5 5 9-10" : "M12 6v7M12 18h.01"} />
        </svg>
      </span>
      <div className="toast-text">
        <span className="toast-title">{toast.title}</span>
        <span className="toast-detail">{toast.detail}</span>
        {toast.details && (
          <button type="button" className="toast-link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide details" : "Details"}
          </button>
        )}
        {expanded && <pre className="toast-details">{toast.details}</pre>}
      </div>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={onDismiss}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

/** A short line for the toast, with the whole message kept for "Details". */
export function errorToast(id: number, title: string, error: unknown): ToastMessage {
  const text = String(error).trim();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // git leads with "To <url>" and progress; the reason is the first error-like line.
  const reason = lines.find((l) => /^(error|fatal|! |remote: error)/i.test(l)) ?? lines[0] ?? "Unknown error";
  // The commonest failure gets plain words; git's own text stays under "Details".
  const detail = /\((fetch first|non-fast-forward)\)/.test(text) ? "The remote has new commits. Pull, then push again." : reason.replace(/^(error|fatal):\s*/i, "");
  const short = detail.length > 90 ? `${detail.slice(0, 89)}…` : detail;
  return { id, kind: "error", title, detail: short, details: short === text ? undefined : text };
}
