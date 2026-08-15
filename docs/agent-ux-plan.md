# 9rh — Agent UX Modernization Plan

*Drafted 2026-08-15 on `claude/agent-ux-feature-plan`. Inspiration reference: oh-my-pi (can1357's fork of Mario Zechner's pi — rich TUI, subagents, LSP) and the current generation of terminal agents. Goal: modern session UX with a stronger identity, without losing what 9rh already is.*

## The one-line thesis

9rh already owns almost every subsystem a modern agent UX needs — an event log (`src/replay/eventLogger.ts`), checkpoints and branches (`src/replay/checkpointManager.ts`, `branchManager.ts`), workdir snapshots (`src/repair/snapshotManager.ts`, `src/reports/workdirSnapshot.ts`), per-turn token capture (`src/agent.ts` `stream_options: { include_usage: true }`), a multi-role orchestrator (`src/orchestrator/`), semantic diffs (`src/semanticDiff.ts`), and a per-turn HTML run report with changes/reasoning/tools/tokens (`src/reports/runReport.ts`). **Almost none of it is surfaced live, in-terminal, across the session.** This plan is mostly wiring and UI, not new engines. That makes it cheap relative to how big it will feel.

## Problem inventory (brain dump → root cause)

| Complaint | What actually happens today | Root cause |
|---|---|---|
| "Ton of text flies off screen, then `done!` — okay, what's done?" | The `done` event prints a green `✓ done` box plus the model's final prose (`src/tui.ts`). The *facts* (files changed, tools, tokens) are computed — but rendered into an HTML report you must open separately (`/report`). | Completion digest lives out-of-terminal; terminal shows model vibes, not harness receipts. |
| "User is in the dark; no persistent brief" | A right-column dashboard exists (`DashboardState` in `src/tui.ts`: activity, current tool, tool history, thinking preview) — but it has no goal line, no session totals, and `runTask()` (`src/index.ts:331`) creates a **fresh renderer per task**, so everything resets every turn. | Dashboard is per-run, not per-session; no "goal / so far" panels. |
| "Usage tracking would be nice" | Usage is already parsed and clamped from the final stream chunk (`src/agent.ts:1213`) and written into run reports. | Never accumulated per session; never rendered in the TUI. |
| "No reverse prompting / clarifying" | Nothing asks the user anything mid-run. Orchestrator roles collect `clarifications: []` (`src/orchestrator/taskState.ts:23`, prompted in `roles.ts`) but the answers array is dead data — flagged, never asked. `repairAgent.ts` even instructs "ask ONE clarifying question" with no mechanism to do so. | No `ask_user` tool; no picker UI hook in the agent loop. |
| "Rich, navigable menu" | The new slash palette is genuinely good (fuzzy filter, ↑↓ focus, Enter runs, Tab completes) and `selectModelFromList` is a solid arrow-key picker. | Commands are a flat list; only `/models` has a picker; no sub-menus, categories, or argument pickers. |
| "Agent teams, main agent + orchestrator" | A five-role pipeline exists (architect → implementer → security-audit → test-strategist → reviewer, `src/orchestrator/roles.ts`) but runs as a **separate non-TUI code path** behind a keyword-regex gate (`dispatch.ts`: `/plan|design|audit|architect|implement/`), dumping a flat text summary at the end. | Orchestrator bypasses the TUI event stream entirely; gate is crude; team progress is invisible. |

## Design pillars (this is the identity)

1. **Mission control, not scrollback archaeology.** The HUD answers four questions at all times: *Goal* (what was asked), *Now* (what's happening), *So far* (what has been done this session), *Cost* (tokens/time). Scrolling text becomes commentary, not the record.
2. **Receipts, not vibes.** A turn ends with a harness-computed digest — files changed with +/- counts, commands run with exit codes, tests detected, tokens spent — sourced from tool results and snapshots, *not* from the model's self-report. The model's prose renders below the receipts. This is the direct fix for "what's done?" and the strongest brand position available: most agents summarize themselves; 9rh proves it.
3. **Ask early, ask cheap.** Clarifying questions are a first-class tool with a first-class picker, used before burning ten iterations on the wrong interpretation.
4. **Progressive disclosure.** Quiet transcript by default (previews stay capped), full detail one keypress or command away.
5. **The terminal is the product.** Keep the zero-dependency ANSI approach (chalk + commander + openai only), the playful spinner labels, the splash. No ink/blessed rewrite — the raw-ANSI craft *is* part of the identity.

## Workstreams

Effort scale: **S** ≈ a PR-sized day, **M** ≈ 2–4 days, **L** ≈ a week+. Every workstream lands with tests (repo convention — `tui.test.ts` alone is 43K).

### WS1 — Session Ledger (the foundation) — S

One append-only per-session record that everything else reads.

- Add a `SessionLedger` owned by `SessionState` (`src/index.ts`), fed from the same `AgentEvent` stream the TUI consumes plus tool results and the parsed `chunk.usage`.
- Reuse the event shapes in `src/replay/eventSchema.ts` — do not invent a second event vocabulary. The replay logger already knows how to describe a run; the ledger is just the in-memory, cross-turn reduction of it.
- Reducer → `LedgerSummary`: turns run (goal text + outcome), files touched (dedup, with change counts), commands executed (+ exit codes), tokens in/out per turn and total, checkpoints taken, elapsed time.
- New `/brief` command prints the summary in the transcript.

Everything in WS2–WS4 and WS7 is a view over this one structure. This is deliberately the laziest possible substrate: one array plus one reducer.

### WS2 — The done digest ("what's done") — M

Replace the bare `✓ done` box with receipts:

```
╔══════════════════════════════════════════════╗
║ ✓ done · 3m42s · 12.4k in / 3.1k out         ║
║ Goal   fix flaky retry test                  ║
║ Files  src/backends/router.ts  +18 −4        ║
║        src/__tests__/router.test.ts  +22 −1  ║
║ Ran    npm test → ✓ 214 passed               ║
║ Report ~/.9rh/reports/2026-08-15-…​.html      ║
╚══════════════════════════════════════════════╝
```

- Data sources all exist: `workdirSnapshot.ts` / `semanticDiff.ts` for file deltas, tool results for commands and exit codes, ledger for tokens/time, `runReportData.ts` already aggregates most of this for the HTML report — extract that aggregation so terminal digest and HTML report share it.
- Model prose renders *below* the digest, and the system prompt gains a required tail: **"Next steps / open questions"** (may be "none"). That's the reverse-prompting hook at turn boundaries — the agent ends turns by telling you what it wants from you.
- Acceptance: digest appears even when the model's final message is a wall of text or empty; nothing in the digest originates from model claims.

### WS3 — Dashboard v2: the persistent brief — M

- Restructure the right-column dashboard into panels: **GOAL** (compressed current task), **NOW** (existing activity/current-tool/thinking preview — already built), **SESSION** (turn count, files touched, tokens total, elapsed, model, sandbox status chip), **LAST** (one-line outcome of the previous turn, from the ledger).
- Fix lifetime: one renderer owned by the REPL loop for the whole session; `runTask()` stops constructing its own (`src/index.ts:331` and `:495` currently both call `createTuiRenderer`). One-shot mode keeps per-run behavior.
- Existing geometry/resize machinery (`computeGeometry`, SIGWINCH debounce, ghost-erase) carries over unchanged.
- **Narrow terminals** (decided): below the side-column threshold, degrade to a condensed one-line HUD merged into the spinner line — `⠸ npm test · 41s · iter 3/6 · 12.4k tok · 2 files · ⛨ seatbelt`. The spinner's `\r`-rewrite machinery already owns that line, so no scroll-region tricks. Below the point where even that fits (~50 cols), drop the HUD entirely rather than render noise.

### WS4 — Usage tracking — S

- Accumulate `chunk.usage` into the ledger per turn; render totals in the SESSION panel and per-turn in the done digest.
- `/usage` command: per-turn table; per-role breakdown when the orchestrator ran.
- **Tokens only — no dollar costs anywhere** (decided). 9rh is multi-backend (Ollama is free, router combos mix models); any price table rots. If demand appears later, a user-maintained price map can bolt onto the ledger without schema changes.

### WS5 — Streaming legibility — S/M

The existing throttled thinking snapshots and 6-line tool previews are the right shape. Additions:

- **Verbosity budget** in the agent system prompt (decided): short paragraphs between actions are welcome — 2–3 sentences, never Odyssey-length — with long prose reserved for the final message. The flood is a prompt problem before it's a rendering problem.
- **`/quiet` toggle** (decided): render-side, instant, flippable mid-session. Collapses live narration to its dimmed first line; tool previews, digests, and the final message are unaffected. Default off — paragraphs stay visible.
- Elapsed time on the spinner line (`⚙ npm test · 41s`) — the dashboard has `startedAt` already.
- `/last [n]` to reprint the full output of a recent tool result (from the ledger) — makes the 6-line cap safe instead of lossy.
- Markdown-lite rendering for the final message only (bold headers, dim code fences). No mid-stream reflowing.
- Keep the playful spinner labels and splash exactly as they are.

### WS6 — Reverse prompting: the `ask_user` tool — M

- New tool in `src/tools.ts`: `ask_user({ question, options?: string[], allow_free_text?: bool })`. Agent loop pauses, TUI renders an arrow-key picker, answer returns as the tool result.
- Generalize `selectModelFromList` (`src/index.ts:371`) into a reusable `pickFromList` — the raw-mode/arrow/mouse/Esc machinery is already written and tested there.
- Policy via system prompt: ambiguous scope → up to 3 upfront questions before touching files; destructive or irreversible action → confirm first.
- Non-TTY / `--yes` fallback: pick the stated default, log the assumption into the ledger (and thus the digest — assumptions become visible receipts).
- Wire the orchestrator's dead `clarifications` arrays through it: architect flags ambiguities → harness asks → answers feed the implementer. Turns existing dead data into the team's front door.

### WS7 — Teams on stage: orchestrator v2 — L

The engine (roles, taskState, conflictResolver, performanceCache) is fine. The UX is the gap.

- Emit orchestrator progress as the **same `AgentEvent` stream** the TUI already renders — delete the parallel `emitOrchestratorTelemetry` stderr path. Role transitions become iteration-header-style transcript sections (`─── architect ───`).
- Dashboard gains a **TEAM panel** when a pipeline is active: one lane per role — `architect ✓ · implementer ⚙ 1m02s · security …` — with per-role token counts (WS4 data).
- Replace the keyword-regex gate (decided): **auto-suggest via WS6** — the model proposes escalation with a pipeline preview ("This looks multi-step — run as a team?") — plus manual `/team <task>` and the existing `--orchestrate` flag. Regex heuristics guessing user intent is exactly the opaqueness this plan is deleting.
- Later (own PR, only if wanted): user-defined role presets in config; parallel role dispatch where the DAG allows.

### WS8 — Menu depth: palette v2 — S

- Category grouping in the palette and `/help` (session · agent · router · sandbox · reports) — `commands.ts` already carries `usage` strings per command; render them as dim arg-hints in palette rows.
- Sub-pickers via `pickFromList` for argful commands: `/switch` → model picker (exists, just wire it from the palette path), `/team` → role-preset picker, `/rewind` → checkpoint picker (WS9), `/dir` → recent-dirs picker.
- Palette already handles focus/Enter/Tab/Esc correctly — no rework, only content.

### WS9 — Identity bets (the differentiators)

Ranked; each is a feature most terminal agents don't have, and each is disproportionately cheap because the subsystem already exists:

1. **`/rewind` — turn-level time travel.** `checkpointManager`, `branchManager`, and `snapshotManager` already exist with no UI. Picker over the ledger's turn list → restore the workdir snapshot from that point. "The agent with an undo button" is a headline feature, and it's mostly plumbing. **V1 is workdir-restore only** (decided); conversation-fork via `branchManager` is backlog until the "you are now on branch 2 of this session" UX is designed.
2. **Receipts as brand (WS2).** Lean into it in wording: the digest is literally titled *receipts*. "9rh shows receipts" is a memorable, defensible identity — reports already made this true post-hoc; WS2 makes it true live.
3. **`/replay` — flight recorder in the TUI.** `replayEngine` + `divergenceDetector` exist. Re-render any past session's event log through the live renderer at adjustable speed. Unique among peers; great for debugging agent behavior and for demos.
4. **Sandbox chip.** Surface the existing sandbox status (`/sandbox`) as a persistent dashboard chip (`⛨ seatbelt` / `⛨ container` / `⚠ none`) and stamp it into every digest. 9rh's sandbox-awareness is a real differentiator today — it should be visible without asking.
5. **Assumption ledger.** From WS6's non-interactive fallback: every assumption the agent made silently is listed in the digest. Nobody else does this; it directly attacks "the user is in the dark."

## Sequencing

| Phase | Workstreams | Outcome |
|---|---|---|
| **1 — "Never in the dark"** | WS1 → WS4 → WS2 → WS3 | Ledger, live token counts, done-digest receipts, persistent session brief. Kills the top three complaints. Four PR-sized changes. |
| **2 — "Dialogue"** | WS6 → WS8 → WS5 | Clarifying questions with pickers, deeper palette, calmer streaming. |
| **3 — "Teams on stage"** | WS7 → WS9 (rewind, replay) | Orchestrator visible as a team with lanes; time travel; flight recorder. |

Phase 1 is deliberately front-loaded with S/M work: it changes the *felt* experience of every single run and requires no design debates. Phase 3 is where the wow lives, but shipping it before Phase 1 would put more agents on stage with the same darkness problem multiplied.

## Non-goals

- No TUI framework adoption (ink/blessed/etc.) — the raw-ANSI renderer works, is tested, and is identity.
- No web UI — 9router's dashboard owns that surface.
- No new runtime dependencies unless something is truly unbuildable without one.
- No orchestrator engine redesign — role logic and conflict resolution stay as-is; only their visibility and entry points change.

## Decisions (locked 2026-08-15)

1. **Cost display** — tokens only, everywhere. No price map, no dollars. Revisit only if demand appears.
2. **Rewind v1** — workdir snapshot restore only. Conversation fork = backlog.
3. **Team escalation** — auto-suggest via `ask_user` with pipeline preview; `/team` and `--orchestrate` for manual.
4. **Live narration** — short paragraphs allowed (2–3 sentences, capped in prompt); `/quiet` render toggle collapses them to a dimmed first line for users who want silence.
5. **Narrow terminals** — condensed one-line HUD on the spinner line while it can show something useful (activity · elapsed · iter · tokens · files · sandbox); below ~50 cols, no HUD at all.
