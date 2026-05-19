import { readFile, writeFile, readdir, lstat, readlink, realpath } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { join, resolve, normalize } from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { SandboxProvider, ExecutionResult } from "./sandbox/index.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 40_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const PATH_CACHE_LIMIT = 512;

const realWorkDirCache = new Map<string, string>();
const sandboxPathCache = new Map<string, string>();

function rememberBounded(cache: Map<string, string>, key: string, value: string): string {
  if (cache.size >= PATH_CACHE_LIMIT) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, value);
  return value;
}

async function realworkDir(workDir: string): Promise<string> {
  const cached = realWorkDirCache.get(workDir);
  if (cached) return cached;
  return rememberBounded(realWorkDirCache, workDir, normalize(await realpath(workDir).catch(async () => readlink(workDir).catch(() => workDir))));
}

async function sandboxPath(rawPath: string, workDir: string): Promise<string> {
  const cacheKey = `${workDir}\0${rawPath}`;
  const cached = sandboxPathCache.get(cacheKey);
  if (cached) return cached;
  const realWorkDir = await realworkDir(workDir);
  const abs = resolve(realWorkDir, rawPath);
  const normalized = normalize(await realpath(abs).catch(() => abs));
  if (!normalized.startsWith(realWorkDir + "/") && normalized !== realWorkDir) {
    throw new Error(`Path escapes workDir: ${rawPath}`);
  }
  return rememberBounded(sandboxPathCache, cacheKey, abs);
}

async function assertExistingPathIsNotSymlink(rawPath: string, workDir: string, operation: string): Promise<string> {
  const sandboxed = await sandboxPath(rawPath, workDir);
  const linkStat = await lstat(sandboxed).catch(() => null);
  if (linkStat?.isSymbolicLink()) {
    throw new Error(`Cannot ${operation} through symlink: ${rawPath}`);
  }
  if (linkStat) {
    const realTarget = normalize(await realpath(sandboxed));
    const realWorkDir = await realworkDir(workDir);
    if (!realTarget.startsWith(realWorkDir + "/") && realTarget !== realWorkDir) {
      throw new Error(`Path escapes workDir: ${rawPath}`);
    }
  }
  return sandboxed;
}

async function assertWritablePath(rawPath: string, workDir: string): Promise<string> {
  const sandboxed = await sandboxPath(rawPath, workDir);
  const linkStat = await lstat(sandboxed).catch(() => null);
  if (linkStat?.isSymbolicLink()) {
    throw new Error(`Cannot write through symlink: ${rawPath}`);
  }
  const parentRealPath = normalize(await realpath(join(sandboxed, "..")).catch(() => dirnameFallback(sandboxed)));
  const realWorkDir = await realworkDir(workDir);
  if (!parentRealPath.startsWith(realWorkDir + "/") && parentRealPath !== realWorkDir) {
    throw new Error(`Path escapes workDir: ${rawPath}`);
  }
  return sandboxed;
}

function dirnameFallback(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (timeoutMs > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return timeoutMs;
}

function truncateOutput(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const kept = s.slice(0, MAX_OUTPUT_CHARS);
  return kept + `\n…(truncated ${s.length - MAX_OUTPUT_CHARS} chars)`;
}

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file. Returns file content as a string. Use for viewing source code, configs, or any text file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file to read.",
          },
          start_line: {
            type: "number",
            description: "Optional: 1-based line number to start reading from.",
          },
          end_line: {
            type: "number",
            description: "Optional: 1-based line number to stop reading at (inclusive).",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file, creating it if it does not exist and overwriting it if it does. Use for creating or modifying source files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file to write.",
          },
          content: {
            type: "string",
            description: "The full content to write to the file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_bash",
      description:
        "Execute a shell command and return its stdout + stderr. Use for running tests, builds, git operations, grep searches, or any shell task. Commands run in the working directory. WARNING: Commands execute with full user permissions; only use for trusted tasks.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
          timeout_ms: {
            type: "number",
            description:
              "Optional: maximum execution time in milliseconds (default: 30000).",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and directories at a given path. Returns names with trailing '/' for directories.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory path to list. Defaults to current directory if omitted.",
          },
          recursive: {
            type: "boolean",
            description:
              "If true, list recursively (up to 3 levels deep). Default false.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search for a text pattern in files using grep. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression or literal string to search for.",
          },
          path: {
            type: "string",
            description:
              "Directory or file to search in. Defaults to current directory.",
          },
          glob: {
            type: "string",
            description: 'File glob pattern, e.g. "*.ts" or "*.{ts,tsx}".',
          },
          case_insensitive: {
            type: "boolean",
            description: "If true, search is case-insensitive. Default false.",
          },
        },
        required: ["pattern"],
      },
    },
  },
];

export interface ToolResult {
  output: string;
  error?: string;
}

export interface ExecuteToolOptions {
  executor?: SandboxProvider;
  onBashResult?: (result: ExecutionResult, command: string) => void;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workDir: string,
  options?: ExecuteToolOptions
): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_file":
        return await toolReadFile(args, workDir);
      case "write_file":
        return await toolWriteFile(args, workDir);
      case "run_bash":
        return await toolRunBash(args, workDir, options?.executor, options?.onBashResult);
      case "list_files":
        return await toolListFiles(args, workDir);
      case "search_files":
        return await toolSearchFiles(args, workDir);
      default:
        return { output: "", error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      output: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function toolReadFile(
  args: Record<string, unknown>,
  workDir: string
): Promise<ToolResult> {
  const filePath = await sandboxPath(String(args.path), workDir);
  await assertExistingPathIsNotSymlink(String(args.path), workDir, "read");
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n");
  const start = typeof args.start_line === "number" ? args.start_line - 1 : 0;
  const end = typeof args.end_line === "number" ? args.end_line : lines.length;
  const slice = lines.slice(start, end);
  const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
  return { output: truncateOutput(numbered) };
}

async function toolWriteFile(
  args: Record<string, unknown>,
  workDir: string
): Promise<ToolResult> {
  const { mkdir } = await import("fs/promises");
  const { dirname } = await import("path");
  const filePath = await assertWritablePath(String(args.path), workDir);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, String(args.content), "utf-8");
  return { output: `Written ${filePath}` };
}

async function toolRunBash(
  args: Record<string, unknown>,
  workDir: string,
  executor?: SandboxProvider,
  onResult?: (result: ExecutionResult, command: string) => void,
): Promise<ToolResult> {
  const command = String(args.command);
  const rawTimeout = typeof args.timeout_ms === "number" ? args.timeout_ms : 30000;
  const timeoutMs = clampTimeout(rawTimeout);

  if (executor) {
    const result = await executor.exec(command, { timeoutMs });
    onResult?.(result, command);
    return { output: truncateOutput(result.output), error: result.error };
  }

  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      cwd: workDir,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 4,
    });
    const out = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
    return { output: truncateOutput(out || "(no output)") };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
    return { output: truncateOutput(combined || "(command failed)"), error: "exit non-zero" };
  }
}

async function toolListFiles(
  args: Record<string, unknown>,
  workDir: string
): Promise<ToolResult> {
  const dir =
    typeof args.path === "string"
      ? await sandboxPath(args.path, workDir)
      : workDir;
  const recursive = Boolean(args.recursive);

  async function listDir(p: string, depth: number): Promise<string[]> {
    const entries = await readdir(p);
    const results: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith(".") && depth === 0) continue;
      const full = join(p, entry);
      const s = await lstat(full).catch(() => null);
      if (!s || s.isSymbolicLink()) continue;
      const rel = full.replace(workDir + "/", "");
      if (s.isDirectory()) {
        results.push(rel + "/");
        if (recursive && depth < 3) {
          results.push(...(await listDir(full, depth + 1)));
        }
      } else {
        results.push(rel);
      }
    }
    return results;
  }

  const files = await listDir(dir, 0);
  return { output: truncateOutput(files.join("\n") || "(empty directory)") };
}

async function toolSearchFiles(
  args: Record<string, unknown>,
  workDir: string
): Promise<ToolResult> {
  const pattern = String(args.pattern);
  const searchPath =
    typeof args.path === "string"
      ? await sandboxPath(args.path, workDir)
      : workDir;

  const grepArgs = ["-rn", "--color=never"];
  if (args.case_insensitive) grepArgs.push("-i");
  if (typeof args.glob === "string" && args.glob) {
    grepArgs.push(`--include=${args.glob}`);
  }
  grepArgs.push(pattern, searchPath);

  try {
    const { stdout } = await execFileAsync("grep", grepArgs, {
      cwd: workDir,
      timeout: 15000,
    });
    return { output: truncateOutput(stdout.trim() || "(no matches)") };
  } catch (err: unknown) {
    const e = err as { stdout?: string; code?: number };
    if (e.code === 1) return { output: "(no matches)" };
    return { output: truncateOutput(e.stdout?.trim() || "(search error)") };
  }
}
