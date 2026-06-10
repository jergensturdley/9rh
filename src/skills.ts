// Skills: filesystem-based bundles of instructions an agent can load
// on demand. Inspired by Anthropic's "Agent Skills" progressive
// disclosure design — only (name, description) lives in the system
// prompt, and the agent pulls the full body via the load_skill tool
// when (and if) it decides a skill is relevant.
//
// This module is read-only with respect to the filesystem. Skill
// installation lives in src/tools.ts (install_skill) so it can
// flow through the same approval gate as everything else.
//
// Sources searched, in priority order (first match wins for a given
// name; collisions logged but not auto-resolved):
//   1. ~/.9rh/skills/                   (9rh-native; the install_skill target)
//   2. ~/.hermes/skills/                (legacy Hermes skills, still useful)
//   3. <workdir>/.9rh/skills/           (per-project override; gitignored)
//   4. <workdir>/skills/                (per-project; project-managed)
//
// Skill layout (any of these shapes works):
//   <root>/<name>/SKILL.md                  ← single skill in its own dir
//   <root>/<category>/<name>/SKILL.md       ← nested under a category
//   <root>/SKILL.md                         ← root-level skill
//
// SKILL.md format:
//   ---
//   name: short-identifier
//   description: one-paragraph "what + when to use"
//   ---
//   <markdown body — full instructions, ~5K tokens typical>

import { readFile, readdir, lstat } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface SkillManifestEntry {
  /** Skill identifier — kebab/snake case, ≤64 chars. */
  name: string;
  /** One-paragraph "what + when to use" from the YAML frontmatter. */
  description: string;
  /** Absolute path to the SKILL.md on disk. */
  path: string;
  /** Which source root this skill came from. */
  source: SkillSource;
}

export type SkillSource =
  | "user-9rh"
  | "user-hermes"
  | "workdir-9rh"
  | "workdir-root"
  | "workdir-9rh-legacy";

interface ParsedFrontmatter {
  name?: string;
  description?: string;
}

// ---------- Frontmatter parser ----------

/**
 * Pull a YAML-ish frontmatter block out of markdown. We don't pull
 * in a YAML library because the only fields we need (name,
 * description) are simple scalar strings — handling the common case
 * (single-line `key: value`) covers 99% of real-world SKILL.md
 * files. Multi-line folded scalars (`>` / `|`) and lists are not
 * supported; if the description is one of those, the user should
 * switch to a single-line form.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return {};
  const block = m[1];
  const out: ParsedFrontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") out.name = value;
    if (key === "description") out.description = value;
  }
  return out;
}

// ---------- File walker ----------

async function* walkSkillFiles(root: string): AsyncGenerator<string> {
  // Skip dotted directories (curator state, archives, etc.).
  async function* recurse(dir: string, depth: number): AsyncGenerator<string> {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const st = await lstat(full).catch(() => null);
      if (!st) continue;
      if (st.isSymbolicLink()) continue; // skip — keep the loader deterministic
      if (st.isDirectory()) {
        yield* recurse(full, depth + 1);
      } else if (entry === "SKILL.md" && st.isFile()) {
        yield full;
      }
    }
  }
  yield* recurse(root, 0);
}

/**
 * Best-effort name inference when the SKILL.md frontmatter is
 * missing or has no name. Path-based fallback so we never silently
 * drop a skill because of bad frontmatter — the LLM will just see
 * a placeholder description and skip it.
 */
function inferName(skillFilePath: string, root: string): string {
  // Path under root, e.g. "agency-agents/psychologist/SKILL.md" → "psychologist"
  const rel = skillFilePath.slice(root.length).replace(/^\/+/, "");
  const parts = rel.split("/");
  parts.pop(); // drop SKILL.md
  const leaf = parts.pop() ?? "unnamed";
  return leaf;
}

// ---------- Discovery ----------

/** Standard 9rh + Hermes skill roots, in priority order. */
export function defaultSkillRoots(workdir?: string): Array<{ root: string; source: SkillSource }> {
  const roots: Array<{ root: string; source: SkillSource }> = [];
  const user9rh = join(homedir(), ".9rh", "skills");
  const userHermes = join(homedir(), ".hermes", "skills");
  if (workdir) {
    // Per-project roots first — they should win over user-level when
    // both define a skill with the same name.
    roots.push({ root: join(workdir, "skills"), source: "workdir-root" });
    roots.push({ root: join(workdir, ".9rh", "skills"), source: "workdir-9rh" });
  }
  if (existsSync(user9rh)) roots.push({ root: user9rh, source: "user-9rh" });
  if (existsSync(userHermes)) roots.push({ root: userHermes, source: "user-hermes" });
  return roots;
}

/**
 * Walk all configured roots and return a flat list of skills.
 * First-wins on name collision; later roots are skipped.
 */
export async function discoverSkills(workdir?: string): Promise<SkillManifestEntry[]> {
  const seen = new Map<string, SkillManifestEntry>();
  for (const { root, source } of defaultSkillRoots(workdir)) {
    for await (const file of walkSkillFiles(root)) {
      let content: string;
      try {
        content = await readFile(file, "utf-8");
      } catch {
        continue;
      }
      const fm = parseFrontmatter(content);
      const name = (fm.name && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(fm.name))
        ? fm.name.toLowerCase()
        : inferName(file, root).toLowerCase();
      if (seen.has(name)) continue; // first source wins
      const description = fm.description?.trim() || `(no description — see ${file})`;
      seen.set(name, { name, description, path: file, source });
    }
  }
  // Stable, sorted output so the system-prompt section is deterministic.
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Reading a skill body ----------

/**
 * Resolve a skill name to its full file contents (frontmatter +
 * body). Throws if the name is unknown. Used by the load_skill tool.
 */
export async function readSkill(name: string, workdir?: string): Promise<{ entry: SkillManifestEntry; content: string }> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
    throw new Error(`invalid skill name: ${name}`);
  }
  const manifest = await discoverSkills(workdir);
  const entry = manifest.find((s) => s.name === name.toLowerCase());
  if (!entry) {
    const known = manifest.map((s) => s.name).slice(0, 10).join(", ");
    const more = manifest.length > 10 ? `, … (${manifest.length - 10} more)` : "";
    throw new Error(`unknown skill '${name}'. Known skills: ${known}${more}`);
  }
  const content = await readFile(entry.path, "utf-8");
  return { entry, content };
}

// ---------- System prompt section ----------

/**
 * Render the manifest as a compact section the LLM can scan to
 * decide which (if any) skill to load. Capped at 15K characters so
 * a wild install (1000+ skills) doesn't blow the context window.
 * If we have to truncate, the tail of the list is dropped and a
 * "(see load_skill to enumerate the rest)" hint is added — the
 * load_skill tool is the safe path for the full set.
 */
export function buildSkillsSection(manifest: SkillManifestEntry[]): string {
  if (manifest.length === 0) {
    return "## Available skills\n\n(none installed — use install_skill to add some)";
  }
  const lines: string[] = [
    "## Available skills",
    "",
    "Each entry below is a skill installed on this system. The LLM can call `load_skill` to pull the full instructions for any one of them. Pick the skill whose description best matches the user's current task, then load it. Do not load a skill whose description does not match — its instructions will mislead you.",
    "",
  ];
  const body = manifest
    .map((s) => `- **${s.name}** — ${s.description}`)
    .join("\n");
  const head = `${lines.join("\n")}${body}\n`;
  const cap = 15_000;
  if (head.length <= cap) return head;
  // Truncate by lines so we don't cut a description in half.
  const truncatedLines: string[] = [];
  let used = head.length - body.length;
  for (const s of manifest) {
    const line = `- **${s.name}** — ${s.description}\n`;
    if (used + line.length > cap) break;
    truncatedLines.push(line);
    used += line.length;
  }
  return lines.join("\n") + truncatedLines.join("") +
    `\n…(${manifest.length - truncatedLines.length} more skills; call load_skill with any of the names above to read its body)\n`;
}

// ---------- Workdir resolution helper ----------
// (Reserved for future use; the current load path doesn't need it.)
