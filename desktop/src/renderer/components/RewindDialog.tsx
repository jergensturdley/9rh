/**
 * Rewind dialog: pick a completed turn that touched files, preview the plan
 * main computes from the ledger's file change records, then restore the
 * workdir to the state before that turn. Mirrors the CLI's /rewind picker.
 */

import { useRef, useState } from "react";
import type { RewindResult } from "9rh";
import type { RewindPlanView } from "@shared/ipc";
import { useSession } from "@renderer/state/sessionsStore";
import { Modal } from "./Modal";
import { Badge, Button, ErrorNote, EmptyState, Spinner } from "./ui";
import "./RewindDialog.css";

export function RewindDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const view = useSession(sessionId);
  const [target, setTarget] = useState<number | null>(null);
  const [plan, setPlan] = useState<RewindPlanView | null>(null);
  const [result, setResult] = useState<RewindResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped per request so a slow plan for an earlier pick cannot land late.
  const gen = useRef(0);

  const running = view?.snapshot.status === "running";
  const turns = (view?.snapshot.ledger.turns ?? []).filter(
    (t) => t.endedAt !== undefined && (t.digest?.files.length ?? 0) > 0,
  );

  const pick = async (index: number): Promise<void> => {
    const mine = ++gen.current;
    setTarget(index);
    setPlan(null);
    setResult(null);
    setError(null);
    setBusy(true);
    const res = await window.ninerh.sessions.rewindPlan(sessionId, index);
    if (mine !== gen.current) return;
    setBusy(false);
    if (res.ok) setPlan(res.value);
    else setError(res.error);
  };

  const restore = async (): Promise<void> => {
    if (target === null) return;
    const mine = ++gen.current;
    setBusy(true);
    setError(null);
    const res = await window.ninerh.sessions.rewindApply(sessionId, target);
    if (mine !== gen.current) return;
    setBusy(false);
    if (res.ok) setResult(res.value);
    else setError(res.error);
  };

  const canRestore = plan !== null && !busy && !running && result === null && plan.writes.length + plan.deletes.length > 0;

  return (
    <Modal title="Rewind: restore the workdir to before a turn" onClose={onClose} width={760}>
      {running ? <p className="rewind-note warn">The session is running. Rewind is available once the turn ends.</p> : null}
      {turns.length === 0 ? (
        <EmptyState title="Nothing to rewind" hint="No completed turn in this session recorded file changes." />
      ) : (
        <div className="rewind-layout">
          <ul className="rewind-turns" role="listbox" aria-label="turns">
            {turns
              .slice()
              .reverse()
              .map((t) => {
                const files = t.digest?.files.length ?? 0;
                return (
                  <li
                    key={t.index}
                    role="option"
                    aria-selected={t.index === target}
                    className={t.index === target ? "rewind-turn is-active" : "rewind-turn"}
                    onClick={() => void pick(t.index)}
                  >
                    <span className="rewind-turn-index">before turn {t.index}</span>
                    <span className="rewind-turn-task" title={t.task}>
                      {t.task.replace(/\s+/g, " ")}
                    </span>
                    <span className="rewind-turn-files">
                      {files} file{files === 1 ? "" : "s"}
                    </span>
                  </li>
                );
              })}
          </ul>
          <div className="rewind-detail">
            {target === null ? (
              <p className="rewind-note">Select a turn to preview what would be restored.</p>
            ) : busy && !plan ? (
              <Spinner />
            ) : null}
            {error ? <ErrorNote message={error} /> : null}
            {plan && !result ? <PlanView plan={plan} /> : null}
            {result ? <ResultView result={result} target={target ?? 0} /> : null}
            <div className="rewind-actions">
              {result ? (
                <Button onClick={onClose}>Done</Button>
              ) : (
                <>
                  <Button variant="danger" disabled={!canRestore} onClick={() => void restore()}>
                    {busy && plan ? "Restoring..." : "Restore"}
                  </Button>
                  <Button variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                </>
              )}
            </div>
            <p className="rewind-note">Conversation history is unchanged; rewind touches files only.</p>
          </div>
        </div>
      )}
    </Modal>
  );
}

function PathList({ title, tone, paths }: { title: string; tone: "ok" | "err" | "warn"; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <section className="rewind-section">
      <h4>
        <Badge tone={tone}>{paths.length}</Badge> {title}
      </h4>
      <ul className="rewind-paths">
        {paths.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </section>
  );
}

function SkipList({ title, skips }: { title: string; skips: RewindPlanView["skips"] }) {
  if (skips.length === 0) return null;
  return (
    <section className="rewind-section">
      <h4>
        <Badge tone="warn">{skips.length}</Badge> {title}
      </h4>
      <ul className="rewind-paths">
        {skips.map((s, i) => (
          <li key={`${s.path}:${i}`}>
            {s.path} <span className="rewind-reason">{s.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlanView({ plan }: { plan: RewindPlanView }) {
  const empty = plan.writes.length + plan.deletes.length === 0;
  return (
    <div>
      <h3 className="rewind-heading">Plan for turn {plan.targetTurnIndex}</h3>
      {empty ? <p className="rewind-note">Nothing to restore; every recorded change is skipped below.</p> : null}
      <PathList title="files to restore" tone="ok" paths={plan.writes} />
      <PathList title="files to delete (created by a rewound turn)" tone="err" paths={plan.deletes} />
      <SkipList title="skipped" skips={plan.skips} />
    </div>
  );
}

function ResultView({ result, target }: { result: RewindResult; target: number }) {
  const nothing = result.restored.length + result.deleted.length === 0;
  return (
    <div>
      <h3 className="rewind-heading">Rewound to before turn {target}</h3>
      {nothing ? <p className="rewind-note">Nothing restored.</p> : null}
      <PathList title="restored" tone="ok" paths={result.restored} />
      <PathList title="removed" tone="err" paths={result.deleted} />
      <SkipList title="skipped" skips={result.skipped} />
    </div>
  );
}
