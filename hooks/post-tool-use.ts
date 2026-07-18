#!/usr/bin/env node
import { readStdin, runPostToolUseHook } from "../src/gate/entry.js";
import { agentIntegrationsPaused } from "../src/product/status.js";

async function main(): Promise<void> {
  if (agentIntegrationsPaused) {
    await readStdin();
    return;
  }
  const output = await runPostToolUseHook("claude");
  if (output) process.stdout.write(output);
}

void main();
