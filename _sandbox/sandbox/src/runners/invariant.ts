import type { InvariantCheck } from "../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: a runner is a peer door, and the one promise a door makes to itself — that every live socket
 * belongs to an id the enrollment store still holds — is checked once, over all three doors, by the substrate
 * they are instances of (peers/invariant.ts). What is left in this directory is the door's own words and the parent's turn dispatch, whose every record is the conversation's own (registry, transcript, journal), checked by the agent companions. */

export const owner = "runners";

export const checks = (): readonly InvariantCheck[] => [];
