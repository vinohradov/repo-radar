import path from "node:path";
import { CodeAnalysisOutput } from "@repo-radar/shared";
import type { Task, CollectContext, CollectResult, NormalizedFinding } from "../types.js";
import { walkFiles, readTextSafe, rel, snippet } from "../util.js";

const meta = {
  id: "code-modernization",
  agent: "code" as const,
  title: "Outdated code patterns",
  description:
    "Scans source files for candidate legacy patterns (index for-loops, var, class components, deprecated APIs, CommonJS in TS). The Code agent filters false positives and judges which modernizations genuinely improve the code.",
  ecosystems: ["npm" as const, "maven" as const, "gradle" as const],
  maxFindings: 30,
  maxTokens: 8192,
  effort: "medium" as const,
};

const systemPrompt = `You are a Code Analysis agent for a repository scanner.

You receive candidate code locations flagged by cheap pattern-matching, each with
a file path, line, a short snippet, and the matched pattern label. Pattern matches
are noisy — many are false positives. Your job is to apply judgment.

For each candidate, decide:
- Is this genuinely outdated or suboptimal in modern JS/TS/Java, or is it fine as-is?
- Would modernizing it measurably improve readability, safety, or maintainability?
- If yes, what is the concrete modern replacement?

Report ONLY the candidates that represent real, worthwhile improvements. Drop
anything that is idiomatic, intentional, or where a rewrite would not help.

Rules:
- "description" at most 2-3 sentences; explain the concrete downside.
- "suggestedFix" one sentence naming the modern replacement (e.g. "Use Array.map instead of an index loop").
- Use the file/line from the candidate verbatim.
- Set "type" to modernisation, maintainability, or code-quality.
- confidence reflects how clearly this improves the code.
- Return an empty list if none of the candidates are worth acting on.`;

interface Rule {
  id: string;
  label: string;
  exts: string[];
  regex: RegExp;
}

const RULES: Rule[] = [
  { id: "var", label: "`var` declaration (prefer let/const)", exts: [".js", ".jsx", ".ts", ".tsx"], regex: /(^|[^.\w])var\s+[a-zA-Z_$]/ },
  { id: "index-for", label: "index for-loop over .length (prefer map/filter/for-of)", exts: [".js", ".jsx", ".ts", ".tsx", ".java"], regex: /for\s*\(\s*(?:var|let|int|final)?\s*\w+\s*=\s*0\s*;[^;]*\.(length|size\(\))\s*;/ },
  { id: "class-component", label: "React class component (prefer function component + hooks)", exts: [".jsx", ".tsx", ".js", ".ts"], regex: /extends\s+(React\.)?(Component|PureComponent)\b/ },
  { id: "deprecated-lifecycle", label: "deprecated React lifecycle", exts: [".jsx", ".tsx", ".js", ".ts"], regex: /\b(componentWillMount|componentWillReceiveProps|componentWillUpdate)\b/ },
  { id: "commonjs-require", label: "CommonJS require() in TypeScript (prefer import)", exts: [".ts", ".tsx"], regex: /(^|[^.\w])require\s*\(/ },
  { id: "new-buffer", label: "new Buffer() (deprecated, unsafe)", exts: [".js", ".jsx", ".ts", ".tsx"], regex: /new\s+Buffer\s*\(/ },
  { id: "substr", label: "String.substr() (deprecated, prefer slice)", exts: [".js", ".jsx", ".ts", ".tsx"], regex: /\.substr\s*\(/ },
  { id: "legacy-collection", label: "legacy Java collection (Vector/Hashtable)", exts: [".java"], regex: /\bnew\s+(Vector|Hashtable)\s*[<(]/ },
  { id: "java-index-stream", label: "Java loop that could use Stream", exts: [".java"], regex: /for\s*\(\s*int\s+\w+\s*=\s*0\s*;/ },
];

const ALL_EXTS = Array.from(new Set(RULES.flatMap((r) => r.exts)));
const MAX_CANDIDATES = 45;

interface Candidate {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
}

export const codeModernizationTask: Task<typeof CodeAnalysisOutput> = {
  meta,
  systemPrompt,
  outputSchema: CodeAnalysisOutput,

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const files = walkFiles(ctx.repoDir, {
      excludes: ctx.excludedPaths,
      exts: ALL_EXTS,
      maxFiles: 2500,
    });
    const candidates: Candidate[] = [];
    let truncated = 0;

    outer: for (const file of files) {
      const ext = path.extname(file);
      const base = path.basename(file);
      if (base.endsWith(".min.js") || base.endsWith(".bundle.js")) continue;
      const applicable = RULES.filter((r) => r.exts.includes(ext));
      if (applicable.length === 0) continue;
      const src = readTextSafe(file);
      if (!src) continue;
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        // Skip minified / generated lines — they blow up evidence size and
        // are almost always false positives.
        if (lines[i].length > 300) continue;
        for (const rule of applicable) {
          if (rule.regex.test(lines[i])) {
            if (candidates.length >= MAX_CANDIDATES) {
              truncated++;
              continue;
            }
            candidates.push({
              file: rel(ctx.repoDir, file),
              line: i + 1,
              pattern: rule.label,
              snippet: snippet(src, i + 1, 1),
            });
          }
        }
      }
      if (candidates.length >= MAX_CANDIDATES && truncated > 200) break outer;
    }

    if (candidates.length === 0) {
      return { evidence: null, itemCount: 0, note: "No candidate patterns found" };
    }
    return {
      evidence: { candidates },
      itemCount: candidates.length,
      note:
        truncated > 0
          ? `${candidates.length} candidates analyzed (${truncated}+ more not analyzed)`
          : `${candidates.length} candidates`,
    };
  },

  toFindings(output, scanId): NormalizedFinding[] {
    void scanId;
    return output.issues.map((i) => ({
      agent: "code",
      taskId: meta.id,
      type: i.type,
      severity: i.severity,
      file: i.file,
      line: i.line,
      title: i.title,
      description: i.description,
      suggestedFix: i.suggestedFix,
      confidence: i.confidence,
    }));
  },
};
