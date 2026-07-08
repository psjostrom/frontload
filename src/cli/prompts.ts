import { parseConfigScope, type ConfigScope } from "../install/install.js";

export type ConfigScopeRadioChoice = {
  scope: ConfigScope;
  label: string;
};

export type ConfigScopeRadioState = {
  choices: ConfigScopeRadioChoice[];
  focusedIndex: number;
};

const configScopeChoices: ConfigScopeRadioChoice[] = [
  { scope: "project", label: "Project" },
  { scope: "global", label: "Global" }
];

export function createConfigScopeRadioState(defaultScope: ConfigScope = "project"): ConfigScopeRadioState {
  parseConfigScope(defaultScope);
  const focusedIndex = Math.max(0, configScopeChoices.findIndex((choice) => choice.scope === defaultScope));
  return {
    choices: configScopeChoices,
    focusedIndex
  };
}

export function applyConfigScopeRadioKey(state: ConfigScopeRadioState, keyName: string): ConfigScopeRadioState {
  if (keyName === "up" || keyName === "k") {
    return { ...state, focusedIndex: Math.max(0, state.focusedIndex - 1) };
  }
  if (keyName === "down" || keyName === "j") {
    return { ...state, focusedIndex: Math.min(state.choices.length - 1, state.focusedIndex + 1) };
  }
  if (keyName === "space" || keyName === " ") {
    return state;
  }
  return state;
}

export function selectedConfigScope(state: ConfigScopeRadioState): ConfigScope {
  return state.choices[state.focusedIndex]?.scope ?? "project";
}

export function formatConfigScopeRadioPrompt(state: ConfigScopeRadioState): string {
  return [
    "Choose Claude Code MCP config scope.",
    "Use Up/Down to move, Enter to continue.",
    "",
    ...state.choices.map((choice, index) => {
      const cursor = index === state.focusedIndex ? ">" : " ";
      const checked = index === state.focusedIndex ? "o" : " ";
      return `${cursor} (${checked}) ${choice.label}`;
    })
  ].join("\n");
}
