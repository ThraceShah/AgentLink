import { describe, expect, it } from "vitest";

import {
  parseCodexModel,
  parseCopilotModel,
  parseOpenCodeModel,
  parseQwenModel
} from "../src/model-resolver.js";

describe("model resolver parsers", () => {
  it("parses opencode model from config", () => {
    expect(parseOpenCodeModel(JSON.stringify({
      agent: {
        model: "gpt-5.4-mini"
      }
    }))).toBe("gpt-5.4-mini");
  });

  it("parses codex model from config", () => {
    expect(parseCodexModel('model = "gpt-5.4"\n')).toBe("gpt-5.4");
  });

  it("parses qwen model from settings", () => {
    expect(parseQwenModel(JSON.stringify({
      model: {
        name: "glm-5"
      }
    }))).toBe("glm-5");
  });

  it("parses the newest copilot model from events", () => {
    const content = [
      JSON.stringify({
        type: "session.tools_updated",
        timestamp: "2026-04-03T10:00:00.000Z",
        data: {
          model: "gpt-5.4"
        }
      }),
      JSON.stringify({
        type: "session.model_change",
        timestamp: "2026-04-03T10:05:00.000Z",
        data: {
          newModel: "claude-sonnet-4.6"
        }
      })
    ].join("\n");

    expect(parseCopilotModel(content)).toEqual({
      model: "claude-sonnet-4.6",
      timestamp: "2026-04-03T10:05:00.000Z"
    });
  });
});
