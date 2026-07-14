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
    "Parses manifests across ecosystems (npm, Maven, Gradle, pip), runs npm audit or queries the OSV.dev advisory database, and normalizes vulnerable-dependency evidence. The Security agent then prioritizes by real exploitability in this repo and picks safe target versions.",
  ecosystems: ["npm" as const, "maven" as const, "gradle" as const, "pip" as const],
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
advisories affecting the installed versions. Evidence may span several
ecosystems (npm, Maven, Gradle, pip); each dependency names the manifest file it
comes from. Your job is NOT to restate the advisory feed — it is to reason about
real risk in THIS repository and produce a prioritized, actionable set of
vulnerabilities.

For each genuine risk:
- Judge exploitability: is the package a runtime dependency or dev-only ("dev"
  flag in the evidence)? Is the vulnerable code path plausibly reachable given
  how the package is typically used?
- Choose the least-disruptive safe target version when one exists.
- Set confidence lower for dev-only or low-reachability issues.
- Echo the dependency's "manifest" value verbatim into the manifest field.

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
  ecosystem: string;
  manifest: string;
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

/** Direct dev-dependency names from package.json (approximation for audit output). */
function devDepNames(repoDir: string): Set<string> {
  const raw = readTextSafe(path.join(repoDir, "package.json"));
  if (!raw) return new Set();
  try {
    const pkg = JSON.parse(raw) as { devDependencies?: Record<string, string> };
    return new Set(Object.keys(pkg.devDependencies ?? {}));
  } catch {
    return new Set();
  }
}

async function runNpmAudit(repoDir: string, signal?: AbortSignal): Promise<DepEvidence[] | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["audit", "--json"], {
      cwd: repoDir,
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
      signal,
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

    const devDirect = devDepNames(repoDir);
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
        dev: devDirect.has(name),
        ecosystem: "npm",
        manifest: "package.json",
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

/* ------------------------------ OSV.dev path ----------------------------- */

interface OsvQuery {
  name: string;
  version: string;
  dev: boolean;
  osvEcosystem: string; // OSV vocabulary: npm | Maven | PyPI
  ecosystem: string; // our vocabulary: npm | maven | gradle | pip
  manifest: string;
}

interface OsvBatchResponse {
  results: { vulns?: { id: string }[] }[];
}

interface OsvVulnDetail {
  id: string;
  summary?: string;
  database_specific?: { severity?: string };
}

/** Fetch real severities for advisory ids (OSV querybatch returns ids only). */
async function fetchOsvSeverities(
  ids: string[],
  signal?: AbortSignal,
): Promise<Map<string, { severity: string; title?: string }>> {
  const out = new Map<string, { severity: string; title?: string }>();
  const unique = Array.from(new Set(ids)).slice(0, 30);
  const settled = await Promise.allSettled(
    unique.map(async (id) => {
      const res = await fetch(`https://api.osv.dev/v1/vulns/${id}`, {
        signal: signal ?? AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(String(res.status));
      const detail = (await res.json()) as OsvVulnDetail;
      return { id, detail };
    }),
  );
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    const sev = s.value.detail.database_specific?.severity;
    out.set(s.value.id, {
      severity: normSev(sev),
      title: s.value.detail.summary,
    });
  }
  return out;
}

async function queryOsv(queries: OsvQuery[], signal?: AbortSignal): Promise<DepEvidence[] | null> {
  if (queries.length === 0) return null;
  try {
    const res = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: queries.map((d) => ({
          package: { name: d.name, ecosystem: d.osvEcosystem },
          version: d.version,
        })),
      }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as OsvBatchResponse;

    const allIds = data.results.flatMap((r) => (r.vulns ?? []).map((v) => v.id));
    const details = await fetchOsvSeverities(allIds, signal);

    const out: DepEvidence[] = [];
    data.results.forEach((r, i) => {
      if (r.vulns && r.vulns.length) {
        const d = queries[i];
        out.push({
          name: d.name,
          version: d.version,
          dev: d.dev,
          ecosystem: d.ecosystem,
          manifest: d.manifest,
          advisories: r.vulns.slice(0, 4).map((v) => ({
            severity: details.get(v.id)?.severity ?? normSev(undefined),
            reference: `https://osv.dev/vulnerability/${v.id}`,
            title: details.get(v.id)?.title ?? v.id,
          })),
        });
      }
    });
    return out;
  } catch {
    return null;
  }
}

/* ------------------------- manifest parsers (0 AI) ------------------------ */

function npmOsvQueries(repoDir: string): OsvQuery[] {
  const pkgRaw = readTextSafe(path.join(repoDir, "package.json"));
  if (!pkgRaw) return [];
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    return [];
  }
  const out: OsvQuery[] = [];
  const add = (deps: Record<string, string> | undefined, dev: boolean) => {
    for (const [name, spec] of Object.entries(deps ?? {})) {
      const version = spec.replace(/^[\^~>=<\s]+/, "").split(" ")[0];
      if (version && /^\d/.test(version)) {
        out.push({ name, version, dev, osvEcosystem: "npm", ecosystem: "npm", manifest: "package.json" });
      }
    }
  };
  add(pkg.dependencies, false);
  add(pkg.devDependencies, true);
  return out;
}

function mavenOsvQueries(repoDir: string): OsvQuery[] {
  const pom = readTextSafe(path.join(repoDir, "pom.xml"));
  if (!pom) return [];
  const out: OsvQuery[] = [];
  const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
  let m: RegExpExecArray | null;
  while ((m = depRe.exec(pom)) !== null && out.length < 100) {
    const block = m[1];
    const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(block)?.[1];
    const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(block)?.[1];
    const version = /<version>\s*([^<\s]+)\s*<\/version>/.exec(block)?.[1];
    const scope = /<scope>\s*([^<\s]+)\s*<\/scope>/.exec(block)?.[1];
    // Skip property-interpolated versions (${...}) — not resolvable without a build.
    if (!group || !artifact || !version || version.includes("${")) continue;
    out.push({
      name: `${group}:${artifact}`,
      version,
      dev: scope === "test",
      osvEcosystem: "Maven",
      ecosystem: "maven",
      manifest: "pom.xml",
    });
  }
  return out;
}

function gradleOsvQueries(repoDir: string): OsvQuery[] {
  const out: OsvQuery[] = [];
  for (const file of ["build.gradle", "build.gradle.kts"]) {
    const src = readTextSafe(path.join(repoDir, file));
    if (!src) continue;
    const coordRe = /['"]([\w.-]+):([\w.-]+):(\d[\w.-]*)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = coordRe.exec(src)) !== null && out.length < 100) {
      out.push({
        name: `${m[1]}:${m[2]}`,
        version: m[3],
        dev: /test/i.test(src.slice(Math.max(0, m.index - 40), m.index)),
        osvEcosystem: "Maven",
        ecosystem: "gradle",
        manifest: file,
      });
    }
  }
  return out;
}

function pipOsvQueries(repoDir: string): OsvQuery[] {
  const req = readTextSafe(path.join(repoDir, "requirements.txt"));
  if (!req) return [];
  const out: OsvQuery[] = [];
  for (const line of req.split("\n")) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*==\s*([\d][\w.]*)\s*(?:#.*)?$/.exec(line);
    if (m && out.length < 100) {
      out.push({
        name: m[1],
        version: m[2],
        dev: false,
        osvEcosystem: "PyPI",
        ecosystem: "pip",
        manifest: "requirements.txt",
      });
    }
  }
  return out;
}

/** Manifests that make an incremental scan re-run this task when changed. */
const MANIFEST_FILES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
]);

export const securityDepsTask: Task<typeof SecurityOutput> = {
  meta,
  systemPrompt,
  outputSchema: SecurityOutput,

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const supported = ctx.ecosystems.filter((e) => meta.ecosystems.includes(e as (typeof meta.ecosystems)[number]));
    if (supported.length === 0) {
      return { evidence: null, itemCount: 0, note: "No supported package ecosystem detected" };
    }

    // Incremental: dependency risk only changes when a manifest/lockfile changes.
    if (ctx.changedFiles !== null) {
      const touched = ctx.changedFiles.some((f) => MANIFEST_FILES.has(path.basename(f)));
      if (!touched) {
        return { evidence: null, itemCount: 0, note: "No dependency manifests changed (incremental)" };
      }
    }

    const deps: DepEvidence[] = [];
    const sources: string[] = [];

    if (supported.includes("npm")) {
      let npmDeps = await runNpmAudit(ctx.repoDir, ctx.signal);
      if (npmDeps && npmDeps.length) {
        sources.push("npm audit");
      } else {
        npmDeps = await queryOsv(npmOsvQueries(ctx.repoDir), ctx.signal);
        if (npmDeps && npmDeps.length) sources.push("OSV.dev (npm)");
      }
      if (npmDeps) deps.push(...npmDeps);
    }
    if (supported.includes("maven")) {
      const found = await queryOsv(mavenOsvQueries(ctx.repoDir), ctx.signal);
      if (found && found.length) {
        deps.push(...found);
        sources.push("OSV.dev (Maven)");
      }
    }
    if (supported.includes("gradle")) {
      const found = await queryOsv(gradleOsvQueries(ctx.repoDir), ctx.signal);
      if (found && found.length) {
        deps.push(...found);
        sources.push("OSV.dev (Gradle)");
      }
    }
    if (supported.includes("pip")) {
      const found = await queryOsv(pipOsvQueries(ctx.repoDir), ctx.signal);
      if (found && found.length) {
        deps.push(...found);
        sources.push("OSV.dev (PyPI)");
      }
    }

    if (deps.length === 0) {
      return { evidence: null, itemCount: 0, note: "No advisories found" };
    }
    return {
      evidence: { ecosystems: supported, sources, dependencies: deps },
      itemCount: deps.length,
      note: `${deps.length} vulnerable dependencies via ${sources.join(" + ")}`,
    };
  },

  toFindings(output, scanId): NormalizedFinding[] {
    void scanId;
    return output.vulnerabilities.map((v) => ({
      agent: "security",
      taskId: meta.id,
      type: v.recommendation,
      severity: SEV_MAP[v.severity] ?? v.severity,
      file: v.manifest ?? "package.json",
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
