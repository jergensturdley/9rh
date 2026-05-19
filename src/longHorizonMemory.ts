import { createHash } from "crypto";

export type MemoryTier = "working" | "episodic" | "durable";

export interface MemoryProvenance {
  source: string;
  observedAt: string;
  lastVerifiedAt: string;
  sourceHash: string;
}

export interface MemoryItem {
  id: string;
  tier: MemoryTier;
  content: string;
  identifiers: string[];
  provenance: MemoryProvenance;
  confidence: "high" | "uncertain";
  needsReconfirmation: boolean;
}

export interface LongHorizonMemory {
  working: MemoryItem[];
  episodic: MemoryItem[];
  durable: MemoryItem[];
  unresolvedBlockers: string[];
  criticalIdentifiers: string[];
  compressionWarnings: string[];
}

export interface RetrievalResult {
  item: MemoryItem;
  score: number;
}

const IDENTIFIER_RE = /(?:\b(?:src|test|tests|__tests__|examples|logs|snapshots)\/[\w./-]+|\b[A-Za-z_$][\w$]*\.(?:ts|tsx|js|jsx|json|md)\b|\b[A-Za-z_$][\w$]*(?:\(\)|::[A-Za-z_$][\w$]*)|\b[A-Z][A-Za-z0-9_$]*(?:Event|Config|Result|Schema|Policy|Memory|Agent)\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[-\w/:{}?=&.]+|\b[-\w]+:[-\w./]+\b)/gu;
const DURABLE_RE = /\b(?:architecture|schema|convention|always|never|must|stable|api route|contract|decision|use|prefer|source-linked|provenance)\b/iu;
const BLOCKER_RE = /\b(?:blocker|blocked|unresolved|todo|fixme|failing|fails|error|exception|contradiction|stale|uncertain|reconfirm)\b/iu;
const DONE_RE = /\b(?:completed|implemented|added|fixed|changed|updated|milestone|done|validated|passed|committed)\b/iu;

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function unique(values: string[], limit = 80): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function extractIdentifiers(text: string): string[] {
  return unique(Array.from(text.matchAll(IDENTIFIER_RE), (m) => m[0]));
}

function sentenceSplit(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

function classify(sentence: string, index: number, total: number): MemoryTier {
  if (DURABLE_RE.test(sentence)) return "durable";
  if (DONE_RE.test(sentence) || index < Math.max(2, Math.floor(total * 0.15))) return "episodic";
  return "working";
}

function toItem(sentence: string, index: number, source: string, now: string, total: number): MemoryItem {
  const identifiers = extractIdentifiers(sentence);
  const uncertainty = /\b(?:maybe|possibly|uncertain|unknown|assume|assumption|needs? reconfirmation)\b/iu.test(sentence);
  return {
    id: `${classify(sentence, index, total)}-${hashText(`${source}:${index}:${sentence}`)}`,
    tier: classify(sentence, index, total),
    content: sentence.slice(0, 420),
    identifiers,
    provenance: {
      source: `${source}#segment-${index + 1}`,
      observedAt: now,
      lastVerifiedAt: now,
      sourceHash: hashText(sentence),
    },
    confidence: uncertainty ? "uncertain" : "high",
    needsReconfirmation: uncertainty,
  };
}

export function buildLongHorizonMemory(historyText: string, source = "conversation", now = new Date().toISOString()): LongHorizonMemory {
  const sentences = sentenceSplit(historyText);
  const useful = sentences.filter((s) => extractIdentifiers(s).length > 0 || DURABLE_RE.test(s) || BLOCKER_RE.test(s) || DONE_RE.test(s));
  const items = useful.slice(-120).map((sentence, index) => toItem(sentence, index, source, now, useful.length));
  const memory: LongHorizonMemory = {
    working: items.filter((i) => i.tier === "working").slice(-20),
    episodic: items.filter((i) => i.tier === "episodic").slice(-20),
    durable: items.filter((i) => i.tier === "durable").slice(-20),
    unresolvedBlockers: unique(useful.filter((s) => BLOCKER_RE.test(s)).slice(-12)),
    criticalIdentifiers: unique(extractIdentifiers(historyText), 100),
    compressionWarnings: [],
  };
  return validateMemoryCompression(memory, historyText);
}

export function validateMemoryCompression(memory: LongHorizonMemory, sourceText: string): LongHorizonMemory {
  const rendered = renderLongHorizonMemory(memory);
  const missing = extractIdentifiers(sourceText).filter((id) => !rendered.includes(id));
  const compressionWarnings = [...memory.compressionWarnings];
  if (missing.length > 0) compressionWarnings.push(`critical identifiers missing from memory summary: ${unique(missing, 20).join(", ")}`);
  return { ...memory, compressionWarnings };
}

export function renderLongHorizonMemory(memory: LongHorizonMemory): string {
  const section = (title: string, items: MemoryItem[]) => {
    if (items.length === 0) return `${title}: none`;
    return `${title}:\n${items.map((i) => `- [${i.id}; ${i.confidence}; source=${i.provenance.source}; verified=${i.provenance.lastVerifiedAt}; hash=${i.provenance.sourceHash}] ${i.content}${i.identifiers.length ? ` | ids: ${i.identifiers.join(", ")}` : ""}${i.needsReconfirmation ? " | needs reconfirmation" : ""}`).join("\n")}`;
  };
  return [
    "Long-horizon memory (compressed, source-linked):",
    section("Working memory - immediate active state", memory.working),
    section("Episodic memory - completed milestones", memory.episodic),
    section("Durable project memory - stable facts/conventions", memory.durable),
    `Unresolved blockers: ${memory.unresolvedBlockers.length ? memory.unresolvedBlockers.join("; ") : "none"}`,
    `Critical identifiers: ${memory.criticalIdentifiers.join(", ") || "none"}`,
    memory.compressionWarnings.length ? `Compression warnings: ${memory.compressionWarnings.join("; ")}` : "Compression warnings: none",
  ].join("\n");
}

export function retrieveRelevantMemory(memory: LongHorizonMemory, query: string, limit = 8): RetrievalResult[] {
  const q = query.toLowerCase();
  const terms = unique(q.split(/\W+/u).filter((t) => t.length > 2), 40);
  return [...memory.working, ...memory.episodic, ...memory.durable]
    .map((item) => {
      const haystack = `${item.content} ${item.identifiers.join(" ")}`.toLowerCase();
      const termScore = terms.reduce((score, term) => score + (haystack.includes(term) ? 2 : 0), 0);
      const idScore = item.identifiers.reduce((score, id) => score + (q.includes(id.toLowerCase()) ? 5 : 0), 0);
      const tierBoost = item.tier === "working" ? 2 : item.tier === "durable" ? 1.5 : 1;
      return { item, score: termScore + idScore + tierBoost };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
