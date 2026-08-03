#!/usr/bin/env tsx
/**
 * Print every agent output-token budget, its env var, and whether it is
 * currently overridden.
 *
 * Triage tool for the "stale constant, silent degradation" class: when the
 * JobStore event log shows an agent hitting finishReason='length', the first
 * question is what that agent's cap actually is in THIS process — which is a
 * function of the compiled-in default, the floor, and whatever a unit file's
 * environment happens to set. Reading src/shared/agent-budgets.ts answers only
 * the first two.
 *
 * Read-only: no DB, no network, no writes.
 */

import { AGENT_BUDGETS, overriddenBudgets } from '../src/shared/agent-budgets.js';

function main(): void {
  const overridden = new Set(overriddenBudgets(process.env).map((b) => b.envVar));
  const rows = Object.values(AGENT_BUDGETS).map((b) => ({
    role: b.role,
    agent: b.agentName,
    value: b.value,
    default: b.fallback,
    floor: b.floor,
    env: b.envVar,
    overridden: overridden.has(b.envVar) ? 'YES' : '',
  }));
  console.table(rows);
  for (const b of Object.values(AGENT_BUDGETS)) {
    console.log(`\n${b.role} (${b.value}): ${b.why}\n  invalidated by: ${b.invalidatedBy}`);
  }
  if (overridden.size > 0) {
    console.log(
      `\n${overridden.size} budget(s) overridden by environment. An override outlives the ` +
        'reason for it — confirm the reason still holds.',
    );
  }
}

main();
