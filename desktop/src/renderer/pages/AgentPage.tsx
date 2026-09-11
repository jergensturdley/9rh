/**
 * Agent workbench: sessions sidebar | toolbar + transcript + composer | HUD.
 * Owns the modal state (new session, model picker, rewind, diff, brief,
 * skills, report, team suggestion); the HITL modals open on their own from
 * the active session's `pending` request. The modal state is a tiny module
 * store so the app shell and the command palette can open modals too.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import type { IpcResult } from "@shared/ipc";
import { sessionsActions, useActiveSession, useSessionsState } from "@renderer/state/sessionsStore";
import { useAsync } from "@renderer/state/useAsync";
import { SessionSidebar } from "@renderer/components/SessionSidebar";
import { NewSessionDialog } from "@renderer/components/NewSessionDialog";
import { Composer } from "@renderer/components/Composer";
import { ModelPicker } from "@renderer/components/ModelPicker";
import { Transcript } from "@renderer/components/Transcript";
import { Hud } from "@renderer/components/Hud";
import { AskUserModal } from "@renderer/components/AskUserModal";
import { ApprovalModal } from "@renderer/components/ApprovalModal";
import { TeamSuggestDialog } from "@renderer/components/TeamSuggestDialog";
import { Modal } from "@renderer/components/Modal";
import { Badge, Button, EmptyState, ErrorNote, basename } from "@renderer/components/ui";
import { RewindDialog } from "@renderer/components/RewindDialog";
import { DiffView } from "@renderer/components/DiffView";
import { BriefView } from "@renderer/components/BriefView";
import { SkillsPanel } from "@renderer/components/SkillsPanel";
import { ReportViewer } from "@renderer/components/ReportViewer";
import "./AgentPage.css";

// ---------------------------------------------------------------------------
// Modal store (module singleton, same pattern as sessionsStore)
// ---------------------------------------------------------------------------

export type AgentModal =
  | { kind: "new"; workDir?: string }
  | { kind: "model" }
  | { kind: "rewind" }
  | { kind: "diff"; turn: number; path: string }
  | { kind: "brief" }
  | { kind: "skills" }
  | { kind: "report"; path: string }
  | { kind: "team"; task: string }
  /** Not a modal: opens the OS folder picker and re-targets the session. */
  | { kind: "workdir" };

let modalState: AgentModal | null = null;
const modalListeners = new Set<() => void>();

function subscribeModal(l: () => void): () => void {
  modalListeners.add(l);
  return () => {
    modalListeners.delete(l);
  };
}

export const agentPageActions = {
  open(m: AgentModal | null): void {
    modalState = m;
    for (const l of modalListeners) l();
  },
  close(): void {
    agentPageActions.open(null);
  },
};

const STATUS_TONE = { idle: "muted", running: "accent", waiting: "warn", error: "err" } as const;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AgentPage(props: { onOpenPalette: () => void }) {
  const state = useSessionsState();
  const view = useActiveSession();
  const modal = useSyncExternalStore(subscribeModal, () => modalState);
  const [hudOpen, setHudOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string; nonce: number } | null>(null);
  const activeId = view?.snapshot.id ?? null;

  const changeWorkDir = async (): Promise<void> => {
    if (!activeId) return;
    const picked = await window.ninerh.shell.pickDirectory();
    if (!picked.ok) {
      setError(picked.error);
      return;
    }
    if (picked.value) report(sessionsActions.setWorkDir(activeId, picked.value));
  };

  // The palette opens "workdir" through the modal store; it is an action, not a dialog.
  useEffect(() => {
    if (modal?.kind === "workdir") {
      agentPageActions.close();
      void changeWorkDir();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  // Initial selection: the store never auto-selects.
  useEffect(() => {
    if (!state.activeId && state.order.length > 0) sessionsActions.select(state.order[0]);
  }, [state.activeId, state.order]);

  // Session-scoped modals do not survive a session switch.
  useEffect(() => {
    if (modalState && modalState.kind !== "new" && modalState.kind !== "report") agentPageActions.close();
  }, [activeId]);

  const close = agentPageActions.close;
  const open = agentPageActions.open;

  const report = (p: Promise<IpcResult<unknown>>): void => {
    setError(null);
    void p.then((r) => {
      if (!r.ok) setError(r.error);
    });
  };

  const run = (text: string, team?: boolean): void => {
    if (!activeId) return;
    report(sessionsActions.run(activeId, text, team));
  };

  const submit = async (text: string): Promise<void> => {
    // "error" is a finished turn (max iterations, provider failure); the host
    // accepts a new run in that state, so the composer must too.
    if (!view || (view.snapshot.status !== "idle" && view.snapshot.status !== "error")) return;
    if (!view.snapshot.teamMode) {
      const s = await window.ninerh.sessions.suggestTeam(text);
      if (s.ok && s.value) {
        open({ kind: "team", task: text });
        return;
      }
    }
    run(text);
  };

  if (state.loaded && state.order.length === 0) {
    return (
      <div className="ap ap-empty">
        <Welcome onNew={(workDir) => open(workDir ? { kind: "new", workDir } : { kind: "new" })} />
        {modal?.kind === "new" ? <NewSessionDialog onClose={close} initialWorkDir={modal.workDir} /> : null}
      </div>
    );
  }

  const snap = view?.snapshot ?? null;
  const running = snap?.status === "running" || snap?.status === "waiting";
  const idle = snap?.status === "idle" || snap?.status === "error";
  const pending = snap?.pending ?? null;
  const composerHint = snap?.status === "waiting" ? "waiting for your answer" : snap?.status === "running" ? "running; Stop or Abort from the toolbar" : undefined;

  return (
    <div className={hudOpen ? "ap" : "ap ap-hud-closed"}>
      <SessionSidebar onNew={() => open({ kind: "new" })} />

      <div className="ap-main col">
        {snap && view ? (
          <>
            <div className="ap-toolbar" role="toolbar" aria-label="session controls">
              <span className={snap.ledger.goalActive ? "ap-goal is-active" : "ap-goal"} title={snap.ledger.goal ?? snap.workDir}>
                {snap.ledger.goalActive ? <span className="ap-goal-pulse" aria-hidden="true" /> : null}
                <span className="ellipsis">{snap.ledger.goal ?? basename(snap.workDir)}</span>
              </span>
              <button type="button" className="ap-chip mono" title="change model" disabled={running} onClick={() => open({ kind: "model" })}>
                {snap.model}
              </button>
              <button type="button" className="ap-chip mono" title={`change working directory (${snap.workDir})`} disabled={running} onClick={() => void changeWorkDir()}>
                {basename(snap.workDir) || snap.workDir}
              </button>
              <Button size="sm" aria-pressed={snap.teamMode} disabled={running} onClick={() => report(sessionsActions.setTeamMode(snap.id, !snap.teamMode))}>
                team
              </Button>
              <Button size="sm" aria-pressed={snap.quiet} onClick={() => report(sessionsActions.setQuiet(snap.id, !snap.quiet))}>
                quiet
              </Button>
              {running ? (
                <>
                  <Button size="sm" onClick={() => report(sessionsActions.stop(snap.id))} title="finish the current tool call, then stop">
                    Stop
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={snap.aborting === true}
                    onClick={() => report(sessionsActions.abort(snap.id))}
                    title={snap.aborting ? "the stream is cancelled; waiting for the current tool call to return" : "cancel the stream; a running tool call finishes first"}
                  >
                    {snap.aborting ? "Aborting..." : "Abort"}
                  </Button>
                </>
              ) : null}
              <span className="grow" />
              <Button size="sm" onClick={() => open({ kind: "brief" })}>
                Brief
              </Button>
              <Button size="sm" onClick={() => open({ kind: "skills" })}>
                Skills
              </Button>
              <Button size="sm" disabled={!idle} onClick={() => open({ kind: "rewind" })}>
                Rewind
              </Button>
              <Button size="sm" disabled={!snap.lastReportPath} onClick={() => snap.lastReportPath && open({ kind: "report", path: snap.lastReportPath })}>
                Report
              </Button>
              <Badge tone={STATUS_TONE[snap.status]}>{snap.status}</Badge>
              <Button size="sm" aria-pressed={hudOpen} aria-label="toggle HUD" onClick={() => setHudOpen((v) => !v)}>
                HUD
              </Button>
            </div>
            {snap.warnings.length > 0 ? (
              <div className="ap-warnings">
                {snap.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            ) : null}
            {error ? (
              <div className="ap-error">
                <ErrorNote message={error} />
              </div>
            ) : null}
            <Transcript
              key={snap.id}
              blocks={view.blocks}
              quiet={snap.quiet}
              onOpenDiff={(turn, path) => open({ kind: "diff", turn, path })}
              onOpenReport={(path) => open({ kind: "report", path })}
            />
            <Composer disabled={!idle} hint={composerHint} draft={draft} onSubmit={(t) => void submit(t)} onOpenPalette={props.onOpenPalette} />
          </>
        ) : (
          <EmptyState title="Select a session" hint="Pick one on the left or create a new one." />
        )}
      </div>

      {hudOpen && view ? <Hud view={view} /> : hudOpen ? <aside className="hud-placeholder" /> : null}

      {snap && pending?.kind === "ask" ? <AskUserModal sessionId={snap.id} request={pending} /> : null}
      {snap && pending?.kind === "approval" ? <ApprovalModal sessionId={snap.id} request={pending} /> : null}

      {modal?.kind === "new" ? <NewSessionDialog onClose={close} initialWorkDir={modal.workDir} /> : null}
      {snap && modal?.kind === "model" ? (
        <ModelPicker
          value={snap.model}
          load={(filter) => window.ninerh.sessions.listModels(snap.id, filter || undefined)}
          onPick={(m) => {
            close();
            if (m !== snap.model) report(sessionsActions.setModel(snap.id, m));
          }}
          onClose={close}
        />
      ) : null}
      {snap && modal?.kind === "rewind" ? <RewindDialog sessionId={snap.id} onClose={close} /> : null}
      {snap && modal?.kind === "diff" ? <DiffView sessionId={snap.id} turnIndex={modal.turn} path={modal.path} onClose={close} /> : null}
      {snap && modal?.kind === "brief" ? (
        <Modal title="Brief" onClose={close} width={860}>
          <BriefView sessionId={snap.id} />
        </Modal>
      ) : null}
      {snap && modal?.kind === "skills" ? (
        <Modal title="Skills" onClose={close} width={760}>
          <SkillsPanel sessionId={snap.id} />
        </Modal>
      ) : null}
      {modal?.kind === "report" ? <ReportViewer path={modal.path} onClose={close} /> : null}
      {snap && modal?.kind === "team" ? (
        <TeamSuggestDialog
          task={modal.task}
          onPick={(team) => {
            const task = modal.task;
            close();
            run(task, team);
          }}
          onCancel={() => {
            // Cancel puts the task back in the composer instead of losing it.
            const task = modal.task;
            close();
            setDraft({ text: task, nonce: Date.now() });
          }}
        />
      ) : null}
    </div>
  );
}

function Welcome(props: { onNew: (workDir?: string) => void }) {
  const app = useAsync(() => window.ninerh.config.appState(), []);
  const recent = app.data?.recentWorkDirs ?? [];
  return (
    <EmptyState title="9rh" hint="Run an agent against a local repository. Sessions run in parallel; each keeps its own receipts, rewind points, and HUD.">
      <Button variant="primary" onClick={() => props.onNew()} autoFocus className="ap-big-new">
        New session
      </Button>
      {recent.length > 0 ? (
        <div className="ap-recent">
          <div className="muted ap-recent-title">recent</div>
          {recent.map((r) => (
            <button key={r} type="button" className="ap-recent-item" title={r} onClick={() => props.onNew(r)}>
              <span className="ap-recent-name">{basename(r) || r}</span>
              <span className="muted mono ellipsis">{r}</span>
            </button>
          ))}
        </div>
      ) : null}
    </EmptyState>
  );
}
