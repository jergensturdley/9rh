import { describe, expect, it, beforeEach, afterEach } from "@jest/globals";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// We test the public surface from skills.ts. The discovery paths
// read from process.env.HOME, so each test builds a private HOME
// via mkdtemp + a HOME override and points defaultSkillRoots at it
// by passing the workdir directly. (discoverSkills accepts an
// optional workdir which prepends workdir-local skill roots; the
// user-level roots are read from $HOME, so we set HOME before
// importing the module under test.)
describe("skills: frontmatter parser", () => {
  it("parses a basic name+description frontmatter", async () => {
    const { parseFrontmatter } = await import("../skills.js");
    const fm = parseFrontmatter(
      "---\nname: example-skill\ndescription: Does X and Y. Use when the user asks for X.\n---\n# body\n",
    );
    expect(fm.name).toBe("example-skill");
    expect(fm.description).toBe("Does X and Y. Use when the user asks for X.");
  });

  it("returns empty object for missing frontmatter", async () => {
    const { parseFrontmatter } = await import("../skills.js");
    expect(parseFrontmatter("# no frontmatter\nbody")).toEqual({});
  });

  it("strips surrounding quotes from the description", async () => {
    const { parseFrontmatter } = await import("../skills.js");
    const fm = parseFrontmatter(
      "---\nname: \"quoted-name\"\ndescription: 'with quotes'\n---\nbody\n",
    );
    expect(fm.name).toBe("quoted-name");
    expect(fm.description).toBe("with quotes");
  });

  it("ignores unknown keys", async () => {
    const { parseFrontmatter } = await import("../skills.js");
    const fm = parseFrontmatter(
      "---\nname: x\ndescription: y\nunknown: z\n---\nbody\n",
    );
    expect(fm).toEqual({ name: "x", description: "y" });
  });
});

describe("skills: discovery", () => {
  let sandbox: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "9rh-skills-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = sandbox;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(sandbox, { recursive: true, force: true });
  });

  it("finds a single SKILL.md in a workdir-root skills/ folder", async () => {
    const skillsDir = join(sandbox, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(
      join(skillsDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: A test skill.\n---\nbody\n",
    );
    const { discoverSkills } = await import("../skills.js");
    const manifest = await discoverSkills(sandbox);
    expect(manifest.map((m) => m.name)).toContain("my-skill");
  });

  it("finds a nested skill (category/skill/SKILL.md)", async () => {
    const nested = join(sandbox, "skills", "creative", "poet");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "SKILL.md"),
      "---\nname: poet\ndescription: Writes poetry on demand.\n---\n",
    );
    const { discoverSkills } = await import("../skills.js");
    const manifest = await discoverSkills(sandbox);
    const entry = manifest.find((m) => m.name === "poet");
    expect(entry).toBeDefined();
    expect(entry!.description).toBe("Writes poetry on demand.");
  });

  it("falls back to inferred name when frontmatter has no name", async () => {
    const dir = join(sandbox, "skills", "inferred-name");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\ndescription: No name field, should fall back to inferred-name.\n---\n",
    );
    const { discoverSkills } = await import("../skills.js");
    const manifest = await discoverSkills(sandbox);
    const entry = manifest.find((m) => m.name === "inferred-name");
    expect(entry).toBeDefined();
    expect(entry!.description).toContain("No name field");
  });

  it("first-source-wins on name collision across multiple roots", async () => {
    // workdir-root has priority over user-9rh for same name.
    const workdirSkill = join(sandbox, "skills", "dupe");
    await mkdir(workdirSkill, { recursive: true });
    await writeFile(
      join(workdirSkill, "SKILL.md"),
      "---\nname: dupe\ndescription: from workdir\n---\n",
    );
    const user9rh = join(sandbox, ".9rh", "skills", "dupe");
    await mkdir(user9rh, { recursive: true });
    await writeFile(
      join(user9rh, "SKILL.md"),
      "---\nname: dupe\ndescription: from user-9rh\n---\n",
    );
    const { discoverSkills } = await import("../skills.js");
    const manifest = await discoverSkills(sandbox);
    const entry = manifest.find((m) => m.name === "dupe");
    expect(entry).toBeDefined();
    expect(entry!.description).toBe("from workdir");
    expect(entry!.source).toBe("workdir-root");
  });

  it("skips dotted directories (curator state, archives)", async () => {
    const hidden = join(sandbox, "skills", ".archive");
    await mkdir(hidden, { recursive: true });
    await writeFile(
      join(hidden, "SKILL.md"),
      "---\nname: hidden-skill\ndescription: Should not appear.\n---\n",
    );
    const { discoverSkills } = await import("../skills.js");
    const manifest = await discoverSkills(sandbox);
    expect(manifest.find((m) => m.name === "hidden-skill")).toBeUndefined();
  });

  it("skips symlinks (deterministic loader, no surprise recursion)", async () => {
    const real = join(sandbox, "skills", "real");
    await mkdir(real, { recursive: true });
    await writeFile(
      join(real, "SKILL.md"),
      "---\nname: real\ndescription: Real skill.\n---\n",
    );
    const linked = join(sandbox, "skills", "linked");
    await symlink(real, linked);
    const { discoverSkills } = await import("../skills.js");
    const manifest = await discoverSkills(sandbox);
    // The real one is found; the symlink should not produce a duplicate.
    // Note: the harness may pick up other unrelated skills from
    // elsewhere on disk (e.g. the workdir-tree superpowers), so we
    // filter to entries actually inside our sandbox.
    const matches = manifest.filter((m) => m.path.startsWith(sandbox));
    expect(matches.length).toBe(1);
    expect(matches[0].path).toContain("real");
  });

  it("returns no workdir-scoped skills for an empty workdir", async () => {
    // Note: this only asserts that the workdir-scoped roots are
    // empty. The function still scans user-level roots in $HOME
    // (which is the test sandbox here, also empty) so the manifest
    // is empty, but if the user has real skills installed those
    // will appear too. That's the intended behavior — the workdir
    // is a PRIORITY layer, not a filter.
    const { discoverSkills } = await import("../skills.js");
    const manifest = await discoverSkills(sandbox);
    const fromWorkdir = manifest.filter((m) => m.source.startsWith("workdir-"));
    expect(fromWorkdir).toEqual([]);
  });
});

describe("skills: readSkill", () => {
  let sandbox: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "9rh-skills-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = sandbox;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(sandbox, { recursive: true, force: true });
  });

  it("returns the full body (frontmatter + markdown) for a known name", async () => {
    const dir = join(sandbox, "skills", "my-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: my-skill\ndescription: Does things.\n---\n# Body\n\nMore text.\n",
    );
    const { readSkill } = await import("../skills.js");
    const { entry, content } = await readSkill("my-skill", sandbox);
    expect(entry.description).toBe("Does things.");
    expect(content).toContain("# Body");
    expect(content).toContain("More text.");
  });

  it("throws on unknown skill name with a helpful hint", async () => {
    const dir = join(sandbox, "skills", "known-skill");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: known-skill\ndescription: a\n---\n",
    );
    const { readSkill } = await import("../skills.js");
    await expect(readSkill("does-not-exist", sandbox)).rejects.toThrow(/unknown skill 'does-not-exist'/);
  });

  it("rejects an invalid skill name (path traversal guard)", async () => {
    const { readSkill } = await import("../skills.js");
    await expect(readSkill("../etc/passwd", sandbox)).rejects.toThrow(/invalid skill name/);
  });
});

describe("skills: buildSkillsSection", () => {
  it("renders a header + bulleted manifest", async () => {
    const { buildSkillsSection } = await import("../skills.js");
    const out = buildSkillsSection([
      { name: "alpha", description: "First.", path: "/x", source: "user-9rh" },
      { name: "beta", description: "Second.", path: "/y", source: "user-hermes" },
    ]);
    expect(out).toContain("## Available skills");
    expect(out).toContain("**alpha**");
    expect(out).toContain("First.");
    expect(out).toContain("**beta**");
    expect(out).toContain("Second.");
  });

  it("renders the 'none installed' message for an empty manifest", async () => {
    const { buildSkillsSection } = await import("../skills.js");
    expect(buildSkillsSection([])).toContain("(none installed");
  });

  it("truncates the tail when the manifest exceeds the cap", async () => {
    const { buildSkillsSection } = await import("../skills.js");
    // Build a large enough manifest to force truncation (cap is 15K).
    const big = Array.from({ length: 5000 }, (_, i) => ({
      name: `skill-${i.toString().padStart(4, "0")}`,
      description: `This skill is number ${i} and does something moderately useful for testing the truncation behaviour of the system-prompt section builder.`,
      path: `/skills/${i}`,
      source: "user-9rh" as const,
    }));
    const out = buildSkillsSection(big);
    expect(out.length).toBeLessThanOrEqual(16_000); // some slack for the header
    expect(out).toMatch(/more skills; call load_skill/);
  });
});
