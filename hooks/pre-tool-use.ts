#!/usr/bin/env node
import { runPreToolUseHook } from "../src/gate/entry.js";

async function main(): Promise<void> {
  const output = await runPreToolUseHook();
  if (output) process.stdout.write(output);
}

void main();
