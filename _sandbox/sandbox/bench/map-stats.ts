#!/usr/bin/env node
/* WHAT THE PROJECT MAP DID, RECOMPUTED.
 *
 *   pnpm --filter @intentic/sandbox bench:map                        # against ~/.claude/projects
 *   pnpm --filter @intentic/sandbox bench:map /path/to/projects      # against a corpus you carried in
 *   pnpm --filter @intentic/sandbox bench:map --json                 # machine-readable, for a diff over time
 *   pnpm --filter @intentic/sandbox bench:map --root /work           # the tree the transcripts' paths use
 *
 * WHY THIS EXISTS. The map is argued for by a measurement (the workspace's own docs/agent-exploration-patterns.md) and was for a
 * long time defended by nothing: the two figures the ledger recorded, searches per turn and searches before the
 * first file, cannot see it, because the map does not change how MUCH a turn searches, it changes what the turn
 * reaches for. `settings.workspaceMapHoldout` answers that properly with two arms; this answers it today, off
 * the transcripts, and answers one thing the arms never will.
 *
 * THE TWO HALVES ARE DIFFERENT KINDS OF EVIDENCE, and the split is the point.
 *
 *   `opening` compares sessions that were sent a map against sessions that were not. It is observational: the
 *   two populations differ by more than the map (mostly by when they ran, and forks never carry one), so it
 *   suggests and the holdout settles.
 *
 *   `payload` needs no control group at all. An area line the note pays for on every conversation and no
 *   session ever enters is waste whatever anybody's behaviour is, and this is where a change to what the map
 *   derives from the codebase gets checked.
 *
 * READ THE CLAIMED LINE AS A DATE, NOT A TARGET. It is what the figures were when someone last looked, kept so
 * drift is visible at a glance; nothing fails when it moves. A figure that moved is an invitation to read
 * workspace-map.ts, not a verdict on it.
 *
 * The measuring lives in map-corpus.ts, which this only prints: that half is imported by its test, and a module
 * that scanned a corpus on import could not be. */

import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { DEFAULT_AGENT_ROOT, mapStats } from "./map-corpus.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const flag = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
};
const corpus = args.find((arg) => !arg.startsWith("--") && arg !== flag("root")) ?? join(homedir(), ".claude", "projects");

let stats: ReturnType<typeof mapStats>;
try {
    stats = mapStats(corpus, { agentRoot: flag("root") ?? DEFAULT_AGENT_ROOT });
} catch (error) {
    process.stderr.write(`cannot read a corpus at ${corpus}: ${errorMessage(error)}\n`);
    process.exit(1);
}

if (stats.corpus.sessions === 0) {
    process.stderr.write(`no sessions found under ${corpus}\n`);
    process.exit(1);
}

if (asJson) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    process.exit(0);
}

const { corpus: seen, opening, payload } = stats;
process.stdout.write(`corpus: ${seen.sessions} sessions, ${seen.mapped} with a map, ${seen.from} → ${seen.to}\n  from ${stats.root}\n`);

process.stdout.write(`\nopening turn  (observational: the holdout is what settles it)\n  ${opening.claimed}\n`);
const columns = ["openedWithListing", "searchesBeforeFirstFile", "searchesPerOpeningTurn", "callsBeforeTarget", "reached", "sessions"] as const;
for (const column of columns) {
    process.stdout.write(`  ${column.padEnd(24)}  mapped ${String(opening.mapped[column]).padEnd(10)}  unmapped ${opening.unmapped[column]}\n`);
}
for (const [arm, reading] of [
    ["mapped", opening.mapped],
    ["unmapped", opening.unmapped],
] as const) {
    const actions = Object.entries(reading.firstActions)
        .map(([name, count]) => `${name} ${count}`)
        .join(", ");
    process.stdout.write(`  first action, ${arm.padEnd(8)}  ${actions}\n`);
}

process.stdout.write(`\npayload  (no control group needed: a line nobody uses is waste either way)\n  ${payload.claimed}\n`);
for (const [key, value] of Object.entries(payload)) {
    if (key === "claimed" || key === "perArea" || key === "chars") {
        continue;
    }
    process.stdout.write(`  ${key.padEnd(28)}  ${String(value)}\n`);
}
process.stdout.write(`  ${"note size".padEnd(28)}  median ${payload.chars.median} chars, longest ${payload.chars.max}\n`);
process.stdout.write(`\n  area line                       listed   used\n`);
for (const area of payload.perArea) {
    process.stdout.write(`  ${area.area.padEnd(30)}  ${String(area.listed).padStart(6)}  ${String(area.used).padStart(5)}  (${area.share})\n`);
}
