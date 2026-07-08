import { describe, expect, it } from "vitest";
import { applyConfigScopeRadioKey, createConfigScopeRadioState, formatConfigScopeRadioPrompt, selectedConfigScope } from "../../src/cli/prompts.js";

describe("CLI prompts", () => {
  it("renders Claude config scope as a single-choice radio prompt", () => {
    const state = createConfigScopeRadioState();

    expect(formatConfigScopeRadioPrompt(state)).toContain("(o) Project");
    expect(formatConfigScopeRadioPrompt(state)).toContain("( ) Global");
    expect(selectedConfigScope(state)).toBe("project");
  });

  it("moves the selected config scope with arrow keys", () => {
    let state = createConfigScopeRadioState();

    state = applyConfigScopeRadioKey(state, "down");
    expect(selectedConfigScope(state)).toBe("global");

    state = applyConfigScopeRadioKey(state, "up");
    expect(selectedConfigScope(state)).toBe("project");
  });
});
