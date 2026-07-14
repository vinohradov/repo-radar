import { useMemo, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Finding } from "@repo-radar/shared";
import { useScans, useScan, useFindings, useCreateScan, useScanStream, useHealth, useDeleteScan } from "../api/hooks.js";
import { useSelection } from "../App.js";
import { Card, StatTile, PillButton, FilterChip, EmptyState, Toast } from "../components/primitives.js";
import { ScanProgress, SeverityHeatmap, IssuesChart, TokenUsageBar } from "../components/scan.js";

export function Dashboard() {
  const navigate = useNavigate();
  const health = useHealth();
  const scans = useScans();
  const { selectedScanId, setSelectedScanId } = useSelection();

  // default selection = most recent scan
  const effectiveId = selectedScanId ?? scans.data?.[0]?.id ?? null;
  const scan = useScan(effectiveId ?? undefined);
  const findings = useFindings(effectiveId ?? undefined);
  useScanStream(scan.data?.status === "running" || scan.data?.status === "queued" ? effectiveId ?? undefined : undefined);

  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [chips, setChips] = useState<{ critical: boolean; security: boolean; docs: boolean }>({
    critical: false,
    security: false,
    docs: false,
  });
  const [toast, setToast] = useState<string | null>(null);

  const createScan = useCreateScan();
  const deleteScan = useDeleteScan();

  const filteredFindings = useMemo(() => {
    let f: Finding[] = findings.data ?? [];
    if (chips.critical) f = f.filter((x) => x.severity === "critical" || x.severity === "high");
    if (chips.security) f = f.filter((x) => x.agent === "security");
    if (chips.docs) f = f.filter((x) => x.agent === "documentation");
    return f;
  }, [findings.data, chips]);

  const recentScans = useMemo(() => {
    const list = scans.data ?? [];
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter((s) => s.repoName.toLowerCase().includes(q) || (s.repoUrl ?? "").toLowerCase().includes(q));
  }, [scans.data, search]);

  const startScan = async (input: {
    repoUrl?: string;
    localPath?: string;
    branch?: string;
    token?: string;
    label?: string;
  }) => {
    const created = await createScan.mutateAsync({ ...input });
    setSelectedScanId(created.id);
    setShowForm(false);
    setToast(`Scan started for ${created.repoName}`);
    setTimeout(() => setToast(null), 2500);
  };

  const removeScan = async (e: MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteScan.mutateAsync(id);
    if (selectedScanId === id) setSelectedScanId(null);
  };

  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-sub">
            AI-orchestrated repository analysis
            {health.data && !health.data.hasApiKey && (
              <span style={{ color: "var(--rr-danger)" }}> · ⚠ no API key set — analyze phase will be skipped</span>
            )}
          </div>
        </div>
        <PillButton onClick={() => setShowForm((s) => !s)}>Start Scan</PillButton>
      </div>

      {showForm && <ScanForm onSubmit={startScan} pending={createScan.isPending} />}

      <div className="row" style={{ marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <input
            className="search-input"
            placeholder="Search repository / issue..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <FilterChip label="Critical" dotKey="critical" active={chips.critical} onClick={() => setChips((c) => ({ ...c, critical: !c.critical }))} />
        <FilterChip label="Security" dotKey="security" active={chips.security} onClick={() => setChips((c) => ({ ...c, security: !c.security }))} />
        <FilterChip label="Docs" dotKey="docs" active={chips.docs} onClick={() => setChips((c) => ({ ...c, docs: !c.docs }))} />
      </div>

      {!effectiveId ? (
        <Card>
          <EmptyState icon="🛰️" title="No scans yet" hint="Click Start Scan and point Repo Radar at a repository URL or a local path." />
        </Card>
      ) : (
        <div className="stack">
          <div className="grid-3">
            <StatTile label="Health" value={scan.data?.scores ? `${scan.data.scores.health}%` : "—"} />
            <StatTile label="Security" value={scan.data?.scores?.security ?? "—"} />
            <StatTile label="Code" value={scan.data?.scores?.code ?? "—"} />
          </div>

          <div className="grid-2">
            <Card title="Issues Overview">
              {filteredFindings.length ? (
                <IssuesChart findings={filteredFindings} />
              ) : scan.data?.status === "completed" ? (
                <EmptyState icon="✅" title="No issues match the filters" />
              ) : (
                <div className="muted">Findings appear here once the analyze phase completes.</div>
              )}
              <div style={{ marginTop: 16 }}>
                <div className="card-title" style={{ marginBottom: 8 }}>Severity heatmap</div>
                <SeverityHeatmap findings={filteredFindings} />
              </div>
            </Card>

            <div className="stack">
              <Card title={`Scan progress — ${scan.data?.repoName ?? ""}`}>
                {scan.data && <ScanProgress scan={scan.data} />}
              </Card>
              <Card title="Token usage">
                {scan.data && <TokenUsageBar scan={scan.data} />}
              </Card>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <PillButton secondary onClick={() => navigate("/issues")}>
              View issues ({findings.data?.length ?? 0})
            </PillButton>
            <PillButton secondary onClick={() => navigate("/reports")}>
              View reports
            </PillButton>
          </div>
        </div>
      )}

      <Card title="Recent scans" className="" >
        {recentScans.length === 0 ? (
          <div className="muted">No scans match your search.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Repository / job</th>
                <th style={{ width: 130 }}>Started</th>
                <th style={{ width: 100 }}>Status</th>
                <th style={{ width: 80 }}>Health</th>
                <th style={{ width: 80 }}>Findings</th>
                <th style={{ width: 90 }}>Cost</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {recentScans.map((s) => (
                <tr
                  key={s.id}
                  className="expandable"
                  style={{ background: s.id === effectiveId ? "var(--rr-primary-100)" : undefined }}
                  onClick={() => setSelectedScanId(s.id)}
                >
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {s.repoName}
                      {s.label && <span className="tag" style={{ marginLeft: 8 }}>{s.label}</span>}
                    </div>
                    <div className="mono">{s.repoUrl ?? s.localPath}</div>
                  </td>
                  <td className="muted" style={{ fontSize: "var(--rr-fs-300)" }}>{fmtTime(s.createdAt)}</td>
                  <td>
                    <span className="tag">{s.status}</span>
                  </td>
                  <td>{s.scores ? `${s.scores.health}%` : "—"}</td>
                  <td>{s.findingCount}</td>
                  <td className="mono">${s.usage.costUsd.toFixed(4)}</td>
                  <td>
                    <button
                      className="chip"
                      title="Delete scan"
                      style={{ padding: "4px 9px" }}
                      onClick={(e) => removeScan(e, s.id)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {toast && <Toast message={toast} />}
    </div>
  );
}

function ScanForm({
  onSubmit,
  pending,
}: {
  onSubmit: (i: { repoUrl?: string; localPath?: string; branch?: string; token?: string; label?: string }) => void;
  pending: boolean;
}) {
  const [mode, setMode] = useState<"url" | "local">("url");
  const [value, setValue] = useState("");
  const [branch, setBranch] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");

  return (
    <Card className="" >
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={`tab ${mode === "url" ? "active" : ""}`} onClick={() => setMode("url")}>
          Repository URL
        </button>
        <button className={`tab ${mode === "local" ? "active" : ""}`} onClick={() => setMode("local")}>
          Local path
        </button>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <input
          className="search-input"
          style={{ flex: 2, minWidth: 260 }}
          placeholder={mode === "url" ? "https://github.com/org/repo.git" : "/Users/you/projects/repo"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {mode === "url" && (
          <input
            className="search-input"
            style={{ flex: 1, minWidth: 140 }}
            placeholder="branch (optional)"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        )}
        <PillButton
          disabled={pending || !value.trim()}
          onClick={() =>
            onSubmit(
              mode === "url"
                ? {
                    repoUrl: value.trim(),
                    branch: branch.trim() || undefined,
                    token: token.trim() || undefined,
                    label: label.trim() || undefined,
                  }
                : { localPath: value.trim(), label: label.trim() || undefined },
            )
          }
        >
          {pending ? "Starting…" : "Run scan"}
        </PillButton>
      </div>
      <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
        <input
          className="search-input"
          style={{ flex: 1, minWidth: 260 }}
          placeholder="label / purpose of this scan (optional, e.g. 'pre-release audit')"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        {mode === "url" && (
          <input
            className="search-input"
            type="password"
            style={{ flex: 1, minWidth: 260 }}
            placeholder="access token for private repos (optional, not stored)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        )}
      </div>
      {mode === "url" && (
        <div className="muted" style={{ marginTop: 8, fontSize: "var(--rr-fs-300)" }}>
          Private repo? Paste a read-only access token (GitHub PAT), or use an SSH URL
          (git@github.com:org/repo.git) if your machine has SSH keys set up. Token is used
          only to clone and is never saved.
        </div>
      )}
    </Card>
  );
}
