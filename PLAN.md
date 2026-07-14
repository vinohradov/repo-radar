# Repo Radar — AI-First Repository Analysis & Agent Orchestration Platform

> AI Sprint PoC plan. This document is the single source of truth for the build.
> Source spec: "AI Sprint Project Idea Unwrapping" (Confluence export, June 2026).
> Intended to be executed step-by-step with Claude Code (Opus 4.8).

---

## 1. What we are building

**Repo Radar** is a web application where a user pastes a repository link (or points at a local
checkout), clicks **Start Scan**, and a set of specialized AI agents analyze the repository for:

1. **Security vulnerabilities** — outdated/vulnerable dependency versions
2. **Outdated code** — legacy versions, non-modern patterns (e.g. `for` loops where `Stream`/array
   methods fit, class components vs hooks, deprecated APIs)
3. **Missing / weak documentation** — README gaps, missing setup/usage/architecture docs, undocumented public APIs

Results land on a simple but functional board (dashboard + issues list), and every scan produces
**two reports**:

- **Human report** — concise issue descriptions with suggested fixes, written for people
- **Agent report** — structured JSON with deterministic instructions/commands, written for a
  *fixing* AI agent (e.g. a Claude Code session) to consume and act on

### Design principles (from the spec — do not violate)

| Principle | Concrete rule in this codebase |
|---|---|
| AI is the primary engine, not just a helper | Agents *reason over evidence*; they don't just summarize |
| Script-first, AI-second | Every task runs a deterministic **collector script** first; the AI only sees compact structured facts, never raw repo dumps |
| One action → full analysis | Single `POST /api/scans` kicks off the whole pipeline |
| Minimize token usage | Prompt caching, structured outputs, compact evidence, hard output caps |
| Concise outputs, high signal | Agents are contractually limited (max 2–3 sentences per issue, capped issue counts) |
| Scales by adding agents | Task registry — a new analysis type is a folder with a script + prompt + schema, zero core changes |

---

## 2. Success criteria (sprint demo checklist)

- [x] User submits a repo (URL or local path) and triggers a scan with one click
- [x] Code, Security, and Documentation agents run (parallel where possible) and each independently finds real issues on our own repos (`gbpsui-tool`, `isp-cms-ui`, etc.)
- [x] Dashboard shows scan status live, health tiles, severity heatmap, issues list with filters
- [x] Human report and machine report both downloadable/viewable per scan
- [ ] Machine report can actually be handed to a Claude Code session to fix an issue (live demo moment 🎯) — manifest format verified; the live hand-off is performed at the demo itself
- [x] Token usage per scan is visible in the UI (we track `usage` from every API call; cache hits verified — 2nd scan read 4,352 tokens from cache, cost $0.126 → $0.093)

---

## 3. High-level architecture

```
┌────────────────────────────────────────────────────────────────┐
│  FRONTEND  (Vite + React 18 + TS, "Ivory V2" design system)    │
│  Dashboard · Issues · Reports · Agents · Settings              │
└──────────────▲─────────────────────────────────────────────────┘
               │ REST + SSE (scan progress)
┌──────────────┴─────────────────────────────────────────────────┐
│  BACKEND / ORCHESTRATOR  (Node 20 + TS, Fastify)               │
│                                                                │
│  Scan pipeline:                                                │
│   1. acquire   → clone/read repo into workspace                │
│   2. collect   → run deterministic collector scripts (no AI)   │
│   3. analyze   → run agents IN PARALLEL over collected facts   │
│   4. aggregate → merge, dedupe, score                          │
│   5. report    → Reporting agent → human MD + machine JSON     │
│                                                                │
│  Task Registry (pluggable): tasks/<task-id>/                   │
│    collector.ts   – script that gathers evidence (no tokens)   │
│    prompt.md      – frozen agent prompt (cache-friendly)       │
│    schema.ts      – zod schema = structured output contract    │
│    meta.ts        – name, agent type, severity mapping, cost   │
└──────────────▲─────────────────────────────────────────────────┘
               │ @anthropic-ai/sdk
┌──────────────┴─────────────────────────────────────────────────┐
│  AI AGENT LAYER (Claude API, Messages endpoint)                │
│   · Code Analysis Agent      · Security Agent                  │
│   · Documentation Agent      · Reporting Agent                 │
│   · (optional) Validation Agent, Fix-Proposal Agent            │
└────────────────────────────────────────────────────────────────┘
               │
┌──────────────┴─────────────────────────────────────────────────┐
│  DATA  (SQLite via better-sqlite3 — zero-ops for a PoC)        │
│   scans · findings · reports · agent_runs (token accounting)   │
└────────────────────────────────────────────────────────────────┘
```

**Why this shape:** the orchestrator is plain code (deterministic, debuggable, cheap); the AI is
confined to the four agent call-sites where reasoning is actually needed. This is exactly the
"orchestrated multi-agent model" from the spec, and it is what keeps token usage small.

### Monorepo layout

```
repo-radar/
├── PLAN.md                      ← this file
├── package.json                 ← npm workspaces: client, server, shared
├── shared/                      ← zod schemas + TS types shared FE/BE
│   └── src/
│       ├── contracts/           ← agent I/O contracts (§6)
│       └── domain.ts            ← Scan, Finding, Report types
├── server/
│   └── src/
│       ├── app.ts               ← Fastify bootstrap
│       ├── routes/              ← scans, findings, reports, agents, events (SSE)
│       ├── pipeline/            ← acquire, collect, analyze, aggregate, report
│       ├── ai/                  ← anthropic client wrapper, caching, usage tracking
│       ├── tasks/               ← TASK REGISTRY (one folder per analysis task)
│       │   ├── security-deps/
│       │   ├── code-modernization/
│       │   └── docs-coverage/
│       └── db/                  ← sqlite schema + repositories
└── client/
    └── src/
        ├── theme/               ← Ivory V2 tokens (§7)
        ├── components/          ← V2 primitives (Card, Badge, Chip, Heatmap…)
        ├── pages/               ← Dashboard, Issues, Reports, Agents, Settings
        └── api/                 ← TanStack Query hooks + SSE subscription
```

---

## 4. Backend design

### Stack (mirrors team conventions from gbpsui-tool and siblings)

- **Node 20 + TypeScript**, **Fastify** (fast, typed, schema-validated routes)
- **zod** for every boundary (API bodies, agent outputs, task schemas)
- **better-sqlite3** — file DB, no infra needed for the sprint
- **@anthropic-ai/sdk** for the agent layer
- **vitest** for tests

### Scan pipeline (the orchestrator)

`POST /api/scans { repoUrl | localPath, branch?, config }` creates a scan row and runs:

1. **acquire** — shallow clone (`git clone --depth 1`) into `workspace/<scanId>/`, or symlink a
   local path. Detect ecosystem(s): npm / maven / gradle / pip via lockfile presence.
2. **collect** — for each enabled task, run its `collector.ts`. Collectors are pure scripts —
   **zero AI tokens spent here**. Examples in §5.
3. **analyze** — for each task whose collector produced evidence, one agent call. Tasks run with
   `Promise.allSettled` (parallel execution requirement from the spec). Each call:
   - frozen system prompt from `prompt.md` with `cache_control: {type: "ephemeral"}`
   - compact JSON evidence as the user message
   - `output_config.format` with the task's JSON schema → **guaranteed parseable output, no retries**
   - `max_tokens` capped per task (findings are short by contract)
4. **aggregate** — dedupe by `(file, rule)` fingerprint, apply severity thresholds from scan
   config, compute health scores (Health %, Security level, Code grade — the dashboard tiles).
5. **report** — one Reporting-agent call over the aggregated findings produces the human summary;
   the machine report is assembled *mostly in code* (findings are already structured — the agent
   only writes `instruction` strings for the fixing agent).

Progress events (`scan:phase`, `task:started`, `task:done`, `scan:done`) stream to the UI over
**SSE** (`GET /api/scans/:id/events`).

### API surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/scans` | Start a scan (the one-click action) |
| GET | `/api/scans` | List scans (repo, status, scores, started) |
| GET | `/api/scans/:id` | Scan detail incl. per-task status + token usage |
| GET | `/api/scans/:id/events` | SSE progress stream |
| GET | `/api/scans/:id/findings` | Findings w/ filters: severity, agent, file, text |
| GET | `/api/scans/:id/report?audience=human\|agent` | The two reports |
| GET | `/api/tasks` | Task registry listing (drives the Agents page) |
| GET | `/api/settings` / PUT | Model choice, thresholds, excluded paths |

### Data model

```ts
Scan     { id, repoUrl, branch, status: queued|running|completed|failed,
           phases: {...}, scores: {health, security, code, docs},
           usage: {inputTokens, outputTokens, cacheReadTokens, costUsd}, createdAt }
Finding  { id, scanId, agent, taskId, type, severity: low|medium|high|critical,
           file, line?, title, description, suggestedFix, confidence, fingerprint }
Report   { id, scanId, audience: human|agent, content (md | json), createdAt }
AgentRun { id, scanId, taskId, model, inputTokens, outputTokens,
           cacheCreationTokens, cacheReadTokens, durationMs, status }
```

---

## 5. Task registry — the "script behind every button"

This is the core extensibility mechanism the spec asks for ("everything is expected to be based on
a script with more details behind it"). A **task** is a folder:

```ts
// tasks/<task-id>/meta.ts
export const meta: TaskMeta = {
  id: "security-deps",
  agent: "security",                 // which agent persona runs it
  title: "Dependency vulnerabilities",
  ecosystems: ["npm", "maven", "pip"],
  maxFindings: 25,                   // hard cap → bounded output tokens
  maxTokens: 4096,
};
```

### Sprint task set (v1)

| Task | Collector script (0 tokens) | What the agent adds (the reasoning) |
|---|---|---|
| **security-deps** | Parse lockfiles → `npm audit --json` / OSV.dev batch API → normalized `{name, version, advisories[]}` | Prioritize by real exploitability in *this* repo (is the dep actually imported? dev-only?), pick target versions, explain risk in ≤2 sentences |
| **code-modernization** | AST-grep / regex scans for pattern candidates: `for` loops over collections (Java: suggest Stream; JS: map/filter), `var` usage, class components, deprecated APIs, callback pyramids; emits `{file, line, snippet(≤10 lines), pattern}` | Filter false positives, judge whether modernization genuinely improves the code, write the suggested fix |
| **docs-coverage** | Inventory: README sections present/missing, `docs/` tree, exported symbols without JSDoc, package.json scripts undocumented; emits a coverage matrix | Reason about what documentation *matters most* for this repo's shape, produce prioritized gaps with suggested content outline |

Adding "Test Coverage Agent" or "Performance Agent" later = new folder, no core changes.

**The golden rule:** collectors trim evidence to what the agent needs. The agent never sees whole
files — snippets are capped at ~10 lines, dependency lists exclude anything with no advisory,
docs inventory is a matrix not the docs themselves. This is where 90% of the token savings live.

---

## 6. AI layer

### Models & cost

Default model: **`claude-opus-4-8`** ($5 / $25 per MTok) with **adaptive thinking**
(`thinking: {type: "adaptive"}`) and `output_config.effort` tuned per agent:

| Agent | effort | Rationale |
|---|---|---|
| Code Analysis | `medium` | judgment over pre-filtered candidates |
| Security | `medium` | prioritization over audit data |
| Documentation | `low` | gap analysis over an inventory matrix |
| Reporting | `low` | short synthesis of already-structured findings |
| Validation (stretch) | `high` | adversarial re-check of low-confidence findings |

Model is configurable per-agent on the Settings page (a dropdown: Opus 4.8 / Sonnet 5 / Haiku 4.5
with live pricing shown) — the team can experiment with the cost/quality tradeoff during the
sprint; **Opus 4.8 stays the default**.

### Token-efficiency mechanics (implement all of these)

1. **Prompt caching** — each task's system prompt (`prompt.md`) is frozen bytes with
   `cache_control: {type: "ephemeral"}`. Scanning several repos in a session → ~90% cheaper on the
   repeated prefix. *Rule: never interpolate anything dynamic (dates, scan ids) into the system
   prompt — dynamic content goes in the user message.*
2. **Structured outputs** — every agent call sets `output_config.format` with the zod-derived
   JSON schema (`zodOutputFormat` helper). No parse failures, no "please return valid JSON"
   boilerplate, no retry loops.
3. **Hard output caps** — `maxFindings` per task + `description: max 2–3 sentences` enforced in
   the schema descriptions + `max_tokens` per call. Concise-by-contract, not by hope.
4. **Evidence compaction** — collectors pre-filter (§5). The single biggest lever.
5. **Usage accounting** — record `usage` (incl. `cache_read_input_tokens`) from every response
   into `agent_runs`; surface per-scan cost in the UI. What gets measured gets minimized.
6. **No agent-to-agent chatter** — agents communicate only through structured findings via the
   orchestrator. No conversational relay between agents.
7. **(Stretch) Batch API** — nightly scheduled scans of all team repos at 50% cost via
   `messages.batches`.

### Agent contracts (I/O)

All contracts live in `shared/src/contracts/` as zod schemas. These follow the spec's contract
design (structured, composable, minimal, deterministic):

```jsonc
// Orchestrator input
{ "repository": {"url": "...", "branch": "main", "language": "ts?"},
  "scanConfig": {"includeSecurity": true, "includeCodeQuality": true, "includeDocumentation": true},
  "context": {"priority": "medium", "focusAreas": [], "excludedPaths": ["node_modules", "dist"]} }

// Code Analysis Agent output (per finding)
{ "type": "code-quality | maintainability | modernisation",
  "severity": "low | medium | high | critical",
  "file": "src/x.ts", "line": 42,
  "title": "…", "description": "max 2–3 sentences",
  "suggestedFix": "short actionable recommendation", "confidence": 0.87 }

// Security Agent output (per vulnerability)
{ "component": "lodash", "currentVersion": "4.17.20",
  "severity": "high", "risk": "short risk explanation",
  "recommendation": "upgrade | replace | investigate | configure",
  "targetVersion": "4.17.21", "reference": "CVE/GHSA id", "confidence": 0.95 }

// Documentation Agent output (per gap)
{ "area": "setup | usage | architecture | api | troubleshooting",
  "severity": "medium", "description": "…",
  "suggestedContent": "short outline of what to add", "confidence": 0.8 }

// Reporting Agent output
{ "humanReport": {"summary": "…", "topRisks": ["…"], "recommendedNextSteps": ["…"]},
  "machineActions": [{
     "actionType": "create-ticket | run-command | update-file | notify-owner",
     "priority": "high", "target": "package.json",
     "instruction": "Run `npm i lodash@4.17.21` and re-run the test suite; advisory GHSA-xxxx."
  }] }
```

### The machine report (report type 2)

The agent-oriented report is a self-contained JSON file designed to be pasted into (or fetched by)
a fixing agent such as Claude Code:

```jsonc
{
  "$schema": "repo-radar/fix-manifest@1",
  "repository": {"url": "...", "branch": "...", "commit": "..."},
  "generatedAt": "...", "scanId": "...",
  "actions": [ /* machineActions, sorted by priority, each with file targets,
                  exact commands, acceptance criteria ("tests pass", "npm audit clean") */ ],
  "constraints": {"allowedPaths": ["src/**"], "executionMode": "proposal"}
}
```

Demo flow: download manifest → open Claude Code in the target repo → "apply this fix manifest" →
watch it fix a dependency + open the diff. That's the sprint's money shot.

---

## 7. Frontend design — "Ivory V2"

### Relationship to ivory-react

`ivory-react` (in this workspace) is the team's component library — Bootstrap-based SCSS, Inter +
Sunflower fonts, blue primary. We are **not forking it**; we build a small set of V2 primitives
that *feel* like Ivory's next version: same color DNA and type system, but lighter, rounder,
more spacious — matching the mockup (light sidebar, pill buttons, soft cards, chip filters,
severity heatmap).

### Tokens (extracted from `ivory-react/packages/ivory-styles`)

```css
:root {
  /* Primary scale — verbatim from ivory colors.scss */
  --rr-primary-100:#ebf4ff; --rr-primary-200:#b0d5ff; --rr-primary-300:#75b6ff;
  --rr-primary-400:#3b98ff; --rr-primary-500:#007aff; --rr-primary-600:#0061cc;
  --rr-primary-700:#004899; --rr-primary-800:#002f66; --rr-primary-900:#001733;

  /* Neutrals — verbatim */
  --rr-neutral-100:#f8f9fa; --rr-neutral-200:#e9ecef; --rr-neutral-300:#dee2e6;
  --rr-neutral-400:#ced4da; --rr-neutral-500:#adb5bd; --rr-neutral-600:#6c757d;
  --rr-neutral-700:#495057; --rr-neutral-800:#343a40; --rr-neutral-900:#212529;

  /* Status — softened from ivory's success/danger/alert scales
     (ivory's raw #2df20d green / #f10 red are too loud for a dashboard;
      we use the 600–700 steps as the base instead) */
  --rr-success:#23c20a;  --rr-success-soft:#eeffeb;
  --rr-danger:#cc0e00;   --rr-danger-soft:#ffeceb;
  --rr-warning:#cca900;  --rr-warning-soft:#fffceb;
  --rr-critical:#990a00;

  /* V2 additions (from the mockup): lavender accent for filter chips */
  --rr-accent-soft:#eef0fb; --rr-accent-border:#d8dcf5; --rr-accent-text:#4c4f9c;

  /* Surfaces & shape — the "fresh" feel */
  --rr-bg:#f7f9fc; --rr-surface:#ffffff;
  --rr-border:#e6eaf0;
  --rr-radius-sm:8px; --rr-radius-md:12px; --rr-radius-lg:16px; --rr-radius-pill:999px;
  --rr-shadow-card:0 1px 2px rgb(16 24 40 / .04), 0 1px 8px rgb(16 24 40 / .04);
}
```

**Typography** — same fonts as Ivory: **Inter** (variable) for everything, **Sunflower** for the
XL page headings only; Ivory's weight scale (450 regular / 550 medium / 650 semibold / 700 bold)
and size scale (12/14/16/20/24/32) carried over verbatim. Copy the woff2 files from
`ivory-react/packages/ivory-styles/dist/fonts/`.

### V2 component set (plain React + CSS modules, no Bootstrap dependency)

`AppShell` (sidebar + content) · `SideNav` · `PillButton` (primary CTA, mockup's "Start Scan") ·
`Card` / `StatTile` (label + big value, e.g. *Health 92%*) · `FilterChip` (lavender pills:
Critical / Security / Docs) · `SearchInput` · `SeverityHeatmap` (grid of colored tiles, one per
file/finding-group) · `IssuesTable` (sortable, expandable rows) · `SeverityBadge` ·
`ConfidenceMeter` · `ScanProgress` (phase stepper fed by SSE) · `ReportViewer` (rendered MD +
JSON tree with copy button) · `TokenUsageBar` · `Toast` · `EmptyState`

Where a V2 primitive is overkill (modals, tooltips, dropdowns), we keep the visual language
consistent rather than importing ivory-react itself — the PoC must stand alone.

### Pages (matching the mockup nav)

1. **Dashboard** — Start Scan CTA (top right), search, filter chips, three stat tiles
   (Health % / Security / Code), severity heatmap, "Issues Overview" chart (findings by severity
   per agent — bar chart, follow dataviz skill when building), recent scans list.
2. **Issues** — full findings table with filters (severity, agent, file, search), row expands to
   description + suggested fix + confidence + "copy fix instruction".
3. **Reports** — per scan: tabs *Human* (rendered markdown) / *Agent* (JSON viewer + download
   `fix-manifest.json`).
4. **Agents** — the task registry rendered as cards: agent persona, what its collector does, model
   + effort, per-run avg tokens/cost. Toggle tasks on/off per scan config.
5. **Settings** — default model per agent, severity threshold, excluded paths, API key status.

### Frontend stack

Vite + React 18 + TS + TanStack Query (+ SSE hook) — identical to the team's other tools, minus
the microfrontend/GMA layers (standalone PoC). React Router for the 5 pages. `zod` shared types
from `shared/`.

---

## 8. Implementation phases

Ordered so there's a demoable slice at the end of every phase.

### Phase 0 — Scaffold (½ day)
- npm workspaces monorepo; Vite client; Fastify server; shared package
- Ivory V2 tokens + fonts + AppShell + SideNav; ESLint/Prettier mirroring team config
- SQLite schema + migrations; `.env` for `ANTHROPIC_API_KEY`

### Phase 1 — Pipeline skeleton, no AI (1 day)
- `POST /api/scans` → acquire (clone) → collect (run collectors) → persist raw evidence
- All three collectors working on a real repo (`npm audit`, pattern scan, docs inventory)
- SSE progress; Dashboard shows a scan running phase-by-phase
- **Demo: click Start Scan, watch phases complete, see raw evidence counts**

### Phase 2 — Agents (1–1½ days)
- `ai/` wrapper: prompt caching, structured outputs, usage capture, per-task `effort`
- Three analysis agents live; aggregate step; findings persisted
- Issues page with filters; stat tiles + heatmap computed from findings
- **Demo: full scan of gbpsui-tool with real findings on the board**

### Phase 3 — Reports (½–1 day)
- Reporting agent; human MD + machine fix-manifest JSON; Reports page; downloads
- **Demo: hand fix-manifest to Claude Code, watch a dependency get fixed**

### Phase 4 — Polish & efficiency (remaining time)
- Agents page (registry + toggles + cost stats); Settings page; token usage bar per scan
- Cache-hit verification (`cache_read_input_tokens > 0` on second scan)
- Empty/error states, scan history, README + demo script

### Stretch (only if time remains)
- **Validation agent** — re-checks findings with confidence < 0.7 (hallucination guard from spec)
- **Incremental scans** — only changed files since last scan (`git diff --name-only`)
- **Feedback loop** — 👍/👎 per finding, stored, shown on Agents page
- **Batch API** nightly scans; multi-repo compare view

---

## 9. Risks & open questions

| Risk / question | Mitigation / decision needed |
|---|---|
| Private GitHub repos need auth | v1: accept local paths (repos already in WebstormProjects) + public URLs; PAT support later |
| `npm audit` needs registry access / lockfile | fall back to OSV.dev batch API on bare `package.json` |
| Java/maven support (team has Java repos?) | collectors are ecosystem-pluggable; sprint scope = npm first, maven if time allows |
| Cost ceiling per scan | usage tracked per run; add a configurable hard budget abort (e.g. $0.50/scan) |
| Where does the API key come from | each dev uses own key via `.env`; never committed |
| Findings quality on huge repos | collectors cap candidates (e.g. top 50 by heuristic score) and report "N more not analyzed" — no silent truncation |

---

## 10. Build notes for the implementing agent (Claude Code)

- Follow this file top-to-bottom; phases are ordered dependencies.
- Reuse ivory tokens **verbatim** where §7 says verbatim; do not invent new brand colors.
- Every agent call goes through the single `ai/agentCall.ts` wrapper — no raw SDK calls elsewhere.
- All zod schemas in `shared/` are the contract — FE, BE, and prompts all derive from them.
- Write vitest tests for: collectors (fixture repos), aggregation/dedupe, schema round-trips.
- Keep prompts in `prompt.md` files, byte-stable, with a comment header explaining the cache rule.
- When building charts, load the `dataviz` skill first.
