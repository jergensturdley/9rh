import { describe, expect, it } from "vitest";
import { rendererChrome } from "./windowChrome";

describe("rendererChrome", () => {
  it("enables the custom drag strip only on macOS", () => {
    expect(rendererChrome("darwin")).toEqual({ appClassName: "app app-darwin", showDragStrip: true });
    expect(rendererChrome("win32")).toEqual({ appClassName: "app", showDragStrip: false });
    expect(rendererChrome("linux")).toEqual({ appClassName: "app", showDragStrip: false });
  });
});
