import type { ReactNode } from "react";
import type { Severity } from "@repo-radar/shared";

export function Card({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`card ${className ?? ""}`}>
      {title && <div className="card-title">{title}</div>}
      {children}
    </div>
  );
}

export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="card stat-tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

export function PillButton({
  children,
  onClick,
  disabled,
  secondary,
  type,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  secondary?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type ?? "button"}
      className={`pill-btn ${secondary ? "secondary" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

const SEV_DOT: Record<string, string> = {
  critical: "var(--rr-critical)",
  high: "var(--rr-danger)",
  medium: "var(--rr-warning)",
  security: "var(--rr-danger)",
  docs: "var(--rr-primary-500)",
  code: "var(--rr-accent-text)",
};

export function FilterChip({
  label,
  active,
  onClick,
  dotKey,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  dotKey?: string;
}) {
  return (
    <button className={`chip ${active ? "active" : ""}`} onClick={onClick}>
      {dotKey && <span className="dot" style={{ background: SEV_DOT[dotKey] ?? "var(--rr-neutral-400)" }} />}
      {label}
    </button>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`sev sev-${severity}`}>{severity}</span>;
}

export function ConfidenceMeter({ value }: { value: number }) {
  return (
    <span className="conf">
      <span className="conf-track">
        <span className="conf-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="mono">{Math.round(value * 100)}%</span>
    </span>
  );
}

export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <div className="big">{icon}</div>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {hint && <div style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

export function Toast({ message }: { message: string }) {
  return <div className="toast">{message}</div>;
}
