import type { ReactNode } from "react";

export interface CalloutProps {
  /** Visual style and semantics. */
  type: "info" | "warning" | "danger" | "tip";
  /** Optional bold heading. */
  title?: string;
  children?: ReactNode;
}

/**
 * Highlighted note, tip or warning box.
 * @category Feedback
 */
export function Callout({ type, title, children }: CalloutProps) {
  return (
    <aside data-type={type}>
      {title && <strong>{title}</strong>}
      {children}
    </aside>
  );
}

export interface BadgeProps {
  tone?: "neutral" | "new" | "beta" | "deprecated";
  children?: ReactNode;
}

/**
 * Small inline status label.
 * @category Feedback
 * @mdxSnippet <Badge tone="${1:new}">${2:New}</Badge>
 */
export function Badge({ tone = "neutral", children }: BadgeProps) {
  return <span data-tone={tone}>{children}</span>;
}
