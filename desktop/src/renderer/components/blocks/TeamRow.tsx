/**
 * Team pipeline role section header: role, status, optional tokens and text.
 */

import type { TranscriptBlock } from "@renderer/state/types";
import { Badge, formatTokens } from "../ui";
import "./blocks.css";

type TeamBlock = Extract<TranscriptBlock, { kind: "team" }>;

const TONE: Record<TeamBlock["status"], "ok" | "warn" | "err" | "muted" | "accent"> = {
  start: "accent",
  complete: "ok",
  skip: "muted",
  cache: "muted",
  conflict: "warn",
  escalation: "err",
};

export function TeamRow(props: { block: TeamBlock }) {
  const { block } = props;
  return (
    <div className="team-row">
      <div className="team-head">
        <span className="team-role">{block.role}</span>
        <Badge tone={TONE[block.status]}>{block.status}</Badge>
        {block.tokens !== undefined ? <span className="muted">{formatTokens(block.tokens)} tok</span> : null}
      </div>
      {block.text ? <pre className="team-text">{block.text}</pre> : null}
    </div>
  );
}
