/**
 * Transcript: renders every block (long outputs stay collapsed inside their
 * cards) and follows the bottom unless the user scrolled up, in which case a
 * "jump to latest" pill appears.
 * ponytail: no virtualization; a turn rarely exceeds a few hundred blocks.
 * Switch to a windowed list if a session with thousands of tool calls lags.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TranscriptBlock } from "@renderer/state/types";
import { EmptyState } from "./ui";
import { ThinkingBlock } from "./blocks/ThinkingBlock";
import { ToolCard } from "./blocks/ToolCard";
import { MarkerRow } from "./blocks/MarkerRow";
import { TeamRow } from "./blocks/TeamRow";
import { ReceiptsCard } from "./blocks/ReceiptsCard";
import "./Transcript.css";

const STICK_PX = 48;

export function Transcript(props: {
  blocks: TranscriptBlock[];
  quiet: boolean;
  onOpenDiff?: (turn: number, path: string) => void;
  onOpenReport?: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stuck.current = atBottom;
    setShowJump(!atBottom);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [props.blocks]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Content inside cards expands and collapses; keep following the bottom.
    const ro = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el.firstElementChild ?? el);
    return () => ro.disconnect();
  }, []);

  const jump = (): void => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setShowJump(false);
  };

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={ref} onScroll={onScroll} role="log" aria-live="polite">
        <div className="transcript-inner">
          {props.blocks.length === 0 ? (
            <EmptyState title="No turns yet" hint="Describe a task below. Enter runs it; Shift+Enter adds a line; / opens the palette." />
          ) : (
            props.blocks.map((b) => <Block key={b.id} block={b} quiet={props.quiet} onOpenDiff={props.onOpenDiff} onOpenReport={props.onOpenReport} />)
          )}
        </div>
      </div>
      {showJump ? (
        <button type="button" className="transcript-jump" onClick={jump}>
          jump to latest
        </button>
      ) : null}
    </div>
  );
}

function Block(props: {
  block: TranscriptBlock;
  quiet: boolean;
  onOpenDiff?: (turn: number, path: string) => void;
  onOpenReport?: (path: string) => void;
}) {
  const b = props.block;
  switch (b.kind) {
    case "user":
      return (
        <div className="user-block">
          <div className="user-meta muted">
            <span>turn {b.turn}</span>
            <span>{new Date(b.ts).toLocaleTimeString()}</span>
          </div>
          <div className="user-text">{b.text}</div>
        </div>
      );
    case "thinking":
      return <ThinkingBlock text={b.text} quiet={props.quiet} />;
    case "tool":
      return <ToolCard block={b} />;
    case "marker":
      return <MarkerRow block={b} />;
    case "team":
      return <TeamRow block={b} />;
    case "receipts":
      return <ReceiptsCard block={b} onOpenDiff={props.onOpenDiff} onOpenReport={props.onOpenReport} />;
  }
}
