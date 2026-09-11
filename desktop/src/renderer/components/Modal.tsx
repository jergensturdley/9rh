/**
 * Accessible modal: overlay, focus trap, Esc to close, focus restored on
 * unmount. Mounted modals form a stack so Esc only closes the top-most one.
 */

import { useEffect, useRef } from "react";
import "./Modal.css";

const stack: symbol[] = [];

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    const me = Symbol("modal");
    stack.push(me);
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    if (el && !el.contains(document.activeElement)) {
      const body = el.querySelector<HTMLElement>(".modal-body");
      const first = body?.querySelector<HTMLElement>(FOCUSABLE) ?? el.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus();
    }
    const onKey = (e: KeyboardEvent): void => {
      if (stack[stack.length - 1] !== me || !el) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      previous?.focus?.();
    };
  }, []);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        style={props.width ? { width: props.width } : undefined}
      >
        <header className="modal-header">
          <h2 className="modal-title">{props.title}</h2>
          <button type="button" className="modal-close" aria-label="close" onClick={props.onClose}>
            &times;
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}
