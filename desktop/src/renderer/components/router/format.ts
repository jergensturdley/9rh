/**
 * Pure formatting helpers for the 9router console. No React, no DOM, so
 * they are unit tested directly.
 */

const UNITS = ["", "k", "M", "B"];

/** 999 -> "999", 12400 -> "12.4k", 1200000 -> "1.2M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 999.95 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  if (i === 0) return String(Math.round(v));
  return v.toFixed(1).replace(/\.0$/, "") + UNITS[i];
}

/** Dollar amount as 9router reports it: "$0.16". Tiny nonzero amounts show "<$0.01". */
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.005) return "<$0.01";
  return "$" + n.toFixed(2);
}

/** "just now", "5m ago", "3h ago", "12d ago", or the ISO date past 30 days. "never" when unset. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** "sk-abc123def456" -> "sk-…def456". Short keys are returned unchanged. */
export function maskKey(key: string): string {
  if (key.length <= 9) return key;
  const prefix = key.startsWith("sk-") ? "sk-" : "";
  return `${prefix}…${key.slice(-6)}`;
}
