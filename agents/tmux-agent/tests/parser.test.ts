import { describe, expect, it } from "vitest";

import { parseCaptureDelta } from "../src/parser.js";

describe("parseCaptureDelta", () => {
  it("extracts new codex-style output without echoing sent input", () => {
    const result = parseCaptureDelta({
      profile: "codex",
      previousCapture: [
        "codex",
        "",
        "Ready."
      ].join("\n"),
      currentCapture: [
        "codex",
        "",
        "Ready.",
        "write a changelog entry",
        "",
        "Updated the changelog and kept the entry concise."
      ].join("\n"),
      lastSentText: "write a changelog entry"
    });

    expect(result.emittedText).toBe("Updated the changelog and kept the entry concise.");
    expect(result.latestSummary).toContain("Updated the changelog");
  });

  it("detects approval prompts from pane output", () => {
    const result = parseCaptureDelta({
      profile: "codex",
      previousCapture: "",
      currentCapture: "Apply patch to workspace? [y/n]",
      lastSentText: ""
    });

    expect(result.promptHint).toEqual({
      eventType: "need_approval",
      body: "Apply patch to workspace? [y/n]"
    });
  });
});
