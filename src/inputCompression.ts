import { createHash } from "crypto";

export interface CompressionOptions {
  textCharThreshold?: number;
  textLineThreshold?: number;
  maxChars?: number;
}

export interface CompressionResult {
  text: string;
  changed: boolean;
  notices: string[];
}

const DEFAULT_TEXT_CHAR_THRESHOLD = 4_000;
const DEFAULT_TEXT_LINE_THRESHOLD = 20;
const DEFAULT_MAX_CHARS = 2_400;
const DATA_IMAGE_RE = /data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,([A-Za-z0-9+/=\r\n]+)/gi;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\((data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);base64,[^)\s]+)\)/gi;
const IMAGE_PATH_RE = /(?:^|\s)([\w./~:@%+\\-]+\.(?:png|jpe?g|gif|webp|bmp|svg))(?:\s|$)/gi;
const PYTHON_FRAME_RE = /^\s*[│┃]?\s*(?:File ")?(.+?\.py)(?:", line |:)(\d+)(?:\s+in\s+([\w.<>]+))?/u;
const EXCEPTION_LINE_RE = /^\s*(?:[A-Za-z_][\w.]*Error|Exception|Traceback|[\w.]+Exception)\b.*$/u;
const IMPORTANT_LINE_RE = /(?:\b(?:error|exception|failed|failure|fatal|panic|traceback|warning|todo|fixme|expected|actual|received|diff|patch|file|command|test|build|compile|timeout|denied|not found|fail)\b|\b[\w./-]+\.\w{1,8}:\d+\b|^\s*(?:[-+@]{2,}|[>#] |\d+\)|[-*]\s))/iu;
const CODE_FENCE_RE = /```[\s\S]*?```/gu;

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function byteLengthFromBase64(base64: string): number {
  const compact = base64.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function replaceImageDataUrls(input: string): CompressionResult {
  const notices: string[] = [];
  let imageCount = 0;
  let text = input.replace(MARKDOWN_IMAGE_RE, (_match, alt: string, url: string) => {
    const replaced = replaceImageDataUrls(url);
    imageCount += 1;
    notices.push(...replaced.notices);
    return `![${alt || "pasted image"}](${replaced.text})`;
  });

  text = text.replace(DATA_IMAGE_RE, (_match, kind: string, base64: string) => {
    imageCount += 1;
    const compact = base64.replace(/\s+/g, "");
    const bytes = byteLengthFromBase64(compact);
    const digest = hashText(compact);
    notices.push(`pasted image compressed: image/${kind}, ~${bytes.toLocaleString()} bytes, sha256:${digest}`);
    return `[Pasted an image: image/${kind}, ~${bytes.toLocaleString()} bytes, sha256:${digest}. Original base64 omitted. Save/reference a file path if exact visual details matter.]`;
  });

  return { text, changed: text !== input, notices };
}



function stripTerminalNoise(line: string): string {
  return line
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "")
    .replace(/[╭╮╰╯│┃]/gu, " ")
    .replace(/[─━]{4,}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeInputLine(line: string): string {
  return stripTerminalNoise(line)
    .replace(/\s+$/u, "")
    .replace(/^(?:\$|>|❯)\s+/u, "cmd: ");
}

function uniquePush(lines: string[], seen: Set<string>, line: string, maxLength = 240): void {
  const normalized = normalizeInputLine(line).slice(0, maxLength);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  lines.push(normalized);
}

function extractCodeFenceSummaries(input: string): string[] {
  return Array.from(input.matchAll(CODE_FENCE_RE)).slice(0, 6).map((match, index) => {
    const fence = match[0];
    const lines = fence.split(/\r?\n/u);
    const first = lines[0].replace(/^```/u, "").trim() || "text";
    const body = lines.slice(1, -1);
    const head = body.slice(0, 5).map((line) => normalizeInputLine(line)).filter(Boolean);
    const tail = body.length > 8 ? body.slice(-3).map((line) => normalizeInputLine(line)).filter(Boolean) : [];
    const omitted = Math.max(0, body.length - head.length - tail.length);
    return [
      `fence ${index + 1}: ${first}, ${body.length.toLocaleString()} lines`,
      ...head.map((line) => `  ${line}`),
      ...(omitted > 0 ? [`  … ${omitted.toLocaleString()} code lines omitted …`] : []),
      ...tail.map((line) => `  ${line}`),
    ].join("\n");
  });
}

function buildFrugalLargeTextSummary(input: string, opts: Required<CompressionOptions>): string {
  const lines = input.split(/\r?\n/u);
  const digest = hashText(input);
  const seen = new Set<string>();
  const head = lines.slice(0, 4).map((line) => normalizeInputLine(line).slice(0, 180)).filter(Boolean);
  const tail = lines.slice(-4).map((line) => normalizeInputLine(line).slice(0, 180)).filter(Boolean);
  const important: string[] = [];

  for (const line of lines) {
    if (important.length >= 40) break;
    if (IMPORTANT_LINE_RE.test(line)) uniquePush(important, seen, line);
  }

  const codeFences = extractCodeFenceSummaries(input);
  const parts = [
    `[User input compressed for token frugality: ${lines.length.toLocaleString()} lines / ${input.length.toLocaleString()} chars; sha256:${digest}]`,
  ];
  if (head.length > 0) parts.push(`[Opening context]\n${head.map((line) => `- ${line}`).join("\n")}`);
  if (important.length > 0) parts.push(`[Signals preserved]\n${important.map((line) => `- ${line}`).join("\n")}`);
  if (codeFences.length > 0) parts.push(`[Code fences summarized]\n${codeFences.join("\n---\n")}`);
  if (tail.length > 0) parts.push(`[Closing context]\n${tail.map((line) => `- ${line}`).join("\n")}`);
  parts.push("[Instruction]\nIf exact omitted content is needed, ask the user for the specific file/log slice rather than assuming details.");

  let text = parts.join("\n\n");
  if (text.length > opts.maxChars) text = text.slice(0, opts.maxChars - 1).trimEnd() + "…";
  return text;
}

function compressTerminalTraceback(input: string, opts: Required<CompressionOptions>): CompressionResult | null {
  const hasTraceback = /Traceback \(most recent call last\)|\bMountError:|\b\w+Error:/u.test(input);
  const boxChars = Array.from(input.matchAll(/[╭╮╰╯│─━┌┐└┘├┤┬┴┼]/gu)).length;
  if (!hasTraceback || boxChars < 8) return null;

  const lines = input.split(/\r?\n/u);
  const frames: string[] = [];
  const messages: string[] = [];
  const snippets: string[] = [];

  for (const rawLine of lines) {
    const clean = stripTerminalNoise(rawLine);
    if (!clean) continue;

    const frame = clean.match(PYTHON_FRAME_RE);
    if (frame) {
      const [, file, line, fn] = frame;
      const summary = `${file}:${line}${fn ? ` in ${fn}` : ""}`;
      if (!frames.includes(summary)) frames.push(summary);
      continue;
    }

    if (EXCEPTION_LINE_RE.test(clean) || /Can't mount widget\(s\)|most recent call last/iu.test(clean)) {
      if (!messages.includes(clean)) messages.push(clean.slice(0, 260));
      continue;
    }

    if (/^\d+\s+[│┃]?/u.test(clean) || /\b(?:self\.|return |raise |await |def |class )/u.test(clean)) {
      const snippet = clean.replace(/^\d+\s+/u, "").slice(0, 180);
      if (!snippets.includes(snippet)) snippets.push(snippet);
    }
  }

  const digest = hashText(input);
  const parts = [
    `[Terminal traceback/box output condensed: ${lines.length.toLocaleString()} lines / ${input.length.toLocaleString()} chars; sha256:${digest}]`,
  ];
  if (messages.length > 0) parts.push(`[Error]\n${messages.slice(-3).join("\n")}`);
  if (frames.length > 0) parts.push(`[Frames]\n${frames.slice(0, 12).map((frame) => `- ${frame}`).join("\n")}`);
  if (snippets.length > 0) parts.push(`[Relevant code]\n${snippets.slice(0, 8).map((snippet) => `- ${snippet}`).join("\n")}`);

  let text = parts.join("\n");
  if (text.length > opts.maxChars) text = text.slice(0, opts.maxChars - 1).trimEnd() + "…";

  return {
    text,
    changed: true,
    notices: [`terminal traceback condensed: ${lines.length.toLocaleString()} lines/${input.length.toLocaleString()} chars → ${text.length.toLocaleString()} chars`],
  };
}

function compressLargeText(input: string, opts: Required<CompressionOptions>): CompressionResult {
  const lines = input.split(/\r?\n/u);
  const charCount = input.length;
  const lineCount = lines.length;
  const terminalTraceback = compressTerminalTraceback(input, opts);
  if (terminalTraceback) return terminalTraceback;
  if (charCount <= opts.textCharThreshold && lineCount < opts.textLineThreshold) {
    return { text: input, changed: false, notices: [] };
  }

  const isLineWall = lineCount >= opts.textLineThreshold;
  const text = buildFrugalLargeTextSummary(input, opts);

  return {
    text,
    changed: true,
    notices: [isLineWall
      ? `pasted large input compressed: ${lineCount.toLocaleString()} lines → ${text.length.toLocaleString()} chars`
      : `pasted large input compressed: ${charCount.toLocaleString()} chars → ${text.length.toLocaleString()} chars`],
  };
}

export function compressUserInput(input: string, options: CompressionOptions = {}): CompressionResult {
  const opts: Required<CompressionOptions> = {
    textCharThreshold: options.textCharThreshold ?? DEFAULT_TEXT_CHAR_THRESHOLD,
    textLineThreshold: options.textLineThreshold ?? DEFAULT_TEXT_LINE_THRESHOLD,
    maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
  };

  const imagePass = replaceImageDataUrls(input);
  const textPass = compressLargeText(imagePass.text, opts);

  const imagePathMatches = Array.from(input.matchAll(IMAGE_PATH_RE)).map((match) => match[1]).slice(0, 12);
  const imagePathNotice = imagePathMatches.length > 0
    ? [`detected image path reference(s): ${imagePathMatches.join(", ")}. The agent can inspect metadata/path context, but not raw pixels unless tooling is added.`]
    : [];

  return {
    text: textPass.text,
    changed: imagePass.changed || textPass.changed,
    notices: [...imagePass.notices, ...textPass.notices, ...imagePathNotice],
  };
}
