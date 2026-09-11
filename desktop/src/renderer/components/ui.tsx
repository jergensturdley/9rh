/**
 * Small shared primitives used by every page: Button, Badge, Spinner,
 * EmptyState, ErrorNote, plus a few formatting helpers and a ticking clock
 * hook for elapsed-time displays.
 */

import { useEffect, useState } from "react";
import "./ui.css";

export function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger"; size?: "sm" | "md" },
) {
  const { variant = "ghost", size = "md", className, type, ...rest } = props;
  const cls = ["btn", `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(" ");
  return <button type={type ?? "button"} className={cls} {...rest} />;
}

export function Badge(props: { tone?: "ok" | "warn" | "err" | "muted" | "accent"; children: React.ReactNode }) {
  return <span className={`badge badge-${props.tone ?? "muted"}`}>{props.children}</span>;
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="loading" />;
}

export function EmptyState(props: { title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <h3 className="empty-title">{props.title}</h3>
      {props.hint ? <p className="empty-hint">{props.hint}</p> : null}
      {props.children ? <div className="empty-body">{props.children}</div> : null}
    </div>
  );
}

export function ErrorNote(props: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-note" role="alert">
      <span className="error-text">{props.message}</span>
      {props.onRetry ? (
        <Button size="sm" onClick={props.onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "412ms", "2.3s", "1m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Whole seconds for live counters: "0:07", "12:34", "1:02:03". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 1234 -> "1.2k", 1234567 -> "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

/** Re-renders every `ms` while `active`; returns Date.now(). */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}
