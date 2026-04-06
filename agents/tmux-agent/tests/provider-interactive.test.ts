import { describe, expect, it } from "vitest";

import { parseInteractiveCapture } from "../src/provider-interactive.js";

describe("provider interactive capture parser", () => {
  it("parses qwen model dialog", () => {
    const result = parseInteractiveCapture("qwen", [
      "  > /model",
      "  ╭──────────────────────────────────────────────╮",
      "  │ Select Model                                 │",
      "  │   1. [qwen-oauth] coder-model                │",
      "  │ › 2. [openai] glm-5                          │",
      "  │   3. [openai] kimi-k2.5                      │",
      "  │ Enter to select, ↑↓ to navigate, Esc to close│",
      "  ╰──────────────────────────────────────────────╯"
    ].join("\n"));

    expect(result.menuTitle).toBe("Select Model");
    expect(result.menuItems?.map((item) => item.label)).toEqual([
      "[qwen-oauth] coder-model",
      "[openai] glm-5",
      "[openai] kimi-k2.5"
    ]);
    expect(result.menuItems?.[1]?.isSelected).toBe(true);
    expect(result.readyForInput).toBe(false);
  });

  it("parses qwen final text after prompt completes", () => {
    const result = parseInteractiveCapture("qwen", [
      "  > Say hi in one short sentence.",
      "",
      "  ✦ The user wants me to say hi in one short sentence. Simple enough.",
      "",
      "  ✦ Hi there! How can I help you today?",
      "",
      "────────────────────────────────────────────────────────────────────────────────",
      "*   Type your message or @path/to/file",
      "────────────────────────────────────────────────────────────────────────────────",
      "  YOLO mode (shift + tab to cycle)                                   7.6% used"
    ].join("\n"));

    expect(result.busy).toBe(false);
    expect(result.finalText).toBe("Hi there! How can I help you today?");
    expect(result.readyForInput).toBe(true);
  });

  it("parses qwen boxed status dialogs as text dialogs", () => {
    const result = parseInteractiveCapture("qwen", [
      "  > /status",
      "  ╭──────────────────────────────────────────────────────────────────────────╮",
      "  │                                                                          │",
      "  │ Status                                                                   │",
      "  │                                                                          │",
      "  │ Qwen Code                0.13.2 (1b1a029fd)                              │",
      "  │ Runtime                  Node.js v25.8.2 / npm 11.12.1                   │",
      "  │ OS                       linux x64 (6.18.20-1-lts)                       │",
      "  │                                                                          │",
      "  │ Auth                     Alibaba Cloud Coding Plan                       │",
      "  │ Model                    glm-5                                           │",
      "  │                                                                          │",
      "  ╰──────────────────────────────────────────────────────────────────────────╯",
      "",
      "────────────────────────────────────────────────────────────────────────────────",
      "*   Type your message or @path/to/file"
    ].join("\n"));

    expect(result.dialog).toEqual({
      id: "status",
      title: "Status",
      body: [
        "Qwen Code                0.13.2 (1b1a029fd)",
        "Runtime                  Node.js v25.8.2 / npm 11.12.1",
        "OS                       linux x64 (6.18.20-1-lts)",
        "",
        "Auth                     Alibaba Cloud Coding Plan",
        "Model                    glm-5"
      ].join("\n"),
      actions: [
        {
          id: "__cancel__",
          label: "Cancel"
        }
      ]
    });
    expect(result.finalText).toBeUndefined();
    expect(result.readyForInput).toBe(true);
  });

  it("parses copilot model picker", () => {
    const result = parseInteractiveCapture("copilot", [
      "Select Model",
      "Choose the AI model to use for Copilot CLI.",
      "[Available]  Upgrade",
      "Search models...",
      "❯ GPT-5.4 (default) ✓        1x",
      "  GPT-5.3-Codex              1x",
      "↑↓ to navigate · Tab switch tab · Enter to select · Esc to cancel"
    ].join("\n"));

    expect(result.menuTitle).toBe("Select Model");
    expect(result.menuItems?.map((item) => item.label)).toEqual([
      "GPT-5.4 (default)",
      "GPT-5.3-Codex"
    ]);
    expect(result.menuItems?.[0]?.isSelected).toBe(true);
    expect(result.keyHints).toEqual(expect.arrayContaining(["up", "down", "tab", "enter", "esc"]));
  });

  it("parses copilot text commands that return to the prompt", () => {
    const result = parseInteractiveCapture("copilot", [
      "✗ Compaction Failed: Error: Nothing to compact.",
      "",
      "~/code/project_iris [⎇ opencode/tui]                          GPT-5.4 (medium)",
      "────────────────────────────────────────────────────────────────────────────────",
      "❯  Type @ to mention files, # for issues/PRs, / for commands, or ? for",
      "────────────────────────────────────────────────────────────────────────────────",
      " shift+tab switch mode"
    ].join("\n"));

    expect(result.finalText).toBe("Compaction Failed: Error: Nothing to compact.");
    expect(result.readyForInput).toBe(true);
  });

  it("parses copilot session dialog", () => {
    const result = parseInteractiveCapture("copilot", [
      "╭────────────────────────────────────────────────────────╮",
      "│ Sessions                                               │",
      "│ ❯ ● Session 1 (active)                                 │",
      "│ ↑↓ Navigate · Enter Switch · n New · i Info · Esc Close│",
      "╰────────────────────────────────────────────────────────╯"
    ].join("\n"));

    expect(result.menuTitle).toBe("Sessions");
    expect(result.menuItems?.[0]).toEqual({
      id: "item_0",
      label: "● Session 1 (active)",
      description: undefined,
      isSelected: true
    });
  });

  it("parses codex interactive model menu when available", () => {
    const result = parseInteractiveCapture("codex", [
      "Select Model and Effort",
      "1. gpt-5.4 (default)",
      "› 2. gpt-5.4-mini (current)",
      "3. gpt-5.3-codex",
      "Press enter to select reasoning effort, or esc to dismiss."
    ].join("\n"));

    expect(result.menuTitle).toBe("Select Model and Effort");
    expect(result.menuItems?.map((item) => item.label)).toEqual([
      "gpt-5.4 (default)",
      "gpt-5.4-mini (current)",
      "gpt-5.3-codex"
    ]);
    expect(result.menuItems?.[1]?.isSelected).toBe(true);
  });
});
