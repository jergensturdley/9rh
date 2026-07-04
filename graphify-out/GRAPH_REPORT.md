# 9rh — Graph Report

Generated from `/Volumes/M.2 2TB/code/9rh`

## Summary

- **1195** nodes
- **2554** edges
- **79** communities
- Source: 8 semantic-extraction chunks + AST extraction of code files

## Top 15 God Nodes (most-connected abstractions)

| degree | label | id |
|------:|-------|----|
| 59 | Orchestrator Module Index | `orchestrator_index` |
| 45 | Orchestrator Class | `orchestrator_orchestrator` |
| 36 | Agent | `src_agent_agent` |
| 33 | Repair Module Index | `repair_index` |
| 31 | Orchestrator.orchestrate | `orchestrator_orchestrator_orchestrator` |
| 29 | faultInjection barrel module | `faultinjection_index` |
| 25 | Task State and Role Contexts | `orchestrator_taskstate` |
| 24 | Role Definitions and Risk Classifier | `orchestrator_roles` |
| 23 | executeTool | `src_tools_executetool` |
| 23 | backends barrel module | `backends_index` |
| 23 | Error Taxonomy | `repair_errortaxonomy` |
| 22 | faultInjection types module | `faultinjection_types` |
| 22 | ErrorClass enum | `repair_errortaxonomy_errorclass` |
| 21 | detectBackend module | `backends_detect` |
| 21 | ReplayEvent union type | `replay_eventschema_replayevent` |

## Top 20 Communities by Size

| size | label | top file |
|----:|-------|----------|
| 105 | ? | `orchestrator/orchestrator.ts` |
| 82 | ? | `repair/circuitBreaker.ts` |
| 69 | ? | `sandbox/sandboxer.ts` |
| 67 | ? | `backends/router.ts` |
| 62 | ? | `tui.ts` |
| 61 | ? | `faultInjection/types.ts` |
| 59 | ? | `tools.ts` |
| 42 | ? | `reports/runReport.ts` |
| 41 | ? | `receiving-code-review/SKILL.md` |
| 41 | ? | `agent.ts` |
| 35 | ? | `package.json` |
| 34 | ? | `commands.ts` |
| 32 | ? | `indexer.ts` |
| 31 | ? | `spec/specDrivenTesting.ts` |
| 28 | ? | `AGENTS.md` |
| 27 | ? | `visualization.ts` |
| 26 | ? | `index.ts` |
| 25 | ? | `semanticDiff.ts` |
| 24 | ? | `replay/eventSchema.ts` |
| 21 | ? | `bug-fix-spec.md` |

## Surprising Connections (cross-cutting)

Edges that cross file types, communities, or repos — and were either INFERRED or reveal unexpected couplings.

| relation | confidence | source → target | why |
|----------|------------|-----------------|-----|
| `instantiates` | EXTRACTED | `Sandbox smoke-test script` → `Tool sandbox / Sandbox class` | crosses file types (code ↔ doc); connects across different repos/directories; peripheral node `Sandbox smoke-test script` unexpectedly reaches hub `Tool sandbox |
| `extends` | INFERRED | `Orchestrator (Architect→Implementer→Reviewer→Security→Test)` → `Streaming ReAct loop` | inferred connection - not explicitly stated in source; crosses file types (doc ↔ code); connects across different repos/directories |
| `complementary_to` | INFERRED | `CodeGraph MCP server (tree-sitter AST index)` → `GitNexus (ladybugdb knowledge graph)` | inferred connection - not explicitly stated in source; crosses file types (doc ↔ code); connects across different repos/directories |
| `aligned_with` | INFERRED | `Spec-driven testing` → `Superpowers skill methodology` | inferred connection - not explicitly stated in source; crosses file types (doc ↔ code); connects across different repos/directories |
| `exercises` | INFERRED | `Fault Injection harness` → `Repair system (4 error classes + circuit breaker)` | inferred connection - not explicitly stated in source; crosses file types (doc ↔ code); connects across different repos/directories |
| `violated_by` | INFERRED | `Tool sandbox / Sandbox class` → `Security Finding F-01 (Critical): macOS sandbox profile no-op allow-all` | inferred connection - not explicitly stated in source; connects across different repos/directories; peripheral node `Security Finding F-01 (Critical): macOS san |
| `semantically_similar_to` | INFERRED | `formatSemanticReview` → `renderLongHorizonMemory` | inferred connection - not explicitly stated in source; bridges separate communities; semantically similar concepts with no structural link; peripheral node `ren |
| `references` | EXTRACTED | `9rh Agent Guide (project instructions)` → `9rh README` | connects across different repos/directories; peripheral node `9rh README` unexpectedly reaches hub `9rh Agent Guide (project instructions)` |
| `shares_compiler_with` | INFERRED | `Jest configuration (ESM)` → `TypeScript configuration` | inferred connection - not explicitly stated in source; connects across different repos/directories |
| `independent_audit_of_overlapping_findings` | INFERRED | `Security Review (49 findings)` → `Bug Fix Spec — Top 6 Findings` | inferred connection - not explicitly stated in source; connects across different repos/directories |

## Suggested Questions the Graph Can Answer

### `ambiguous_edge`
### `ambiguous_edge`
### `bridge_node`
### `bridge_node`
### `bridge_node`
### `verify_inferred`
### `isolated_nodes`
### `low_cohesion`
### `low_cohesion`
### `low_cohesion`

> Should `Community 2` be split into smaller, more focused modules?

_Cohesion score 0.05754475703324808 - nodes in this community are weakly interconnected._

## How to Read This Report

- **God nodes** are the structural backbones — they appear across many subsystems and are the natural starting points for understanding the codebase.
- **Communities** are clusters of tightly-connected nodes (Louvain algorithm). Each cluster has a curated 2–5-word label.
- **Surprising connections** are non-obvious cross-cluster edges — they often surface hidden couplings that wouldn't show up in import graphs.
- **Suggested questions** are derived from AMBIGUOUS edges, bridge nodes, isolated nodes, and low-cohesion clusters. They are the prompts the graph is *uniquely* positioned to help with.

## Artifacts

- `graph.html` — interactive 3D-force-graph explorer (open in browser)
- `graph.json` — full graph in networkx node-link format (use with `networkx.read_graphml` / Gephi)
- `.graphify_extract.json` — raw extraction (nodes + edges + hyperedges)
- `.graphify_communities.json` — Louvain clustering
- `.graphify_analysis.json` — god nodes, surprises, suggested questions
- `.graphify_labels.json` — community labels
