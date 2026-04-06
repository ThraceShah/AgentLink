import { describe, expect, it } from "vitest";

import {
  parseOpenCodeExport,
  parseOpenCodeInteractiveCapture,
  parseOpenCodeSessionList
} from "../src/opencode-interactive.js";

describe("opencode interactive helpers", () => {
  it("parses busy capture with model and usage", () => {
    const result = parseOpenCodeInteractiveCapture([
      "  ┃  Build  Qwen3.6 Plus Free OpenCode Zen",
      "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
      "   ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt                         tab agents  ctrl+p commands",
      "     ▣  Build · qwen3.6-plus-free",
      "                                                   13.2K (1%)  ctrl+p commands"
    ].join("\n"));

    expect(result.busy).toBe(true);
    expect(result.model).toBe("qwen3.6-plus-free");
    expect(result.contextUsedTokens).toBe(13_200);
    expect(result.contextWindowTokens).toBe(1_320_000);
  });

  it("parses modal prompt body from capture", () => {
    const result = parseOpenCodeInteractiveCapture([
      "              Select model                                     esc",
      "",
      "              Search",
      "",
      "   ┃          Big Pickle                                      Free",
      "   ┃          MiniMax M2.5 Free                               Free",
      "   ┃          Nemotron 3 Super Free                           Free",
      "   ┃       ● Qwen3.6 Plus Free                               Free",
      "",
      "              View all providers ctrl+a"
    ].join("\n"));

    expect(result.busy).toBe(false);
    expect(result.promptBody).toContain("Select model");
    expect(result.promptBody).toContain("Big Pickle");
    expect(result.keyHints).toContain("esc");
  });

  it("detects follow-up variant menus after model selection", () => {
    const result = parseOpenCodeInteractiveCapture([
      "              Select variant                                   esc",
      "",
      "              Search",
      "",
      "   ┃          Default",
      "   ┃  Ask     high",
      "   ┃          max",
      "",
      "                                                   tab agents  ctrl+p commands"
    ].join("\n"));

    expect(result.busy).toBe(false);
    expect(result.menuId).toBe("variant");
    expect(result.menuTitle).toBe("Select variant");
    expect(result.menuItems?.map((item) => item.label)).toEqual(["Default", "high", "max"]);
  });

  it("detects idle prompt after interactive menu selection completes", () => {
    const result = parseOpenCodeInteractiveCapture([
      "                     █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█",
      "   ┃",
      "   ┃  Ask anything... \"Fix a TODO in the codebase\"",
      "   ┃",
      "   ┃  Build  Big Pickle OpenCode Zen",
      "   ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
      "                                                   tab agents  ctrl+p commands"
    ].join("\n"));

    expect(result.busy).toBe(false);
    expect(result.readyForInput).toBe(true);
    expect(result.menuItems).toBeUndefined();
  });

  it("extracts control key hints from footer actions", () => {
    const result = parseOpenCodeInteractiveCapture([
      "Select model",
      "Qwen3.6 Plus Free",
      "esc close",
      "tab agents",
      "ctrl+p commands"
    ].join("\n"));

    expect(result.keyHints).toEqual(expect.arrayContaining(["esc", "tab", "p"]));
  });

  it("parses session ids from session list output", () => {
    const result = parseOpenCodeSessionList([
      "Session ID                      Title                                    Updated",
      "────────────────────────────────────────────────────────────────────────────────",
      "ses_abc  Conversation one  9:21 PM",
      "ses_def  Conversation two  9:19 PM"
    ].join("\n"));

    expect(result).toEqual(["ses_abc", "ses_def"]);
  });

  it("parses final text and usage from exported session json", () => {
    const result = parseOpenCodeExport([
      "Exporting session: ses_abc",
      JSON.stringify({
        info: {
          id: "ses_abc",
          directory: "/tmp/project"
        },
        messages: [
          {
            info: {
              role: "user",
              model: {
                modelID: "qwen3.6-plus-free"
              }
            },
            parts: [
              {
                type: "text",
                text: "say hi"
              }
            ]
          },
          {
            info: {
              role: "assistant",
              modelID: "qwen3.6-plus-free",
              tokens: {
                input: 120,
                output: 20,
                reasoning: 10
              }
            },
            parts: [
              {
                type: "reasoning",
                text: "thinking"
              },
              {
                type: "text",
                text: "hi"
              }
            ]
          }
        ]
      })
    ].join("\n"));

    expect(result?.sessionId).toBe("ses_abc");
    expect(result?.directory).toBe("/tmp/project");
    expect(result?.latestUserText).toBe("say hi");
    expect(result?.finalText).toBe("hi");
    expect(result?.model).toBe("qwen3.6-plus-free");
    expect(result?.inputTokens).toBe(120);
    expect(result?.totalTokens).toBe(150);
    expect(result?.contextUsedTokens).toBe(120);
  });
});
