import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { Scan } from "@repo-radar/shared";
import { useScans } from "../api/hooks.js";
import { useScanContext } from "../App.js";
import { Card, EmptyState } from "../components/primitives.js";

/** Latest completed scan per distinct repo. */
function latestPerRepo(scans: Scan[]): Scan[] {
  const byRepo = new Map<string, Scan>();
  for (const s of scans) {
    if (s.status !== "completed" || !s.scores) continue;
    // Incremental scans only cover changed files — not a fair health picture.
    if (s.config.incremental) continue;
    const key = s.repoUrl ?? s.localPath ?? s.repoName;
    const existing = byRepo.get(key);
    if (!existing || s.createdAt > existing.createdAt) byRepo.set(key, s);
  }
  return Array.from(byRepo.values()).sort((a, b) => (a.scores?.health ?? 0) - (b.scores?.health ?? 0));
}

function HealthBar({ value }: { value: number }) {
  const color = value >= 80 ? "var(--rr-success)" : value >= 50 ? "var(--rr-warning)" : "var(--rr-danger)";
  return (
    <div className="health-bar">
      <div className="health-track">
        <div className="health-fill" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="mono">{value}%</span>
    </div>
  );
}

export function Compare() {
  const navigate = useNavigate();
  const scans = useScans();
  const { setSelectedScanId } = useScanContext();
  const rows = useMemo(() => latestPerRepo(scans.data ?? []), [scans.data]);

  const open = (scan: Scan) => {
    setSelectedScanId(scan.id);
    navigate("/");
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Compare</div>
          <div className="page-sub">Latest completed scan per repository, worst health first</div>
        </div>
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState icon="⚖️" title="Nothing to compare yet" hint="Complete scans of at least one repository to see them side by side." />
        </Card>
      ) : (
        <Card>
          <table className="tbl">
            <thead>
              <tr>
                <th>Repository</th>
                <th style={{ width: 180 }}>Health</th>
                <th style={{ width: 90 }}>Security</th>
                <th style={{ width: 80 }}>Code</th>
                <th style={{ width: 80 }}>Docs</th>
                <th style={{ width: 160 }}>Findings (C/H/M)</th>
                <th style={{ width: 90 }}>Cost</th>
                <th style={{ width: 130 }}>Scanned</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="expandable" onClick={() => open(s)}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{s.repoName}</div>
                    <div className="mono">{s.repoUrl ?? s.localPath}</div>
                  </td>
                  <td>{s.scores && <HealthBar value={s.scores.health} />}</td>
                  <td>
                    <span
                      className={`tag ${
                        s.scores?.security === "High"
                          ? "status-completed"
                          : s.scores?.security === "Low"
                            ? "status-failed"
                            : ""
                      }`}
                    >
                      {s.scores?.security}
                    </span>
                  </td>
                  <td>{s.scores?.code}</td>
                  <td>{s.scores?.docs}</td>
                  <td className="mono">{s.findingCount} total</td>
                  <td className="mono">${s.usage.costUsd.toFixed(4)}</td>
                  <td className="muted" style={{ fontSize: "var(--rr-fs-300)" }}>
                    {new Date(s.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
