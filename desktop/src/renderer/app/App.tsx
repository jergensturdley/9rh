/**
 * App shell: left rail, one page at a time, the command palette, keyboard
 * shortcuts (Cmd/Ctrl+K palette, Cmd/Ctrl+1..4 pages), and the window
 * title. Wires the sessions store on mount.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { initSessionsStore, sessionsActions, useActiveSession, useSessionsState } from "@renderer/state/sessionsStore";
import { runRouterAction, setRouterTab } from "@renderer/state/routerStore";
import { CommandPalette, type PaletteAction } from "@renderer/components/CommandPalette";
import { basename } from "@renderer/components/ui";
import { AgentPage, agentPageActions } from "@renderer/pages/AgentPage";
import { RouterPage } from "@renderer/pages/RouterPage";
import { ReplaysPage } from "@renderer/pages/ReplaysPage";
import { SettingsPage } from "@renderer/pages/SettingsPage";
import { Nav, PAGES, type Page } from "./Nav";
import "./App.css";

export function App() {
  const [page, setPage] = useState<Page>("agent");
  const [palette, setPalette] = useState(false);
  const state = useSessionsState();
  const active = useActiveSession();
  const goal = active?.snapshot.ledger.goal ?? null;
  const paletteOpen = useRef(false);
  paletteOpen.current = palette;

  useEffect(() => initSessionsStore(), []);

  useEffect(() => {
    document.title = goal ? `${goal.replace(/\s+/g, " ").slice(0, 80)} · 9rh` : "9rh";
  }, [goal]);

  useEffect(() => {
    // Capture phase, registered before any Modal mounts, so Esc closes the
    // palette (the top-most layer) before a modal underneath sees it.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && paletteOpen.current) {
        e.stopImmediatePropagation();
        setPalette(false);
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (e.key >= "1" && e.key <= "4") {
        const p = PAGES[Number(e.key) - 1];
        if (p) {
          e.preventDefault();
          setPage(p.id);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const actions = useMemo<PaletteAction[]>(() => {
    const out: PaletteAction[] = [];
    const agent = (fn: () => void): (() => void) => () => {
      setPage("agent");
      fn();
    };
    out.push({ id: "new", label: "New session", group: "Sessions", run: agent(() => agentPageActions.open({ kind: "new" })) });
    for (const id of state.order) {
      const s = state.byId[id]?.snapshot;
      if (!s) continue;
      out.push({
        id: `switch:${id}`,
        label: `Switch to ${basename(s.workDir) || s.workDir}`,
        hint: `${s.status} · ${s.model}`,
        group: "Sessions",
        run: agent(() => sessionsActions.select(id)),
      });
    }
    const s = active?.snapshot;
    if (s) {
      const running = s.status === "running" || s.status === "waiting";
      out.push({ id: "brief", label: "Run brief", hint: "per-turn usage table", group: "Session", run: agent(() => agentPageActions.open({ kind: "brief" })) });
      out.push({ id: "quiet", label: s.quiet ? "Quiet mode off" : "Quiet mode on", group: "Session", run: () => void sessionsActions.setQuiet(s.id, !s.quiet) });
      if (!running) out.push({ id: "team", label: s.teamMode ? "Team mode off" : "Team mode on", group: "Session", run: () => void sessionsActions.setTeamMode(s.id, !s.teamMode) });
      if (!running) out.push({ id: "model", label: "Change model", hint: s.model, group: "Session", run: agent(() => agentPageActions.open({ kind: "model" })) });
      if (!running) out.push({ id: "workdir", label: "Change workdir", hint: s.workDir, group: "Session", run: agent(() => agentPageActions.open({ kind: "workdir" })) });
      if (s.status === "idle") out.push({ id: "rewind", label: "Rewind", hint: "restore the workdir to before a turn", group: "Session", run: agent(() => agentPageActions.open({ kind: "rewind" })) });
      out.push({ id: "skills", label: "Skills", group: "Session", run: agent(() => agentPageActions.open({ kind: "skills" })) });
      if (s.lastReportPath) out.push({ id: "report", label: "Open last report", hint: s.lastReportPath, group: "Session", run: agent(() => agentPageActions.open({ kind: "report", path: s.lastReportPath! })) });
      if (running) {
        out.push({ id: "stop", label: "Stop (graceful)", group: "Session", run: () => void sessionsActions.stop(s.id) });
        out.push({ id: "abort", label: "Abort", group: "Session", run: () => void sessionsActions.abort(s.id) });
      }
    }
    // Router process actions land on the Router page, where the status card
    // shows the outcome (or the error) instead of failing silently.
    const router = (action: "start" | "stop" | "restart") => (): void => {
      setPage("router");
      void runRouterAction(action);
    };
    out.push({ id: "router:start", label: "Start 9router", group: "Router", run: router("start") });
    out.push({ id: "router:stop", label: "Stop 9router", group: "Router", run: router("stop") });
    out.push({ id: "router:restart", label: "Restart 9router", group: "Router", run: router("restart") });
    // Updates run from the panel so their progress log and result are visible.
    out.push({
      id: "router:update",
      label: "Update 9router",
      hint: "update the install on PATH, then restart",
      group: "Router",
      run: () => {
        setRouterTab("update");
        setPage("router");
      },
    });
    for (const p of PAGES) out.push({ id: `go:${p.id}`, label: `Go to ${p.label}`, group: "Go to", run: () => setPage(p.id) });
    return out;
  }, [state.order, state.byId, active]);

  return (
    <div className="app">
      <Nav page={page} onChange={setPage} />
      <main className="app-main">
        {page === "agent" ? (
          <AgentPage onOpenPalette={() => setPalette(true)} />
        ) : page === "router" ? (
          <RouterPage />
        ) : page === "replays" ? (
          <ReplaysPage />
        ) : (
          <SettingsPage />
        )}
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)} actions={actions} />
    </div>
  );
}
