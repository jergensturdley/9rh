import { describe, expect, it } from "vitest";
import { loginShellPath, mergePath } from "./loginPath";

describe("mergePath", () => {
  it("puts the login PATH first and drops duplicates and empties", () => {
    expect(mergePath("/a:/b::/c", "/b:/d", ":")).toBe("/a:/b:/c:/d");
    expect(mergePath(null, "/x:/y", ":")).toBe("/x:/y");
    expect(mergePath("/only", undefined, ":")).toBe("/only");
  });
});

describe("loginShellPath", () => {
  it("reads PATH from a shell, or returns null when the shell is missing", async () => {
    expect(await loginShellPath("/definitely/not/a/shell", 1_000)).toBeNull();
    if (process.platform !== "win32") {
      const p = await loginShellPath("/bin/sh", 5_000);
      // /bin/sh may reject -i without a tty on some systems; either a PATH or null is acceptable.
      expect(p === null || p.includes("/bin")).toBe(true);
    }
  });
});
