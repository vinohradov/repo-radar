import { Fragment, useState } from "react";
import type { Scan, Finding, Phase, AgentKind } from "@repo-radar/shared";
import { PHASES } from "@repo-radar/shared";
import { SeverityBadge, ConfidenceMeter } from "./primitives.js";

/* ------------------------- Scan progress stepper ------------------------ */
export function ScanProgress({ scan }: { scan: Scan }) {
  return (
    <div className="stepper">
      {PHASES.map((p) => {
        const ps = scan.phases[p as Phase];
        const status = ps?.status ?? "pending";
        return (
          <div key={p} className={`step ${status}`}>
            <span className="marker">
              {status === "completed" ? "✓" : status === "failed" ? "!" : status === "skipped" ? "–" : ""}
            </span>
            <span className="step-body">
              <div className="name">{p}</div>
              {ps?.detail && <div className="detail">{ps.detail}</div>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------- Heatmap ---------------------------------- */
export function SeverityHeatmap({ findings }: { findings: Finding[] }) {
  // One tile per finding (worst first); fill to a pleasant grid with healthy tiles.
  const tiles = findings.map((f) => f.severity);
  const pad = Math.max(0, 25 - tiles.length);
  const cls = (s: string) =>
    s === "critical" ? "heat-critical" : s === "high" ? "heat-high" : s === "medium" ? "heat-medium" : "heat-low";
  return (
    <div className="heatmap">
      {tiles.map((s, i) => (
        <div key={i} className={`heat-tile ${cls(s)}`} title={s} />
      ))}
      {Array.from({ length: pad }).map((_, i) => (
        <div key={`e${i}`} className="heat-tile heat-empty" title="clear" />
      ))}
    </div>
  );
}

/* --------------------------- Issues overview chart ---------------------- */
const AGENTS: AgentKind[] = ["security", "code", "documentation"];
const SEV_COLORS: Record<string, string> = {
  critical: "var(--rr-critical)",
  high: "var(--rr-danger)",
  medium: "var(--rr-warning)",
  low: "var(--rr-primary-400)",
};

export function IssuesChart({ findings }: { findings: Finding[] }) {
  const max = Math.max(1, ...AGENTS.map((a) => findings.filter((f) => f.agent === a).length));
  return (
    <div>
      <div className="bars">
        {AGENTS.map((agent) => {
          const forAgent = findings.filter((f) => f.agent === agent);
          const total = forAgent.length;
          return (
            <div className="bar-group" key={agent}>
              <div className="bar-stack" style={{ height: `${(total / max) * 100}%`, minHeight: total ? 6 : 2 }}>
                {(["low", "medium", "high", "critical"] as const).map((sev) => {
                  const n = forAgent.filter((f) => f.severity === sev).length;
                  if (!n) return null;
                  return (
                    <div
                      key={sev}
                      className="bar-seg"
                      style={{ background: SEV_COLORS[sev], flex: n }}
                      title={`${agent} · ${sev}: ${n}`}
                    />
                  );
                })}
              </div>
              <div className="bar-label">
                {agent} ({total})
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------- Token usage bar --------------------------- */
export function TokenUsageBar({ scan }: { scan: Scan }) {
  const u = scan.usage;
  const metric = (k: string, v: string) => (
    <span className="usage-metric" style={{ display: "flex", flexDirection: "column" }}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </span>
  );
  return (
    <div className="usage-bar">
      {metric("Input tokens", u.inputTokens.toLocaleString())}
      {metric("Output tokens", u.outputTokens.toLocaleString())}
      {metric("Cache read", u.cacheReadTokens.toLocaleString())}
      {metric("Cache write", u.cacheCreationTokens.toLocaleString())}
      {metric("Est. cost", `$${u.costUsd.toFixed(4)}`)}
    </div>
  );
}

/* ------------------------------ Issues table ---------------------------- */
export function IssuesTable({ findings }: { findings: Finding[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copyFix = (f: Finding) => {
    const text = `${f.title}\nFile: ${f.file ?? "—"}${f.line ? `:${f.line}` : ""}\nFix: ${f.suggestedFix}`;
    void navigator.clipboard.writeText(text);
    setCopied(f.id);
    setTimeout(() => setCopied((c) => (c === f.id ? null : c)), 1500);
  };

  if (findings.length === 0) {
    return <div className="muted" style={{ padding: 16 }}>No findings match the current filters.</div>;
  }

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th style={{ width: 90 }}>Severity</th>
          <th style={{ width: 110 }}>Agent</th>
          <th>Issue</th>
          <th style={{ width: 220 }}>Location</th>
          <th style={{ width: 110 }}>Confidence</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((f) => (
          <Fragment key={f.id}>
            <tr
              className="expandable"
              onClick={() => setOpen((o) => (o === f.id ? null : f.id))}
            >
              <td>
                <SeverityBadge severity={f.severity} />
              </td>
              <td>
                <span className="tag">{f.agent}</span>
              </td>
              <td>{f.title}</td>
              <td className="mono">{f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "—"}</td>
              <td>
                <ConfidenceMeter value={f.confidence} />
              </td>
            </tr>
            {open === f.id && (
              <tr className="expand-row">
                <td colSpan={5}>
                  <div className="stack" style={{ gap: 8 }}>
                    <div>
                      <strong>Description.</strong> {f.description}
                    </div>
                    <div>
                      <strong>Suggested fix.</strong> {f.suggestedFix}
                    </div>
                    {f.reference && (
                      <div>
                        <strong>Reference.</strong>{" "}
                        <a href={f.reference} target="_blank" rel="noreferrer">
                          {f.reference}
                        </a>
                      </div>
                    )}
                    <div>
                      <button className="chip" onClick={() => copyFix(f)}>
                        {copied === f.id ? "Copied ✓" : "Copy fix instruction"}
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
