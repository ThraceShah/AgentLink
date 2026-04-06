import { describe, expect, it } from "vitest";

import { buildTmuxKeySendSpec } from "../src/tmux-keys.js";

describe("tmux key mapping", () => {
  it("maps literal single keys without implicit enter", () => {
    expect(buildTmuxKeySendSpec({ key: "c" })).toEqual({
      mode: "literal",
      value: "c"
    });
  });

  it("maps control combinations to tmux key notation", () => {
    expect(buildTmuxKeySendSpec({ key: "c", modifiers: ["ctrl"] })).toEqual({
      mode: "key",
      value: "C-c"
    });
  });

  it("maps named cursor keys", () => {
    expect(buildTmuxKeySendSpec({ key: "up" })).toEqual({
      mode: "key",
      value: "Up"
    });
  });

  it("rejects unknown key names", () => {
    expect(() => buildTmuxKeySendSpec({ key: "banana" })).toThrow("unsupported send_key target");
  });
});
