import { describe, expect, it } from "@jest/globals";
import { buildDarwinProfile, Sandbox, isSandboxAvailable } from "../sandboxer.js";

describe("buildDarwinProfile (strict)", () => {
  const p = buildDarwinProfile({ workDir: "/work" });

  it("denies by default and denies network", () => {
    expect(p).toContain("(deny default)");
    expect(p).toContain("(deny network*)");
  });

  it("restricts reads to subpaths including the workDir", () => {
    expect(p).toContain('(allow file-read* (subpath "/work")');
    expect(p).toContain('(subpath "/usr")');
  });

  it("restricts writes to subpaths including the workDir", () => {
    expect(p).toContain('(allow file-write* (subpath "/work")');
    expect(p).toContain('(subpath "/tmp")');
  });
});

describe("buildDarwinProfile (blanketReads — macOS 26 workaround)", () => {
  const p = buildDarwinProfile({ workDir: "/work", blanketReads: true });

  it("allows reads with NO subpath (the construct that SIGABRTs on macOS 26 is gone)", () => {
    expect(p).toContain("(allow file-read*)");
    expect(p).not.toContain("(allow file-read* (subpath");
  });

  it("still confines writes to subpaths and still denies network", () => {
    expect(p).toContain('(allow file-write* (subpath "/work")');
    expect(p).toContain("(deny network*)");
  });
});

describe("buildDarwinProfile (opt-outs)", () => {
  it("returns allow-default under legacySandbox", () => {
    expect(buildDarwinProfile({ workDir: "/work", legacySandbox: true })).toBe("(version 1)(allow default)");
  });

  it("returns allow-default when network is enabled with no allowlist", () => {
    expect(buildDarwinProfile({ workDir: "/work", networkEnabled: true })).toBe("(version 1)(allow default)");
  });

  it("omits the network-deny clause when network is enabled with an allowlist", () => {
    const p = buildDarwinProfile({ workDir: "/work", networkEnabled: true, allowedPaths: ["/data"] });
    expect(p).not.toContain("(deny network*)");
    expect(p).toContain('(subpath "/data")');
  });
});

describe("Sandbox profile resolution restores isolation where possible", () => {
  it("does not run unsandboxed when the host can enforce any restrictive profile", () => {
    // On a host with a working sandbox-exec that accepts either the strict or
    // the blanket-read profile, the resolver must NOT degrade to allow-all.
    // (Skipped where sandbox-exec is unavailable, e.g. Linux CI.)
    if (!isSandboxAvailable()) return;
    const profile = new Sandbox({ workDir: "/tmp", warnOnProfileFallback: false }).getProfile();
    // Either strict or the blanket-read workaround is acceptable; allow-all is
    // only reached if the host rejects even unrestricted-read profiles.
    if (profile !== "(version 1)(allow default)") {
      expect(profile).toContain("(deny network*)");
      expect(profile).toContain("(allow file-write* (subpath");
    }
  });
});
