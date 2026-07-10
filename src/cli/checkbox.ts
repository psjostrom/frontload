import type { AgentName } from "../install/install.js";

export type AgentCheckboxChoice = {
  agent: AgentName;
  label: string;
  selected: boolean;
};

export type AgentCheckboxState = {
  choices: AgentCheckboxChoice[];
  focusedIndex: number;
};

const agentChoices: Array<{ agent: AgentName; label: string }> = [
  { agent: "codex", label: "Codex" },
  { agent: "claude", label: "Claude Code" },
  { agent: "opencode", label: "opencode" }
];

export function createAgentCheckboxState(detectedAgents: AgentName[]): AgentCheckboxState {
  const defaults = detectedAgents.length > 0 ? detectedAgents : agentChoices.map((choice) => choice.agent);
  return {
    choices: agentChoices.map((choice) => ({
      ...choice,
      selected: defaults.includes(choice.agent)
    })),
    focusedIndex: 0
  };
}

export function applyAgentCheckboxKey(state: AgentCheckboxState, keyName: string): AgentCheckboxState {
  if (keyName === "up" || keyName === "k") {
    return { ...state, focusedIndex: Math.max(0, state.focusedIndex - 1) };
  }
  if (keyName === "down" || keyName === "j") {
    return { ...state, focusedIndex: Math.min(state.choices.length - 1, state.focusedIndex + 1) };
  }
  if (keyName === "a") {
    return { ...state, choices: state.choices.map((choice) => ({ ...choice, selected: true })) };
  }
  if (keyName === "n") {
    return { ...state, choices: state.choices.map((choice) => ({ ...choice, selected: false })) };
  }
  if (keyName === "space" || keyName === " ") {
    return {
      ...state,
      choices: state.choices.map((choice, index) => index === state.focusedIndex
        ? { ...choice, selected: !choice.selected }
        : choice)
    };
  }
  return state;
}

export function selectedAgents(state: AgentCheckboxState): AgentName[] {
  return state.choices.filter((choice) => choice.selected).map((choice) => choice.agent);
}

export function formatAgentCheckboxPrompt(state: AgentCheckboxState): string {
  return [
    "Which agents should Frontload configure?",
    "Use Up/Down to move, Space to toggle, Enter to continue. Press a for all, n for none.",
    "",
    ...state.choices.map((choice, index) => {
      const cursor = index === state.focusedIndex ? ">" : " ";
      const checked = choice.selected ? "x" : " ";
      return `${cursor} [${checked}] ${choice.label}`;
    })
  ].join("\n");
}
