import { useTasks, useHealth } from "../api/hooks.js";
import { Card, EmptyState } from "../components/primitives.js";

const AGENT_ICON: Record<string, string> = {
  security: "🛡️",
  code: "🧩",
  documentation: "📚",
  reporting: "📝",
};

export function Agents() {
  const tasks = useTasks();
  const health = useHealth();

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Agents</div>
          <div className="page-sub">
            The task registry — each task is a deterministic collector script plus a specialized agent.
            {health.data && ` Default model: ${health.data.defaultModel}.`}
          </div>
        </div>
      </div>

      {!tasks.data ? (
        <Card>
          <EmptyState icon="🤖" title="Loading agents…" />
        </Card>
      ) : (
        <div className="grid-3">
          {tasks.data.map((t) => (
            <Card key={t.id}>
              <div className="row" style={{ marginBottom: 10 }}>
                <span style={{ fontSize: 26 }}>{AGENT_ICON[t.agent] ?? "🤖"}</span>
                <div>
                  <div style={{ fontWeight: 650 }}>{t.title}</div>
                  <div className="mono">{t.agent} agent · effort: {t.effort}</div>
                </div>
              </div>
              <div className="muted" style={{ fontSize: "var(--rr-fs-350)", lineHeight: 1.5, marginBottom: 12 }}>
                {t.description}
              </div>
              <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {t.ecosystems.map((e) => (
                  <span key={e} className="tag">
                    {e}
                  </span>
                ))}
                <span className="tag">max {t.maxFindings} findings</span>
              </div>
              <div className="spread" style={{ borderTop: "1px solid var(--rr-border)", paddingTop: 12 }}>
                <div>
                  <div className="usage-metric" style={{ display: "flex", flexDirection: "column" }}>
                    <span className="k">avg tokens / run</span>
                    <span className="v">{t.stats.avgTokens.toLocaleString()}</span>
                  </div>
                </div>
                <div>
                  <div className="usage-metric" style={{ display: "flex", flexDirection: "column" }}>
                    <span className="k">avg cost / run</span>
                    <span className="v">${t.stats.avgCost.toFixed(4)}</span>
                  </div>
                </div>
                <div>
                  <div className="usage-metric" style={{ display: "flex", flexDirection: "column" }}>
                    <span className="k">runs</span>
                    <span className="v">{t.stats.runs}</span>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
