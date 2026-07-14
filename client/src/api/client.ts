import type {
  Scan,
  Finding,
  Report,
  AgentRun,
  TaskInfo,
  Settings,
  CreateScanRequest,
  ReportAudience,
  ModelPricing,
} from "@repo-radar/shared";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface HealthInfo {
  ok: boolean;
  hasApiKey: boolean;
  defaultModel: string;
  models: ModelPricing[];
}

export type TaskWithStats = TaskInfo & {
  stats: { avgTokens: number; avgCost: number; runs: number };
};

export const api = {
  health: () => req<HealthInfo>("/api/health"),
  createScan: (body: CreateScanRequest) =>
    req<Scan>("/api/scans", { method: "POST", body: JSON.stringify(body) }),
  listScans: () => req<Scan[]>("/api/scans"),
  getScan: (id: string) => req<Scan>(`/api/scans/${id}`),
  deleteScan: (id: string) => req<{ ok: boolean }>(`/api/scans/${id}`, { method: "DELETE" }),
  findings: (id: string) => req<Finding[]>(`/api/scans/${id}/findings`),
  runs: (id: string) => req<AgentRun[]>(`/api/scans/${id}/runs`),
  report: (id: string, audience: ReportAudience) =>
    req<Report>(`/api/scans/${id}/report?audience=${audience}`),
  reportDownloadUrl: (id: string, audience: ReportAudience) =>
    `/api/scans/${id}/report?audience=${audience}&download=1`,
  tasks: () => req<TaskWithStats[]>("/api/tasks"),
  settings: () => req<Settings>("/api/settings"),
  updateSettings: (body: Partial<Settings>) =>
    req<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
};
