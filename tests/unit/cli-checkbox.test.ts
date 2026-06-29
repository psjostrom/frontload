import { describe, expect, it } from "vitest";
import { applyAgentCheckboxKey, createAgentCheckboxState, formatAgentCheckboxPrompt, selectedAgents } from "../../src/cli/checkbox.js";

describe("agent checkbox prompt", () => {
  it("renders detected defaults as tick boxes", () => {
    const state = createAgentCheckboxState(["codex"]);

    expect(formatAgentCheckboxPrompt(state)).toContain("[x] Codex");
    expect(formatAgentCheckboxPrompt(state)).toContain("[ ] Claude Code");
    expect(selectedAgents(state)).toEqual(["codex"]);
  });

  it("toggles agents with space and keeps keyboard navigation in bounds", () => {
    let state = createAgentCheckboxState([]);
    state = applyAgentCheckboxKey(state, "down");
    state = applyAgentCheckboxKey(state, " ");
    state = applyAgentCheckboxKey(state, "down");

    expect(state.focusedIndex).toBe(1);
    expect(selectedAgents(state)).toEqual(["codex"]);
  });

  it("supports selecting all and none from the checkbox flow", () => {
    let state = createAgentCheckboxState(["codex"]);

    state = applyAgentCheckboxKey(state, "n");
    expect(selectedAgents(state)).toEqual([]);

    state = applyAgentCheckboxKey(state, "a");
    expect(selectedAgents(state)).toEqual(["codex", "claude"]);
  });
});
