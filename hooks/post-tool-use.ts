#!/usr/bin/env node
import { runPostToolUseHook } from "../src/gate/entry.js";

async function main(): Promise<void> {
  const output = await runPostToolUseHook("claude");
  if (output) process.stdout.write(output);
}

void main();
