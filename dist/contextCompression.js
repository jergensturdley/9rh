import { createHash } from "crypto";
const DEFAULT_CHAR_THRESHOLD = 6_000;
const DEFAULT_LINE_THRESHOLD = 120;
const DEFAULT_MAX_CHARS = 2_400;
const SIGNAL_RE = /(?:\b(?:error|exception|failed|failure|fatal|panic|traceback|warning|expected|actual|received|diff|patch|fail|timeout|denied|not found|passed|skipped)\b|\b[\w./-]+\.\w{1,8}:\d+\b|^\s*(?:[-+@]{2,}|FAIL|PASS|✗|✓))/iu;
function hashText(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
function cleanLine(line) {
    return line
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 260);
}
function uniqueSignals(lines, limit) {
    const seen = new Set();
    const signals = [];
    for (const line of lines) {
        if (signals.length >= limit)
            break;
        if (!SIGNAL_RE.test(line))
            continue;
        const cleaned = cleanLine(line);
        if (!cleaned || seen.has(cleaned))
            continue;
        seen.add(cleaned);
        signals.push(cleaned);
    }
    return signals;
}
export function compressContextText(text, label = "context", options = {}) {
    const opts = {
        charThreshold: options.charThreshold ?? DEFAULT_CHAR_THRESHOLD,
        lineThreshold: options.lineThreshold ?? DEFAULT_LINE_THRESHOLD,
        maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
    };
    const lines = text.split(/\r?\n/u);
    if (text.length <= opts.charThreshold && lines.length < opts.lineThreshold) {
        return { text, changed: false, originalChars: text.length, compressedChars: text.length };
    }
    const head = lines.slice(0, 12).map(cleanLine).filter(Boolean);
    const tail = lines.slice(-12).map(cleanLine).filter(Boolean);
    const signals = uniqueSignals(lines, 60);
    const parts = [
        `[${label} compressed for model context: ${lines.length.toLocaleString()} lines / ${text.length.toLocaleString()} chars; sha256:${hashText(text)}]`,
    ];
    if (signals.length > 0)
        parts.push(`[High-signal lines]\n${signals.map((line) => `- ${line}`).join("\n")}`);
    if (head.length > 0)
        parts.push(`[Head]\n${head.map((line) => `- ${line}`).join("\n")}`);
    if (tail.length > 0)
        parts.push(`[Tail]\n${tail.map((line) => `- ${line}`).join("\n")}`);
    parts.push("[Note]\nFull output was omitted from future model context for token frugality. Re-run the tool with a narrower range/query if exact omitted content is needed.");
    let compressed = parts.join("\n\n");
    if (compressed.length > opts.maxChars)
        compressed = compressed.slice(0, opts.maxChars - 1).trimEnd() + "…";
    return {
        text: compressed,
        changed: true,
        originalChars: text.length,
        compressedChars: compressed.length,
    };
}
export function compressToolResultForContext(toolName, output, error, options = {}) {
    const content = error ? `ERROR: ${error}\n${output}` : output;
    const result = compressContextText(content, `tool result:${toolName}`, options);
    if (!result.changed)
        return result;
    const compacted = `${result.text}\n\n[Tool context compaction]\nOriginal ${toolName} output kept for UI/replay, but this compact form is what subsequent model turns see.`;
    return {
        ...result,
        text: compacted,
        compressedChars: compacted.length,
    };
}
//# sourceMappingURL=contextCompression.js.map