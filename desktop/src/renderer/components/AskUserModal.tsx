/**
 * Clarifying question from the agent. Options are a focusable list (first
 * one recommended), arrow keys move, Enter picks; free text when allowed.
 * Dismiss (or Esc) sends an empty answer, matching the TUI.
 */

import { useRef, useState } from "react";
import type { PendingRequest } from "@shared/ipc";
import { sessionsActions } from "@renderer/state/sessionsStore";
import { Modal } from "./Modal";
import { Button } from "./ui";
import "./hitl.css";

type AskRequest = Extract<PendingRequest, { kind: "ask" }>;

export function AskUserModal(props: { sessionId: string; request: AskRequest }) {
  const { sessionId, request } = props;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  const send = (answer: string): void => {
    if (busy) return;
    setBusy(true);
    void sessionsActions.answerAsk(sessionId, request.requestId, answer).finally(() => setBusy(false));
  };

  const onListKey = (e: React.KeyboardEvent<HTMLUListElement>): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0);
    items[next]?.focus();
  };

  return (
    <Modal title="The agent has a question" onClose={() => send("")} width={560}>
      <p className="hitl-question">{request.question}</p>
      {request.options.length > 0 ? (
        <ul className="hitl-options" role="listbox" aria-label="options" ref={listRef} onKeyDown={onListKey}>
          {request.options.map((opt, i) => (
            <li key={i} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={i === 0}
                className={i === 0 ? "hitl-option is-recommended" : "hitl-option"}
                autoFocus={i === 0}
                disabled={busy}
                onClick={() => send(opt)}
              >
                <span className="hitl-option-index mono">{i + 1}</span>
                <span className="hitl-option-text">{opt}</span>
                {i === 0 ? <span className="hitl-recommended">recommended</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {request.allowFreeText || request.options.length === 0 ? (
        <form
          className="hitl-free"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send(text.trim());
          }}
        >
          <input
            className="hitl-input"
            placeholder="Type an answer..."
            value={text}
            autoFocus={request.options.length === 0}
            onChange={(e) => setText(e.target.value)}
            aria-label="free text answer"
          />
          <Button variant="primary" type="submit" disabled={busy || !text.trim()}>
            Answer
          </Button>
        </form>
      ) : null}
      <div className="hitl-actions">
        <Button variant="ghost" disabled={busy} onClick={() => send("")}>
          Dismiss
        </Button>
      </div>
    </Modal>
  );
}
