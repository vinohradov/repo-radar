import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReportAudience } from "@repo-radar/shared";
import { api } from "../api/client.js";
import { useScanContext } from "../App.js";
import { Card, PillButton, EmptyState } from "../components/primitives.js";
import { MarkdownView, JsonView } from "../components/ReportViewer.js";

export function Reports() {
  const { currentScan, currentScanId: effectiveId } = useScanContext();
  const [audience, setAudience] = useState<ReportAudience>("human");
  const [copied, setCopied] = useState(false);

  const report = useQuery({
    queryKey: ["report", effectiveId, audience],
    queryFn: () => api.report(effectiveId!, audience),
    enabled: !!effectiveId,
    retry: false,
  });

  const copyManifest = () => {
    if (report.data) {
      void navigator.clipboard.writeText(report.data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Reports</div>
          <div className="page-sub">
            {currentScan
              ? `Human summary and machine fix-manifest for ${currentScan.repoName}`
              : "Human-readable summary and the machine fix-manifest for a fixing agent"}
          </div>
        </div>
      </div>

      {!effectiveId ? (
        <Card>
          <EmptyState icon="📄" title="No scan selected" hint="Run a scan to generate reports." />
        </Card>
      ) : (
        <Card>
          <div className="spread" style={{ marginBottom: 16 }}>
            <div className="tabs">
              <button className={`tab ${audience === "human" ? "active" : ""}`} onClick={() => setAudience("human")}>
                Human report
              </button>
              <button className={`tab ${audience === "agent" ? "active" : ""}`} onClick={() => setAudience("agent")}>
                Agent report (fix manifest)
              </button>
            </div>
            <div className="row">
              {audience === "agent" && (
                <PillButton secondary onClick={copyManifest}>
                  {copied ? "Copied ✓" : "Copy manifest"}
                </PillButton>
              )}
              <a href={api.reportDownloadUrl(effectiveId, audience)}>
                <PillButton secondary>Download {audience === "agent" ? ".json" : ".md"}</PillButton>
              </a>
            </div>
          </div>

          {report.isLoading && <div className="muted">Loading report…</div>}
          {report.isError && <div className="muted">Report not ready yet — the scan may still be running.</div>}
          {report.data &&
            (audience === "human" ? (
              <MarkdownView content={report.data.content} />
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                <div className="muted">
                  Hand this file to a coding agent (e.g. Claude Code) in the target repo and ask it to apply the fix
                  manifest. Each action is deterministic with its own acceptance criteria.
                </div>
                <JsonView content={report.data.content} />
              </div>
            ))}
        </Card>
      )}
    </div>
  );
}
