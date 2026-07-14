import { useEffect, useState } from "react";
import type { AgentKind, Severity } from "@repo-radar/shared";
import { useSettings, useUpdateSettings, useHealth } from "../api/hooks.js";
import { Card, PillButton, Toast } from "../components/primitives.js";

const AGENTS: AgentKind[] = ["code", "security", "documentation", "reporting"];
const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];

export function Settings() {
  const settings = useSettings();
  const health = useHealth();
  const update = useUpdateSettings();

  const [models, setModels] = useState<Record<string, string>>({});
  const [threshold, setThreshold] = useState<Severity>("low");
  const [excluded, setExcluded] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) {
      setModels(settings.data.models);
      setThreshold(settings.data.severityThreshold);
      setExcluded(settings.data.excludedPaths.join(", "));
    }
  }, [settings.data]);

  const modelOptions = health.data?.models ?? [];

  const save = async () => {
    await update.mutateAsync({
      models,
      severityThreshold: threshold,
      excludedPaths: excluded.split(",").map((s) => s.trim()).filter(Boolean),
    });
    setToast("Settings saved");
    setTimeout(() => setToast(null), 2000);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">Per-agent model, severity threshold, and excluded paths</div>
        </div>
        <PillButton onClick={save} disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save settings"}
        </PillButton>
      </div>

      <div className="grid-2">
        <Card title="AI models per agent">
          <div className="muted" style={{ marginBottom: 14, fontSize: "var(--rr-fs-350)" }}>
            {health.data?.hasApiKey ? (
              <>API key detected. Live pricing shown per model.</>
            ) : (
              <span style={{ color: "var(--rr-danger)" }}>
                ⚠ No ANTHROPIC_API_KEY set — scans run collectors only and skip the analyze phase.
              </span>
            )}
          </div>
          {AGENTS.map((agent) => (
            <div className="field" key={agent}>
              <label style={{ textTransform: "capitalize" }}>{agent} agent</label>
              <select
                className="select"
                value={models[agent] ?? ""}
                onChange={(e) => setModels((m) => ({ ...m, [agent]: e.target.value }))}
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — ${m.inputPerMtok}/${m.outputPerMtok} per MTok
                  </option>
                ))}
              </select>
            </div>
          ))}
        </Card>

        <div className="stack">
          <Card title="Analysis">
            <div className="field">
              <label>Severity threshold (drop findings below this)</label>
              <select className="select" value={threshold} onChange={(e) => setThreshold(e.target.value as Severity)}>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Excluded paths (comma separated)</label>
              <input className="text-input" value={excluded} onChange={(e) => setExcluded(e.target.value)} />
            </div>
          </Card>

          <Card title="Token efficiency">
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, fontSize: "var(--rr-fs-350)" }}>
              <li>Frozen agent prompts sent with <span className="mono">cache_control: ephemeral</span></li>
              <li>Structured outputs (<span className="mono">output_config.format</span>) — no JSON retries</li>
              <li>Per-task <span className="mono">max_tokens</span> caps + evidence pre-filtering in collectors</li>
              <li>Full usage (incl. cache reads) tracked per scan</li>
            </ul>
          </Card>
        </div>
      </div>

      {toast && <Toast message={toast} />}
    </div>
  );
}
