// Built-in demo components, used when the repo has no `preview.components_bundle`.
// They match `examples/docs-site/.mdx-ide/component-manifest.json`. Replace
// them with your design system by building it as an ESM bundle (see README).

import { Children, isValidElement, useState, type ReactNode } from "react";

type CalloutType = "info" | "warning" | "danger" | "tip";

export function Callout({ type = "info", title, children }: { type?: CalloutType; title?: string; children?: ReactNode }) {
  return (
    <aside className={`callout callout-${type}`} role="note">
      <svg className="callout-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5" />
        <path d="M12 8h0" />
      </svg>
      <div className="callout-body">
        {title && <p className="callout-title">{title}</p>}
        <div>{children}</div>
      </div>
    </aside>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "new" | "beta" | "deprecated"; children?: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Tab({ children }: { label: string; children?: ReactNode }) {
  return <>{children}</>;
}

export function Tabs({ children }: { children?: ReactNode }) {
  const tabs = Children.toArray(children).filter(isValidElement) as Array<React.ReactElement<{ label: string; children?: ReactNode }>>;
  const [active, setActive] = useState(0);
  return (
    <div className="tabs">
      <div className="tabs-list" role="tablist">
        {tabs.map((t, i) => (
          <button key={i} role="tab" aria-selected={i === active} onClick={() => setActive(i)}>
            {t.props.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tabs[active]}</div>
    </div>
  );
}

export function Steps({ children }: { children?: ReactNode }) {
  return <div className="steps">{children}</div>;
}

export const builtinComponents = { Callout, Badge, Tabs, Tab, Steps };
