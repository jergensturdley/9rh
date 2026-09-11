# 9rh Desktop: Agent Workbench and 9router Console

Status: design, 2026-09-11. Built autonomously from the request "create a
desktop work / agent application for this CLI tool, include SOTA agentic
features and an interface for interacting with the 9router proxy built into
the app." Assumptions the user did not confirm are marked **assumed**.

## Context

9rh is a terminal coding agent (`src/index.ts`) over a library core
(`src/main.ts`): a streaming ReAct `Agent` that emits typed `AgentEvent`s,
a `Backend` abstraction (9router or any OpenAI-compatible endpoint), a
`SessionLedger` with per-turn receipts, `/rewind` (workdir restore),
`/replay` (flight recorder), a multi-role `Orchestrator`, and sandboxed
tools. The TUI is raw ANSI; there is no GUI.

9router (v0.5.75, installed at `~/.local/bin/9router`, listening on
`127.0.0.1:20128`) exposes an OpenAI-compatible `/v1/*` API and a native
`/api/*` REST API. The native API accepts either a bearer API key or the
`x-9r-cli-token` header (sha256 of machine id + salt + `~/.9router/auth/cli-secret`,
already implemented as `getCliToken()` in `src/init.ts`). Verified live:
the CLI token authorizes `/api/providers`, `/api/combos`, `/api/keys`,
`/api/models`, `/api/settings`, `/api/version`, `/api/usage/*`,
`/api/tunnel/status`; the dashboard pages (`/dashboard`) redirect to a
cookie login and do not honor the header.

The 2026-08-15 UX plan listed "no web UI" as a non-goal because 9router's
dashboard covers router administration. This request supersedes that
non-goal: the user wants a desktop app that hosts the agent and the router
console together.

## Goals

- A desktop app that runs 9rh agent sessions against local repositories
  with everything the TUI shows, plus what a GUI can show better: parallel
  sessions, collapsible tool output, diffs, receipts, HUD panels.
- Human-in-the-loop as first-class UI: clarifying questions, tool
  approvals with risk levels, stop and abort.
- The existing identity bets, live: receipts, rewind, replay, team lanes,
  sandbox chip, assumption ledger.
- A built-in 9router console: status and process control, providers,
  combos, API keys, models, usage, settings summary, and the stock
  dashboard embedded for anything the console does not cover.
- Reuse the 9rh library for every engine. The desktop app is UI plus
  wiring; it introduces no second agent loop, ledger, or router client
  logic beyond a thin fetch wrapper.

## Non-goals

- No changes to agent behavior, tool sandboxing, or the CLI's UX.
- No packaging pipeline beyond an `electron-builder` config stub; signing
  and notarization are out of scope.
- No cloud sync, accounts, or telemetry.
- No dollar cost display for 9rh sessions (matches the locked UX decision);
  9router's own usage endpoints report cost and the console shows those
  numbers as 9router reports them.
- No editing of 9router settings beyond what the console explicitly lists
  below; the embedded dashboard covers the rest.
- No in-app credential entry for the dashboard login. The user types their
  9router password into the embedded 9router page; the app never sees it.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Shell | Electron 44 + electron-vite 5 | 9rh is ESM TypeScript; Electron's main process imports `9rh` directly. Tauri would need a Node sidecar and a Rust bridge for no gain. **assumed** |
| Renderer | React 19 + TypeScript, plain CSS with variables, no state library, no CSS framework | Rich streaming UI needs a component model; nothing else earns a dependency. **assumed** |
| Location | `desktop/` subfolder with its own `package.json`, depending on `"9rh": "file:.."` | Root package stays publishable and unchanged apart from additive exports. |
| Session hosting | In the Electron main process, one `SessionHost` per session | All engine work is async already. `// ponytail:` note marks the utilityProcess upgrade path if a tool ever blocks the UI. |
| Router auth | `x-9r-cli-token` via `getCliToken()` for `/api/*`; bearer key for `/v1/*` | Same mechanism the CLI's slash commands use today. |
| Dashboard | `<webview>` tag with `partition="persist:9router"` pointed at `http://127.0.0.1:20128/dashboard` | Cookie login persists across launches; least code. |
| Persistence | 9rh's `~/.9rh/config.json` for model/provider defaults; `~/.9rh/desktop.json` for app state (recent workdirs, window bounds, last session settings) | No electron-store dependency. |
| Tests | Vitest in `desktop/` for pure modules (router client, event reducers, diff, session host with a fake agent) | Vite is already present; Jest at the root stays untouched. |

## Library changes (root package)

`src/main.ts` gains additive exports so the desktop app imports one
package. No existing export changes.

- Ledger: `SessionLedger`, `buildTurnDigest`, types `LedgerView`,
  `LedgerTurn`, `TurnDigest`, `DigestFileEntry`, `DigestCommandEntry`.
- Rewind: `planRewind`, `applyRewind`, types `RewindPlan`, `RewindResult`.
- Replay: `listRunLogs`, `readEventLog`, `renderEventLog`, `mapReplayEvent`,
  types `RunLogInfo`, `ReplayEvent`, `ReplayRenderOptions`.
- Config and paths: `readUserConfig`, `updateUserConfig`,
  `resolveConfiguredModel`, type `UserConfig`, `ninerhHome`, `ninerhDir`.
- Router auth: `getCliToken`, `readFirstApiKey`, `NINE_ROUTER_NATIVE`.
- Presets: `getProviderPreset`, `listProviderPresetIds`, type `ProviderPreset`.
- Agent HITL types: `AskUserRequest`, `AskUserResponse`,
  `ToolApprovalRequest`, `ToolApprovalDecision`, `ToolRiskLevel`.
- Misc engines: `compressUserInput`, `shouldSuggestTeam`, `discoverSkills`
  (type `SkillManifestEntry`), `getSandboxStatus` (type `SandboxStatus`),
  `applyTeamEvent` and type `TeamLane` (pure reducer in `src/tui.ts`).

Blast radius: additive re-exports only; `gitnexus_impact` on `main.ts`
exports reports no callers inside the repo, and the test suite must stay
green.

## Architecture

```
desktop/
  package.json               electron, electron-vite, react, vitest
  electron.vite.config.ts    main (ESM), preload, renderer
  src/
    shared/
      ipc.ts                 channel names + request/response/event types
      routerTypes.ts         9router record shapes (Provider, Combo, ApiKey, RouterModel, UsageStats...)
    main/
      index.ts               app lifecycle, window, IPC registration
      sessionHost.ts         one agent session: Agent or Orchestrator, ledger, HITL bridge
      sessionRegistry.ts     create/list/remove sessions; fan events to renderer
      routerClient.ts        fetch wrapper over 9router /api/* with CLI token
      routerProcess.ts       start (ensureRouter), stop (/api/shutdown), restart
      backendService.ts      detectBackend, listModels, presets
      replayService.ts       list logs, play a log into a session's event stream
      appState.ts            ~/.9rh/desktop.json read/write
      diff.ts                line diff for before/after file records
    preload/
      index.ts               contextBridge: window.ninerh (typed by shared/ipc.ts)
    renderer/
      index.html, main.tsx
      app/                   App shell, routing between Agent / Router / Replays / Settings
      state/                 useSessions (event reducer), useRouter (polling + SSE)
      components/            Transcript, ToolCard, ReceiptsCard, Hud, AskUserModal,
                             ApprovalModal, Composer, SessionSidebar, CommandPalette,
                             DiffView, RewindDialog, ReplayPanel, SkillsPanel,
                             router/{StatusCard,ProvidersTable,CombosPanel,KeysPanel,
                                     ModelsPanel,UsagePanel,DashboardView}
      styles/                theme.css (dark default, light via prefers-color-scheme)
```

### Data flow

1. Renderer calls `window.ninerh.sessions.create({ workDir, model, backend })`.
   Main resolves the backend (`detectBackend` with the chosen overrides),
   builds a `SessionHost`, returns the session id and a snapshot.
2. `sessions.run(id, task)` → `SessionHost.run`: `compressUserInput`, ledger
   `beginTurn`, then either `new Agent({...})` (default) or the team pipeline
   (`Orchestrator` with events wrapped as `{ type: "team", event }`, mirroring
   `runTeamPipeline` in `src/index.ts`). Every `AgentEvent` is folded into
   the ledger first, then sent to the renderer on `session:event` with the
   session id, a monotonic sequence number, and a timestamp.
3. HITL: `onAskUser` and `onToolApproval` create a pending request with an
   id, emit `session:ask` / `session:approval` to the renderer, and await
   `sessions.answerAsk(id, requestId, answer)` /
   `sessions.decideApproval(id, requestId, approved, reason)`. Closing the
   session or aborting rejects pending promises with a "dismissed" answer
   (empty `answer`, `approved: false`), matching the TUI's Esc semantics.
4. Stop and abort call `Agent.requestStop()` and `Agent.abort()`.
5. Renderer keeps one reducer per session: transcript blocks (thinking,
   tool call + result paired by order, markers, receipts), HUD state
   (mirrors `DashboardState` fields), team lanes via `applyTeamEvent`, and
   the latest `LedgerView` snapshot pushed by main after each event that
   changes it.

### 9router console

`routerClient.ts` is the only place that knows 9router URLs:

| Console action | Call |
|---|---|
| Health, version, auth mode, tunnel | `GET /api/health`, `/api/version`, `/api/auth/status`, `/api/tunnel/status` |
| Start / stop / restart | `ensureRouter()` from 9rh; `POST /api/shutdown`; stop then start |
| Providers list, test, enable/disable, delete | `GET /api/providers`; `POST /api/providers/:id/test`; `PUT /api/providers/:id { isActive }`; `DELETE /api/providers/:id` |
| Combos list, create, update, delete | `GET/POST /api/combos`; `PUT/DELETE /api/combos/:id` with `{ name, models: string[] }` |
| API keys list, create, delete | `GET /api/keys`; `POST /api/keys { name }`; `DELETE /api/keys/:id` |
| Models catalog and availability | `GET /api/models`, `GET /api/models/availability`; `GET /v1/models` for the session picker |
| Usage | `GET /api/usage/stats`, `/api/usage/chart`, `/api/usage/request-logs?limit=n`; `GET /api/usage/stream` (SSE) for live totals |
| Settings summary | `GET /api/settings` (read-only display of `requireLogin`, `requireApiKey`, strategies, tunnel, MITM flags) |
| Dashboard | embedded webview |

Delete actions confirm in-app before calling the API. Every list refreshes
on demand and on a 15 s poll while its panel is visible. Errors render
inline in the panel that requested them.

### Agent workbench features

- Sessions sidebar: create with a folder picker (`dialog.showOpenDialog`),
  recent workdirs, per-session status dot (idle / running / waiting for
  you / error), remove.
- Composer: multiline input, Enter to run, Shift+Enter newline, model
  chip with picker, team-mode toggle, `/` opens the command palette.
  Structured-looking tasks (`shouldSuggestTeam`) show a "run as a team?"
  prompt before starting, same as the TUI.
- Transcript: thinking stream (quiet toggle collapses it to one dim line),
  tool cards with args and a 6-line output preview that expands, error
  styling, iteration and continuation markers, model-switch, repair,
  circuit-open and incident markers, team role sections.
- Receipts card at the end of every turn: status, duration, tokens, files
  with net +/- and a Diff button, commands with pass/fail, tool counts,
  assumptions, report link (opens in-app in a report pane or externally).
- HUD (right column): GOAL, NOW (activity, current tool, iteration,
  elapsed), SESSION (turns, files, commands, tokens, model, backend),
  LAST (previous outcome), TEAM lanes when a pipeline runs, sandbox chip
  (`seatbelt` / `none`, from `getSandboxStatus`).
- Ask-user modal: options with the recommended default first, free-text
  when allowed, dismiss = empty answer.
- Approval modal: tool name, risk level vs threshold, pretty-printed args,
  approve / reject with optional reason.
- Stop (graceful) and Abort buttons while running.
- Brief and Usage views over `LedgerView` (per-turn table, per-role
  breakdown for team turns).
- Rewind dialog: pick a completed turn, preview the plan (writes, deletes,
  skips with reasons), apply, show the result.
- Replay panel: list `~/.9rh/runs` logs, play one into a read-only replay
  transcript at a chosen speed, stop early.
- Diff view: side-by-side or unified line diff from `fileChangeRecords`.
- Skills panel: `discoverSkills(workDir)` listing with source and path.
- Command palette (Cmd+K): switch session, new session, router actions,
  brief, usage, rewind, replay, quiet toggle, team toggle, change model,
  change workdir, open report.
- Settings: default model and provider (persisted through
  `updateUserConfig`), backend override (auto / router / direct with
  preset and base URL; API key read from the environment or entered per
  session and kept in memory only), max iterations, parallel tools,
  continuation policy, allow skill install, keep reports.

### Error handling

- Backend detection failure or unreachable router: session creation
  returns a structured error; the sidebar shows it and the router console
  offers Start.
- Agent `error` events render as an error block and close the turn with a
  receipts card (the ledger already handles the double `error`/`done`).
- IPC handlers never throw raw; every handler returns
  `{ ok: true, value } | { ok: false, error }`.
- Router client timeouts (5 s reads, 30 s mutations) surface as panel
  errors, never as crashes; SSE reconnects with backoff while the usage
  panel is visible.
- Pending HITL requests are rejected with dismiss semantics on session
  removal, abort, or window close, so `Agent.run` always resolves.

### Testing

Vitest in `desktop/`:

- `routerClient.test.ts`: URL, headers, method, body for each call;
  error mapping; token injection (fetch mocked).
- `sessionHost.test.ts`: with an injected fake agent factory, verifies
  ledger folding, sequence numbering, HITL request/response round trip,
  dismiss-on-abort, team event wrapping.
- `transcriptReducer.test.ts`: tool call/result pairing, marker
  insertion, receipts at `done`/`error`, quiet mode.
- `diff.test.ts`: create, edit, delete cases and line counts matching
  the digest's added/removed.
- Root `npm test` stays green after the `main.ts` export additions.

Manual verification: launch with `npm run dev` in `desktop/`, create a
session on this repo, run "summarize this repository", confirm receipts;
open the Router page, confirm providers and combos render against the
live 9router, create and delete a throwaway API key; embed the dashboard
and log in.

## Build sequence

1. Root: additive exports in `src/main.ts`; `npm run build`; `npm test`.
2. `desktop/` scaffold: package.json, electron-vite config (ESM main),
   tsconfig, preload bridge, empty window rendering "9rh".
3. Main services: `routerClient`, `routerProcess`, `backendService`,
   `appState`, `diff`, with tests.
4. `sessionHost` + `sessionRegistry` + IPC, with tests.
5. Renderer: shell, sessions sidebar, composer, transcript, receipts,
   HUD, modals, stop/abort.
6. Renderer: router console panels and dashboard webview.
7. Renderer: rewind, replay, diff, skills, brief/usage, palette, settings.
8. Docs: README section, `docs/full-documentation.md` section, AGENTS.md
   structure entry; review pass.
