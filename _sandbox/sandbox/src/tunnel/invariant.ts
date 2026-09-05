import type { InvariantCheck } from "../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: this directory is the substrate two tunnel kinds are instances of, and it holds no state of its own
 * to be wrong about. Everything checkable is read off the machine by each kind's own probe (the up marker here
 * is advisory by design), and the one promise a tunnel makes to the sandbox — an exit never writes the main
 * routing table, a stale observation never outlives its tunnel — is checked where it is made, exit/invariant.ts. */

export const owner = "tunnel";

export const checks = (): readonly InvariantCheck[] => [];
