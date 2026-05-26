# 9rh Repo Indexer — Roadmap

Auto-index every repo 9rh touches, zero manual steps. Self-contained, compressed DB, no external deps.

## Phase 1 — Sync Indexer (now)

**Module:** `src/indexer.ts`  
**DB:** `.9rh/repo-index.db` (SQLite, WAL mode, <1 KB typical)  
**Schema:**

```sql
CREATE TABLE repos (
  id        INTEGER PRIMARY KEY,
  repoRoot  TEXT NOT NULL,          -- absolute path
  repoHash  TEXT NOT NULL,          -- sha256 of sorted file-list + sizes
  sizeBytes INTEGER,                -- total tracked bytes
  lastSeen  INTEGER NOT NULL,       -- epoch ms
  stale     INTEGER DEFAULT 0       -- 1 = candidate for removal
);
CREATE UNIQUE INDEX idx_root ON repos(repoRoot);
CREATE INDEX idx_stale ON repos(stale);
```

**Detection heuristics** — look for: `.git`, `.hg`, `.svn`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `cabal.project`, `project.clj`, `mix.exs`.

**Auto-prune** — every `refreshIndex()` call deletes rows where `lastSeen < (now - 24h) AND stale = 1`. A row is marked `stale = 1` when its `repoRoot` no longer exists on disk (`access()` fails).

**Freshness check** — re-hash on every REPL start. If hash changed, update row. Only full re-scans if new `.git` etc appears in parent.

**Commands:**
| Command | Effect |
|---------|--------|
| `/index` | Force full re-scan + refresh |
| `/index-status` | Show count, total size, age |
| `/index prune` | Immediately purge stale entries |

**Wiring:**
- `runRepl()` calls `ensureRepoIndex(state.workDir)` after `ensureRouter()`.
- `/index` and `/index-status` registered in `COMMANDS` map.
- `RepoIndexer` exported for programmatic use by sub-agents.

---

## Phase 2 — Background Sub-Agent (when needed)

When indexing overhead matters (>1s rebuilds, multi-repo workflows):

```
┌──────────────┐   query     ┌────────────────┐   manage   ┌───────────┐
│  Main Agent  │◄──────────►│  Indexer Agent  │◄──────────►│  File     │
│  (9rh/REPL)  │  async RPC  │  (bg sub-agent) │  fs.watch  │  System   │
└──────────────┘             └────────────────┘             └───────────┘
```

- Indexer Agent runs as a `swarm` sub-agent.
- Exposes: `query_repo(path)`, `list_repos()`, `refresh()`, `prune()`.
- Main agent never blocks on index rebuilds.
- File watcher re-hashes only dirty repos incrementally.

**Not implementing yet** — Phase 1 sync path covers all current needs.

---

## Phase 3 — Cross-Session Persistence (future)

- Store index in `~/.9rh/repo-index.db` instead of per-project.
- Merges entries from all workspaces visited across sessions.
- `/index gc` to purge repos no longer on any mounted volume.
- Export/import for CI or ephemeral environments.

---

## Future Ideas

- **Compressed content-addressed cache** — store function signatures and file-level hashes for faster re-hash.
- **Git-aware diff scan** — only re-hash files changed since last commit.
- **Pre-index of npm/PyPI deps** — skip `node_modules` unless explicitly requested.

---

## Current Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1 — Sync Indexer | ✅ in progress | `src/indexer.ts` drafted, `/index` command wired |
| 2 — Sub-Agent | 🔲 not started | Wrap RepoIndexer in swarm sub-agent when needed |
| 3 — Cross-Session | 🔲 not started | Migrate DB to `~/.9rh/` |