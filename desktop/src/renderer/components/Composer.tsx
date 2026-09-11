/**
 * Task input. Auto-grows to eight lines; Enter runs, Shift+Enter adds a
 * line, Cmd/Ctrl+Enter also runs, "/" in an empty box opens the palette.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";
import "./Composer.css";

const MAX_LINES = 8;

export function Composer(props: {
  disabled: boolean;
  hint?: string;
  /** Text to put back in the box (a cancelled run prompt); the nonce re-applies equal text. */
  draft?: { text: string; nonce: number } | null;
  onSubmit: (text: string) => void;
  onOpenPalette: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!props.draft) return;
    setText(props.draft.text);
    ref.current?.focus();
  }, [props.draft]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 19;
    const pad = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES + pad + 12)}px`;
  }, [text]);

  const submit = (): void => {
    const t = text.trim();
    if (!t || props.disabled) return;
    props.onSubmit(t);
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "/" && text === "" && (e.currentTarget.selectionStart ?? 0) === 0) {
      e.preventDefault();
      props.onOpenPalette();
      return;
    }
    if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
      // Enter that commits an IME candidate must not run the task.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        className="composer-input"
        rows={1}
        placeholder={props.disabled ? (props.hint ?? "Busy...") : "Describe a task. Enter to run, Shift+Enter for a new line, / for commands."}
        value={text}
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="task"
        spellCheck={false}
      />
      <div className="composer-side">
        <Button variant="primary" size="sm" disabled={props.disabled || !text.trim()} onClick={submit} aria-label="run task">
          Run
        </Button>
        {props.disabled && props.hint ? <span className="composer-hint muted">{props.hint}</span> : null}
      </div>
    </div>
  );
}
