import { afterAll, afterEach, describe, expect, it, jest } from "@jest/globals";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { executeTool } from "../tools.js";
import { DirectExecutor } from "../sandbox/index.js";

// executeTool requires an executor even for tools that never touch it
// (web_*, list_files, etc). A real DirectExecutor is fine — these paths
// never call opts().
const opts = () => ({ executor: new DirectExecutor(process.cwd()) });

// Build a fetch Response stand-in that streams `body` as one chunk, so
// httpFetchText's getReader() loop runs exactly as it does in prod.
function mockResponse(
  body: string,
  opts: { status?: number; statusText?: string; contentType?: string } = {},
): Response {
  const status = opts.status ?? 200;
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: opts.statusText ?? "OK",
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type" ? opts.contentType ?? "text/plain" : null,
    },
    body: {
      getReader: () => ({
        read: async () =>
          sent ? { value: undefined, done: true } : ((sent = true), { value: bytes, done: false }),
      }),
    },
  } as unknown as Response;
}

const fetchSpy = jest.spyOn(globalThis, "fetch");

afterEach(() => {
  fetchSpy.mockReset();
});
afterAll(() => {
  fetchSpy.mockRestore();
});

describe("executeTool web_fetch", () => {
  it("strips scripts/styles and tags from HTML", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse(
        "<html><head><style>.a{color:red}</style><script>evil()</script></head>" +
          "<body><h1>Title</h1><p>Hello&nbsp;&amp; welcome</p></body></html>",
        { contentType: "text/html; charset=utf-8" },
      ),
    );
    const r = await executeTool("web_fetch", { url: "https://example.com/doc" }, process.cwd(), opts());
    expect(r.error).toBeUndefined();
    expect(r.output).toContain("Title");
    expect(r.output).toContain("Hello & welcome");
    expect(r.output).not.toContain("evil()");
    expect(r.output).not.toContain("color:red");
  });

  it("returns JSON bodies verbatim (no HTML stripping)", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse('{"key":"<value>"}', { contentType: "application/json" }),
    );
    const r = await executeTool("web_fetch", { url: "https://api.example.com/x" }, process.cwd(), opts());
    expect(r.output).toContain('{"key":"<value>"}');
  });

  it("truncates bodies larger than max_bytes", async () => {
    fetchSpy.mockResolvedValue(mockResponse("x".repeat(4000), { contentType: "text/plain" }));
    const r = await executeTool(
      "web_fetch",
      { url: "https://example.com/big", max_bytes: 1024 },
      process.cwd(),
      opts(),
    );
    expect(r.output).toContain("truncated at 1024 bytes");
  });

  it("surfaces non-2xx status as an error", async () => {
    fetchSpy.mockResolvedValue(mockResponse("nope", { status: 404, statusText: "Not Found" }));
    const r = await executeTool("web_fetch", { url: "https://example.com/missing" }, process.cwd(), opts());
    expect(r.output).toBe("");
    expect(r.error).toMatch(/HTTP 404 Not Found/);
  });

  it("maps an abort into a timeout error", async () => {
    fetchSpy.mockRejectedValue(new Error("The operation was aborted"));
    const r = await executeTool("web_fetch", { url: "https://example.com/slow" }, process.cwd(), opts());
    expect(r.error).toMatch(/timed out/);
  });

  it("maps a generic network failure into a fetch error", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await executeTool("web_fetch", { url: "https://example.com/down" }, process.cwd(), opts());
    expect(r.error).toMatch(/fetch failed: ECONNREFUSED/);
  });

  it("rejects a non-http URL at the validation boundary", async () => {
    const r = await executeTool("web_fetch", { url: "file:///etc/passwd" }, process.cwd(), opts());
    expect(r.error).toMatch(/url must start with http/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("executeTool web_search", () => {
  it("formats story and comment hits", async () => {
    const payload = {
      hits: [
        {
          title: "A Story",
          url: "https://story.example",
          author: "alice",
          created_at: "2026-01-02T00:00:00Z",
          points: 42,
          num_comments: 7,
          story_text: "story body <b>x</b>",
        },
        {
          _tags: ["comment"],
          story_title: "Parent Story",
          story_url: "https://parent.example",
          author: "bob",
          comment_text: "a helpful <i>comment</i>",
        },
      ],
    };
    fetchSpy.mockResolvedValue(mockResponse(JSON.stringify(payload), { contentType: "application/json" }));
    const r = await executeTool("web_search", { query: "typescript" }, process.cwd(), opts());
    expect(r.output).toContain("A Story");
    expect(r.output).toContain("https://story.example");
    expect(r.output).toContain("by alice");
    expect(r.output).toContain("42 pts");
    expect(r.output).toContain("[comment] Parent Story");
    expect(r.output).toContain("a helpful comment"); // tags stripped
  });

  it("reports no results for an empty hit list", async () => {
    fetchSpy.mockResolvedValue(mockResponse('{"hits":[]}', { contentType: "application/json" }));
    const r = await executeTool("web_search", { query: "zzz" }, process.cwd(), opts());
    expect(r.output).toMatch(/No results/);
  });

  it("errors on non-JSON search responses", async () => {
    fetchSpy.mockResolvedValue(mockResponse("<html>captcha</html>", { contentType: "text/html" }));
    const r = await executeTool("web_search", { query: "x" }, process.cwd(), opts());
    expect(r.error).toMatch(/non-JSON/);
  });

  it("errors on an unexpected JSON shape", async () => {
    fetchSpy.mockResolvedValue(mockResponse('{"results":[]}', { contentType: "application/json" }));
    const r = await executeTool("web_search", { query: "x" }, process.cwd(), opts());
    expect(r.error).toMatch(/unexpected shape/);
  });
});

describe("executeTool read_file / list_files / search_files", () => {
  it("read_file honors start_line and end_line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "9rh-fs-"));
    try {
      await writeFile(join(dir, "f.txt"), "l1\nl2\nl3\nl4\nl5", "utf-8");
      const r = await executeTool(
        "read_file",
        { path: "f.txt", start_line: 2, end_line: 4 },
        dir,
        { executor: new DirectExecutor(dir) },
      );
      expect(r.output).toBe("2: l2\n3: l3\n4: l4");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("list_files hides dotfiles at depth 0 and skips symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "9rh-fs-"));
    try {
      await writeFile(join(dir, "visible.txt"), "x", "utf-8");
      await writeFile(join(dir, ".hidden"), "x", "utf-8");
      await symlink(join(dir, "visible.txt"), join(dir, "link.txt"));
      const r = await executeTool("list_files", {}, dir, { executor: new DirectExecutor(dir) });
      expect(r.output).toContain("visible.txt");
      expect(r.output).not.toContain(".hidden");
      expect(r.output).not.toContain("link.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("list_files recurses into subdirectories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "9rh-fs-"));
    try {
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "sub", "nested.txt"), "x", "utf-8");
      const r = await executeTool("list_files", { recursive: true }, dir, {
        executor: new DirectExecutor(dir),
      });
      expect(r.output).toContain("sub/");
      expect(r.output).toContain("sub/nested.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("search_files finds matches and reports none when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "9rh-fs-"));
    try {
      await writeFile(join(dir, "code.txt"), "needle here\nother line", "utf-8");
      const hit = await executeTool("search_files", { pattern: "needle" }, dir, {
        executor: new DirectExecutor(dir),
      });
      expect(hit.output).toContain("needle");
      const miss = await executeTool("search_files", { pattern: "haystackxyz" }, dir, {
        executor: new DirectExecutor(dir),
      });
      expect(miss.output).toBe("(no matches)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("executeTool load_skill", () => {
  it("returns an error when the skill does not exist", async () => {
    const r = await executeTool(
      "load_skill",
      { name: "definitely-not-a-real-skill-xyz" },
      process.cwd(),
      opts(),
    );
    expect(r.output).toBe("");
    expect(r.error).toBeDefined();
  });
});
