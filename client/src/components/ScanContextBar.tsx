import { useScanContext } from "../App.js";

const fmtLong = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Persistent strip shown on every scan-scoped page (Dashboard / Issues /
 * Reports) so it is always clear WHICH repo/scan the page's data belongs to,
 * with a single place to switch between recent scans.
 */
export function ScanContextBar() {
  const { scans, currentScan, isExplicit, setSelectedScanId } = useScanContext();
  if (!currentScan) return null;
  const s = currentScan;

  return (
    <div className="context-bar">
      <div className="ctx-main">
        <div className="ctx-eyebrow">{isExplicit ? "Selected scan" : "Latest scan"}</div>
        <div className="ctx-repo">
          {s.repoName}
          {s.label && <span className="tag">{s.label}</span>}
          {s.branch && <span className="tag">⎇ {s.branch}</span>}
          <span className={`tag status-${s.status}`}>{s.status}</span>
        </div>
        <div className="mono ctx-path">
          {s.repoUrl ?? s.localPath} · scanned {fmtLong(s.createdAt)}
        </div>
      </div>
      <div className="ctx-side">
        {s.scores && (
          <div className="ctx-health">
            <span className="k">Health</span>
            <span className="v">{s.scores.health}%</span>
          </div>
        )}
        {scans.length > 1 && (
          <select
            className="select"
            value={s.id}
            onChange={(e) => setSelectedScanId(e.target.value)}
            aria-label="Switch scan"
          >
            {scans.map((x) => (
              <option key={x.id} value={x.id}>
                {x.repoName}
                {x.label ? ` — ${x.label}` : ""} · {fmtLong(x.createdAt)}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
