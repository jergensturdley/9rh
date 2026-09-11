/**
 * "This looks multi-step. Run it as a team?" Two choices; the streaming
 * agent is the default (focused) one. Esc cancels the run.
 */

import { Modal } from "./Modal";
import { Button } from "./ui";
import "./hitl.css";

export function TeamSuggestDialog(props: { task: string; onPick: (team: boolean) => void; onCancel: () => void }) {
  return (
    <Modal title="Run it as a team?" onClose={props.onCancel} width={520}>
      <p className="hitl-question">This looks multi-step. A team pipeline (architect, coder, reviewer) can split it up; the streaming agent works through it in one loop.</p>
      <p className="muted ellipsis" title={props.task}>
        {props.task}
      </p>
      <div className="hitl-actions">
        <Button variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button onClick={() => props.onPick(true)}>Team pipeline</Button>
        <Button variant="primary" autoFocus onClick={() => props.onPick(false)}>
          Streaming agent
        </Button>
      </div>
    </Modal>
  );
}
