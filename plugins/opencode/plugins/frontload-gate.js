// Frontload gate plugin for opencode.
// Installed by `frontload init --agents opencode` to ~/.config/opencode/plugins/.
//
// Intercepts bash tool calls and applies Frontload budget policy:
//   - tool.execute.before: rewrites broad/read commands through Frontload, blocks noisy ones
//   - tool.execute.after: compacts oversized command output to the configured budget cap

export const FrontloadGate = async ({ directory }) => {
  const fs = require("fs");
  const path = require("path");
  const { execSync } = require("child_process");

  function resolveGateModule(modRelPath) {
    const candidates = [
      "frontload/dist/" + modRelPath,
      path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "frontload", "dist", modRelPath),
    ];
    for (const candidate of candidates) {
      try { return require.resolve(candidate); } catch {}
    }
    return null;
  }

  function findFrontloadRoot(start) {
    let current = path.resolve(start);
    while (true) {
      if (fs.existsSync(path.join(current, ".frontload"))) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  function loadConfig(root) {
    const file = path.join(root, "frontload.config.json");
    const defaults = { gate: { enabled: true }, budgets: { maxToolOutputChars: 8000 } };
    if (!fs.existsSync(file)) return defaults;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        gate: { ...defaults.gate, ...raw.gate },
        budgets: { ...defaults.budgets, ...raw.budgets },
      };
    } catch {
      return defaults;
    }
  }

  function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  const root = findFrontloadRoot(directory);
  if (!root) return {};

  const gatePath = resolveGateModule("src/gate/gate.js");
  if (!gatePath) return {};

  let gate;
  try { gate = require(gatePath); } catch { return {}; }
  const { evaluate, compactToolOutput } = gate;

  const config = loadConfig(root);
  if (!config.gate || !config.gate.enabled) return {};

  const cliJs = resolveGateModule("src/cli/index.js") ?? gatePath.replace("/src/gate/gate.js", "/src/cli/index.js");
  const nodeExe = shellQuote(process.execPath);
  const cli = shellQuote(cliJs);
  const gateOptions = {
    runnerCommand: `${nodeExe} ${cli} run --repo ${shellQuote(root)}`,
    searchCommand: `${nodeExe} ${cli} search --repo ${shellQuote(root)}`,
    readCommand: `${nodeExe} ${cli} read --repo ${shellQuote(root)}`,
  };

  const maxToolOutputChars = config.budgets?.maxToolOutputChars ?? 8000;

  return {
    "tool.execute.before": async (input, output) => {
      if (!output.args || typeof output.args !== "object") return;
      if (input.tool === "bash") {
        const command = typeof output.args.command === "string" ? output.args.command : "";
        if (!command.trim()) return;
        let decision;
        try {
          decision = evaluate({ tool_name: "Bash", tool_input: { command } }, config, gateOptions);
        } catch { return; }
        if (!decision) return;
        const h = decision.hookSpecificOutput;
        if (h.permissionDecision === "deny") {
          output.args.command = `echo "Frontload gate: ${h.permissionDecisionReason ?? "blocked"}"`;
        } else if (h.updatedInput && h.updatedInput.command) {
          output.args.command = h.updatedInput.command;
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return;
      if (typeof output.output !== "string") return;
      let compacted;
      try { compacted = compactToolOutput(output.output, maxToolOutputChars); } catch { return; }
      if (compacted.fitsBudget && compacted.truncated) {
        output.output = compacted.output;
      }
    },
  };
};