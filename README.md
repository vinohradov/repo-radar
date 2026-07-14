# Repo Radar

AI-first repository analysis & agent-orchestration PoC. Point it at a repo, click
**Start Scan**, and specialized AI agents (code, security, documentation) analyze it
and produce two reports: a human summary and a machine **fix-manifest** a coding
agent can act on.

See [`PLAN.md`](./PLAN.md) for the full design.

## How it works

```
acquire → collect (deterministic scripts, 0 tokens) → analyze (parallel agents)
        → aggregate (dedupe + score) → validate (re-check low-confidence findings)
        → report (human MD + agent JSON)
```

The **script-first** design is the point: cheap collector scripts gather compact
evidence (npm audit / OSV across npm, Maven, Gradle and pip; pattern scan; docs
inventory), and the AI only reasons over that evidence — never raw file dumps.
That, plus prompt caching, structured outputs, and per-task token caps, keeps AI
usage small.

Beyond the core pipeline:

- **Validation agent** — findings with confidence < 0.7 get an adversarial
  re-check; rejected findings are excluded from scores and reports (hallucination
  guard).
- **Hard token budget** — each agent call reserves its `max_tokens` against a
  per-scan cap before launching; calls that can't reserve are skipped, even with
  all tasks running in parallel.
- **Incremental scans** — re-scan only files changed since the last completed
  scan of the same repo (`git diff` against the stored commit).
- **Cancellation** — a running scan can be cancelled; in-flight API calls and
  collector subprocesses are aborted.
- **Task toggles** — turn tasks on/off globally (Agents page) or per scan
  (chips in the scan form).
- **Feedback loop** — 👍/👎 per finding, tallied per task on the Agents page.
- **Nightly Batch-API scans** — re-scan every known repo on a schedule via the
  Message Batches API at 50% cost (Settings page, plus a "Run now" button).
- **Compare view** — latest full scan per repository side by side, worst health
  first.

## Prerequisites

- Node 20+
- An Anthropic API key (optional — without it, scans run the collectors and skip
  the AI analyze phase gracefully, so you can still see the pipeline work)

## Setup

```bash
npm install
cp .env.example .env      # then paste your ANTHROPIC_API_KEY into .env
```

## Run (development)

```bash
npm run dev               # server on :8787, client on :5273 (proxies /api)
```

Open http://localhost:5273.

Run the two sides separately if you prefer:

```bash
npm run dev:server
npm run dev:client
```

## Build / typecheck / test

```bash
npm run build             # shared + server (tsc) + client (vite)
npm run typecheck
npm run test              # server unit tests (vitest)
```

## Demo script (≈3 min)

1. `npm run dev`, open the app.
2. **Start Scan** → *Local path* → paste a repo path (e.g. one of the sibling
   projects in this workspace). Click **Run scan**.
3. Watch the **Scan progress** stepper advance live (SSE): acquire → collect →
   analyze → aggregate → report. The collect phase reports real evidence counts
   (e.g. "46 vulnerable dependencies via npm audit", "38 candidates").
4. **Dashboard** shows Health / Security / Code tiles, the severity heatmap, and
   the Issues Overview chart. **Issues** lists every finding with filters and a
   "copy fix instruction" button.
5. **Reports** → *Human report* for the readable summary; *Agent report* for the
   `fix-manifest.json`. Click **Download .json**.
6. The money shot: open a coding agent (e.g. Claude Code) in the target repo and
   ask it to apply the downloaded fix manifest — each action is deterministic with
   its own acceptance criteria.
7. **Agents** shows the task registry with per-run token/cost stats; **Settings**
   lets you pick a model per agent and see live pricing.

## Extending — add an analysis task

A task is a folder under `server/src/tasks/<id>/` exporting a `Task`:

- `collect(ctx)` — a deterministic script that returns compact evidence
- `systemPrompt` — a frozen, cache-friendly prompt
- `outputSchema` — a zod schema (the structured-output contract)
- `toFindings(output)` — maps the agent output to normalized findings

Register it in `server/src/tasks/registry.ts`. Nothing else changes — it shows up
on the Agents page and runs in the next scan.

## Layout

```
shared/   zod contracts + domain types + pricing (single source of truth)
server/   Fastify orchestrator, SQLite, task registry, AI wrapper
client/   Vite + React "Ivory V2" UI (Dashboard/Issues/Reports/Agents/Settings)
```
