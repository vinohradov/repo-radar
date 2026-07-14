import path from "node:path";
import { SecretsOutput } from "@repo-radar/shared";
import type { Task, CollectContext, CollectResult, NormalizedFinding } from "../types.js";
import { walkFiles, readTextSafe, rel } from "../util.js";

const meta = {
  id: "secrets-scan",
  agent: "security" as const,
  title: "Hardcoded secrets",
  description:
    "Scans source and config files (including .env) for hardcoded credentials — API keys, tokens, private keys, JWTs. Secrets are REDACTED before leaving the collector. The Security agent then filters placeholders/examples from real leaks and recommends rotation.",
  ecosystems: ["npm" as const, "maven" as const, "gradle" as const, "pip" as const, "unknown" as const],
  maxFindings: 20,
  maxTokens: 4096,
  effort: "medium" as const,
};

const systemPrompt = `You are a Security agent specialized in detecting leaked secrets.

You receive candidate secret locations found by pattern matching. The secret
values are REDACTED (only a short prefix and length are shown) — you must never
ask for or reconstruct the full value. Each candidate has a file, line, the kind
of secret, and the redacted line with surrounding context.

Your job is judgment: distinguish REAL leaked secrets from false positives —
placeholders ("your-api-key-here", "changeme", "example"), test fixtures, docs,
and obvious dummy values. Report only credible leaks.

For each real leak:
- Severity: live/production credentials and private keys are critical/high;
  low-risk or clearly-scoped tokens are medium.
- risk: one or two sentences on the blast radius if this leaked.
- recommendation: rotate the credential AND move it to an environment variable
  or secret manager; if it is committed, purge it from git history.
- confidence: how sure you are this is a real secret (lower for ambiguous cases).

Return an empty list if every candidate is a placeholder or false positive.`;

interface SecretPattern {
  kind: string;
  re: RegExp;
  group?: number;
}

// Ordered: more specific patterns first so the redactor masks the right token.
const PATTERNS: SecretPattern[] = [
  { kind: "AWS access key ID", re: /AKIA[0-9A-Z]{16}/ },
  { kind: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "Stripe secret key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "Private key block", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { kind: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    kind: "Hardcoded credential",
    re: /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*['"]([^'"\s]{8,})['"]/i,
    group: 1,
  },
];

const SKIP_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Cargo.lock",
]);
const SKIP_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".gz", ".tar", ".mp4", ".mp3", ".wasm", ".map", ".lock",
]);

const MAX_CANDIDATES = 40;

/** Mask a secret: reveal only a tiny prefix + length so nothing usable leaks. */
function mask(secret: string): string {
  const head = secret.slice(0, 3);
  return `${head}***(redacted, ${secret.length} chars)`;
}

interface Candidate {
  file: string;
  line: number;
  kind: string;
  redacted: string;
}

export const secretsScanTask: Task<typeof SecretsOutput> = {
  meta,
  systemPrompt,
  outputSchema: SecretsOutput,

  async collect(ctx: CollectContext): Promise<CollectResult> {
    let files = walkFiles(ctx.repoDir, {
      excludes: ctx.excludedPaths,
      includeDotFiles: true,
      maxFiles: 4000,
    });
    // Incremental: only re-scan files changed since the last completed scan.
    if (ctx.changedFiles !== null) {
      const changed = new Set(ctx.changedFiles);
      files = files.filter((f) => changed.has(rel(ctx.repoDir, f)));
      if (files.length === 0) {
        return { evidence: null, itemCount: 0, note: "No relevant files changed (incremental)" };
      }
    }
    const candidates: Candidate[] = [];
    let truncated = 0;

    for (const file of files) {
      const base = path.basename(file);
      if (SKIP_BASENAMES.has(base)) continue;
      if (base.endsWith(".min.js")) continue;
      if (SKIP_EXTS.has(path.extname(file).toLowerCase())) continue;

      const src = readTextSafe(file);
      if (!src) continue;
      const lines = src.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 400) continue; // skip minified / data blobs
        for (const p of PATTERNS) {
          const m = p.re.exec(line);
          if (!m) continue;
          if (candidates.length >= MAX_CANDIDATES) {
            truncated++;
            continue;
          }
          const secret = m[p.group ?? 0];
          const redacted = line.split(secret).join(mask(secret)).trim().slice(0, 200);
          candidates.push({ file: rel(ctx.repoDir, file), line: i + 1, kind: p.kind, redacted });
          break; // one finding per line is enough
        }
      }
    }

    if (candidates.length === 0) {
      return { evidence: null, itemCount: 0, note: "No secret-like patterns found" };
    }
    return {
      evidence: { candidates },
      itemCount: candidates.length,
      note:
        truncated > 0
          ? `${candidates.length} candidate secrets (${truncated}+ more not analyzed)`
          : `${candidates.length} candidate secrets (redacted)`,
    };
  },

  toFindings(output: SecretsOutput, scanId): NormalizedFinding[] {
    void scanId;
    return output.secrets.map((s) => ({
      agent: "security",
      taskId: meta.id,
      type: "secret",
      severity: s.severity,
      file: s.file,
      line: s.line,
      title: `${s.kind} in ${s.file}`,
      description: s.risk,
      suggestedFix: s.recommendation,
      confidence: s.confidence,
      reference: null,
    }));
  },
};
