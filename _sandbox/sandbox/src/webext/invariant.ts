import type { InvariantCheck } from "../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: a connected browser is a peer door, and the one promise a door makes to itself — that every live socket
 * belongs to an id the enrollment store still holds — is checked once, over all three doors, by the substrate
 * they are instances of (peers/invariant.ts). What is left in this directory is the door's own words, the seal on page text, and the two credential doors (session in, session lent out), each a single request that either lands in a profile or does not. */

export const owner = "webext";

export const checks = (): readonly InvariantCheck[] => [];
