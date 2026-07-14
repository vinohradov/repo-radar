import { useMemo, useState } from "react";
import type { Finding, Severity, AgentKind } from "@repo-radar/shared";
import { useFindings } from "../api/hooks.js";
import { useScanContext } from "../App.js";
import { Card, FilterChip, EmptyState } from "../components/primitives.js";
import { IssuesTable } from "../components/scan.js";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const AGENTS: AgentKind[] = ["security", "code", "documentation"];

export function Issues() {
  const { currentScan, currentScanId: effectiveId } = useScanContext();
  const findings = useFindings(effectiveId ?? undefined);

  const [sev, setSev] = useState<Set<Severity>>(new Set());
  const [agents, setAgents] = useState<Set<AgentKind>>(new Set());
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    let f: Finding[] = findings.data ?? [];
    if (sev.size) f = f.filter((x) => sev.has(x.severity));
    if (agents.size) f = f.filter((x) => agents.has(x.agent as AgentKind));
    if (q.trim()) {
      const s = q.toLowerCase();
      f = f.filter(
        (x) =>
          x.title.toLowerCase().includes(s) ||
          (x.file ?? "").toLowerCase().includes(s) ||
          x.description.toLowerCase().includes(s),
      );
    }
    return f;
  }, [findings.data, sev, agents, q]);

  const toggle = <T,>(set: Set<T>, v: T, upd: (s: Set<T>) => void) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    upd(next);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Issues</div>
          <div className="page-sub">
            {currentScan
              ? `${findings.data?.length ?? 0} findings in ${currentScan.repoName}`
              : "No scan selected"}
          </div>
        </div>
      </div>

      {!effectiveId ? (
        <Card>
          <EmptyState icon="🔍" title="No scan selected" hint="Start a scan from the Dashboard." />
        </Card>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
            <input
              className="search-input"
              style={{ flex: 1, minWidth: 220 }}
              placeholder="Search issues..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="row" style={{ marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
            {SEVERITIES.map((s) => (
              <FilterChip key={s} label={s} dotKey={s} active={sev.has(s)} onClick={() => toggle(sev, s, setSev)} />
            ))}
            <span style={{ width: 1, height: 24, background: "var(--rr-border)", margin: "0 4px" }} />
            {AGENTS.map((a) => (
              <FilterChip key={a} label={a} dotKey={a} active={agents.has(a)} onClick={() => toggle(agents, a, setAgents)} />
            ))}
          </div>
          <Card>
            <IssuesTable findings={filtered} />
          </Card>
        </>
      )}
    </div>
  );
}
