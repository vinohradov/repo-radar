import fs from "node:fs";
import path from "node:path";
import { DocOutput } from "@repo-radar/shared";
import type { Task, CollectContext, CollectResult, NormalizedFinding } from "../types.js";
import { walkFiles, readTextSafe, rel } from "../util.js";

const meta = {
  id: "docs-coverage",
  agent: "documentation" as const,
  title: "Documentation coverage",
  description:
    "Builds a documentation inventory (README sections, docs/ tree, package metadata, exported symbols missing JSDoc). The Documentation agent reasons about which gaps matter most for this repo and outlines what to add.",
  ecosystems: ["npm" as const, "maven" as const, "gradle" as const, "pip" as const, "unknown" as const],
  maxFindings: 15,
  maxTokens: 3072,
  effort: "low" as const,
};

const systemPrompt = `You are a Documentation Analysis agent for a repository scanner.

You receive a documentation inventory matrix for a repository: which README
sections exist, what is in the docs/ tree, package metadata, and how many
exported symbols lack doc comments. Your job is to reason about which
documentation gaps genuinely matter for a repository of this shape and produce a
prioritized list of gaps.

Guidance:
- A library with many undocumented public APIs has a real "api" gap; an internal
  app usually does not.
- Missing setup/usage docs matter most for anything others will run or contribute to.
- Do not flag the mere absence of a section if the inventory shows it is covered elsewhere.

Rules:
- "description" at most 2 sentences describing the gap.
- "suggestedContent" one or two sentences outlining what to add.
- Prioritize with severity; only include gaps worth acting on.
- Return an empty list if documentation is adequate for this repo's shape.`;

const README_SECTIONS = [
  { key: "setup", patterns: [/install/i, /getting started/i, /setup/i, /prerequisite/i] },
  { key: "usage", patterns: [/usage/i, /example/i, /quick ?start/i, /how to/i] },
  { key: "architecture", patterns: [/architecture/i, /design/i, /structure/i, /overview/i] },
  { key: "api", patterns: [/\bapi\b/i, /reference/i, /endpoints?/i] },
  { key: "troubleshooting", patterns: [/troubleshoot/i, /faq/i, /common issues/i, /debug/i] },
];

function findReadme(dir: string): { name: string; content: string } | null {
  for (const name of ["README.md", "README.MD", "Readme.md", "README", "README.rst"]) {
    const content = readTextSafe(path.join(dir, name));
    if (content !== null) return { name, content };
  }
  return null;
}

export const docsCoverageTask: Task<typeof DocOutput> = {
  meta,
  systemPrompt,
  outputSchema: DocOutput,

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const readme = findReadme(ctx.repoDir);
    const readmeLen = readme ? readme.content.length : 0;
    const headings = readme
      ? (readme.content.match(/^#{1,3}\s+.+$/gm) ?? []).map((h) => h.replace(/^#+\s+/, "").trim())
      : [];

    const sectionCoverage: Record<string, boolean> = {};
    for (const s of README_SECTIONS) {
      sectionCoverage[s.key] = headings.some((h) => s.patterns.some((p) => p.test(h)));
    }

    // docs/ tree
    const docsDir = path.join(ctx.repoDir, "docs");
    let docsFiles: string[] = [];
    if (fs.existsSync(docsDir)) {
      docsFiles = walkFiles(docsDir, {
        excludes: ctx.excludedPaths,
        exts: [".md", ".mdx", ".rst", ".txt"],
        maxFiles: 200,
      }).map((f) => rel(ctx.repoDir, f));
    }

    // package metadata (npm)
    let pkgMeta: { hasDescription: boolean; scripts: string[] } | null = null;
    const pkgRaw = readTextSafe(path.join(ctx.repoDir, "package.json"));
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as { description?: string; scripts?: Record<string, string> };
        pkgMeta = {
          hasDescription: Boolean(pkg.description && pkg.description.trim()),
          scripts: Object.keys(pkg.scripts ?? {}),
        };
      } catch {
        /* ignore */
      }
    }

    // exported symbols missing a preceding JSDoc block (approximate, JS/TS)
    const srcFiles = walkFiles(ctx.repoDir, {
      excludes: ctx.excludedPaths,
      exts: [".ts", ".tsx", ".js", ".jsx"],
      maxFiles: 1500,
    });
    let exported = 0;
    let documented = 0;
    const exportRe = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z0-9_$]+)/;
    for (const file of srcFiles.slice(0, 800)) {
      const src = readTextSafe(file);
      if (!src) continue;
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (exportRe.test(lines[i].trim())) {
          exported++;
          // look back for a JSDoc close within 2 lines
          const prev = (lines[i - 1] ?? "").trim();
          const prev2 = (lines[i - 2] ?? "").trim();
          if (prev.endsWith("*/") || prev2.endsWith("*/")) documented++;
        }
      }
    }

    const inventory = {
      hasReadme: Boolean(readme),
      readmeBytes: readmeLen,
      readmeHeadings: headings.slice(0, 40),
      readmeSectionCoverage: sectionCoverage,
      docsDirectory: { present: docsFiles.length > 0, files: docsFiles.slice(0, 60) },
      packageMeta: pkgMeta,
      exportedSymbols: { total: exported, withDocComment: documented },
      ecosystems: ctx.ecosystems,
    };

    // Always run — even a sparse inventory is worth the agent's judgment.
    return {
      evidence: inventory,
      itemCount: 1,
      note: readme ? `README + ${docsFiles.length} docs files` : "No README found",
    };
  },

  toFindings(output, scanId): NormalizedFinding[] {
    void scanId;
    return output.gaps.map((g) => ({
      agent: "documentation",
      taskId: meta.id,
      type: g.area,
      severity: g.severity,
      file: null,
      line: null,
      title: g.title,
      description: g.description,
      suggestedFix: g.suggestedContent,
      confidence: g.confidence,
    }));
  },
};
