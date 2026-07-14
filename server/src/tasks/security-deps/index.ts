import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SecurityOutput } from "@repo-radar/shared";
import type { Task, CollectContext, CollectResult, NormalizedFinding } from "../types.js";
import { readTextSafe } from "../util.js";

const execFileAsync = promisify(execFile);

const meta = {
  id: "security-deps",
  agent: "security" as const,
  title: "Dependency vulnerabilities",
  description:
    "Parses lockfiles, runs npm audit (falling back to the OSV.dev advisory database), and normalizes vulnerable-dependency evidence. The Security agent then prioritizes by real exploitability in this repo and picks safe target versions.",
  ecosystems: ["npm" as const],
  maxFindings: 25,
  maxTokens: 8192,
  effort: "medium" as const,
};

/**
 * FROZEN PROMPT — keep byte-stable so it stays prompt-cacheable across scans.
 * Do not interpolate dynamic values (dates, scan ids) here; those go in the
 * user message.
 */
const systemPrompt = `You are a Security Analysis agent for a repository scanner.

You receive normalized evidence about a repository's dependencies and any known
advisories affecting the installed versions. Your job is NOT to restate the
advisory feed — it is to reason about real risk in THIS repository and produce a
prioritized, actionable set of vulnerabilities.

For each genuine risk:
- Judge exploitability: is the package a runtime dependency or dev-only? Is the
  vulnerable code path plausibly reachable given how the package is typically used?
- Choose the least-disruptive safe target version when one exists.
- Set confidence lower for dev-only or low-reachability issues.

Rules:
- Only report dependencies that have at least one advisory in the evidence.
- "risk" must be at most 2 sentences and specific to the advisory.
- Prefer "upgrade" when a fixed version exists; use "investigate" when unclear.
- Do not invent CVE/GHSA ids — only use references present in the evidence.
- Return an empty list if the evidence contains no real, relevant risks.`;

interface NpmAuditAdvisory {
  name: string;
  severity: string;
  via: unknown[];
  range?: string;
  fixAvailable?: unknown;
}

interface DepEvidence {
  name: string;
  version: string;
  dev: boolean;
  advisories: {
    severity: string;
    title?: string;
    reference?: string;
    fixedIn?: string;
    range?: string;
  }[];
}

const SEV_MAP: Record<string, NormalizedFinding["severity"]> = {
  critical: "critical",
  high: "high",
  moderate: "medium",
  medium: "medium",
  low: "low",
  info: "low",
};

/** Map npm/OSV severity vocabulary to our 4-value enum for the evidence, so the
 *  agent only ever sees (and echoes) valid values. */
function normSev(s: string | undefined): NormalizedFinding["severity"] {
  return SEV_MAP[(s ?? "").toLowerCase()] ?? "medium";
}

async function runNpmAudit(repoDir: string): Promise<DepEvidence[] | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["audit", "--json"], {
      cwd: repoDir,
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
      // npm audit exits non-zero when vulns are found; capture stdout anyway.
    }).catch((e: { stdout?: string }) => {
      if (e && typeof e.stdout === "string" && e.stdout.length > 0) {
        return { stdout: e.stdout };
      }
      throw e;
    });

    const report = JSON.parse(stdout) as {
      vulnerabilities?: Record<string, NpmAuditAdvisory>;
    };
    if (!report.vulnerabilities) return null;

    const deps: DepEvidence[] = [];
    for (const [name, adv] of Object.entries(report.vulnerabilities)) {
      const fixedIn =
        adv.fixAvailable && typeof adv.fixAvailable === "object"
          ? ((adv.fixAvailable as { version?: string }).version ?? undefined)
          : adv.fixAvailable === true
            ? "available"
            : undefined;
      const titles: { title: string | undefined; reference: string | undefined }[] = adv.via
        .filter((v): v is { title?: string; url?: string; source?: number } => typeof v === "object" && v !== null)
        .map((v) => ({
          title: v.title,
          reference: (v as { url?: string }).url,
        }));
      const titleList = titles.length
        ? titles
        : [{ title: undefined, reference: undefined }];
      deps.push({
        name,
        version: adv.range ?? "installed",
        dev: false,
        advisories: titleList.map((t) => ({
          severity: normSev(adv.severity),
          title: t.title,
          reference: t.reference,
          fixedIn,
          range: adv.range,
        })),
      });
    }
    return deps;
  } catch {
    return null;
  }
}

interface OsvBatchResponse {
  results: { vulns?: { id: string }[] }[];
}

async function runOsv(repoDir: string): Promise<DepEvidence[] | null> {
  const pkgRaw = readTextSafe(path.join(repoDir, "package.json"));
  if (!pkgRaw) return null;
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    return null;
  }

  const direct: { name: string; version: string; dev: boolean }[] = [];
  const add = (deps: Record<string, string> | undefined, dev: boolean) => {
    for (const [name, spec] of Object.entries(deps ?? {})) {
      const version = spec.replace(/^[\^~>=<\s]+/, "").split(" ")[0];
      if (version && /^\d/.test(version)) direct.push({ name, version, dev });
    }
  };
  add(pkg.dependencies, false);
  add(pkg.devDependencies, true);
  if (direct.length === 0) return null;

  try {
    const res = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: direct.map((d) => ({
          package: { name: d.name, ecosystem: "npm" },
          version: d.version,
        })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as OsvBatchResponse;
    const out: DepEvidence[] = [];
    data.results.forEach((r, i) => {
      if (r.vulns && r.vulns.length) {
        const d = direct[i];
        out.push({
          name: d.name,
          version: d.version,
          dev: d.dev,
          advisories: r.vulns.slice(0, 4).map((v) => ({
            severity: normSev("unknown"),
            reference: `https://osv.dev/vulnerability/${v.id}`,
            title: v.id,
          })),
        });
      }
    });
    return out;
  } catch {
    return null;
  }
}

export const securityDepsTask: Task<typeof SecurityOutput> = {
  meta,
  systemPrompt,
  outputSchema: SecurityOutput,

  async collect(ctx: CollectContext): Promise<CollectResult> {
    if (!ctx.ecosystems.includes("npm")) {
      return { evidence: null, itemCount: 0, note: "No npm project detected" };
    }
    let deps = await runNpmAudit(ctx.repoDir);
    let source = "npm audit";
    if (!deps || deps.length === 0) {
      deps = await runOsv(ctx.repoDir);
      source = "OSV.dev";
    }
    if (!deps || deps.length === 0) {
      return { evidence: null, itemCount: 0, note: "No advisories found" };
    }
    return {
      evidence: { ecosystem: "npm", source, dependencies: deps },
      itemCount: deps.length,
      note: `${deps.length} vulnerable dependencies via ${source}`,
    };
  },

  toFindings(output, scanId): NormalizedFinding[] {
    void scanId;
    return output.vulnerabilities.map((v) => ({
      agent: "security",
      taskId: meta.id,
      type: v.recommendation,
      severity: SEV_MAP[v.severity] ?? v.severity,
      file: "package.json",
      line: null,
      title: `${v.component}@${v.currentVersion}: ${v.recommendation}`,
      description: v.risk,
      suggestedFix: v.targetVersion
        ? `${v.recommendation} to ${v.targetVersion}`
        : `${v.recommendation} (${v.component})`,
      confidence: v.confidence,
      reference: v.reference,
    }));
  },
};
