import type { InvariantCheck } from "../invariants/invariants.js";
import type { PeerHub } from "./peer-hub.js";
import type { PeerStore } from "./peer-store.js";

/* A SOCKET THE STORE NO LONGER VOUCHES FOR IS A PEER THE OWNER DISCONNECTED THAT THE AGENT CAN STILL DRIVE.
 *
 * A peer is two records: the enrollment on /history (the durable half) and the live socket in memory (the half
 * that dispatches). The store checks the token exactly once, when the socket connects; from then on the hub's
 * map IS the authority, and every tool call, dispatched turn and credential handed down the socket goes to
 * whatever id is in it. Revocation is therefore two calls that nothing ties together: the store forgets the
 * id, and "its live socket is closed by the caller", in the store's own words. A caller that makes the first
 * and not the second (or makes it before the attach that races it) leaves a peer the owner removed, or
 * renamed, reachable under a name the store has no record of — until its next reconnect is refused, which for
 * a machine that never sleeps is never, and for a browser is until the person quits it. */

type Roster = Pick<PeerStore<unknown>, "list">;
type Sockets = Pick<PeerHub<never, unknown, unknown, unknown>, "connected">;

export interface PeerRegistryDeps {
    readonly hosts: Roster;
    readonly hostHub: Sockets;
    readonly webexts: Roster;
    readonly webextHub: Sockets;
    readonly runners: Roster;
    readonly runnerHub: Sockets;
}

export const owner = "peers";

// One check per door, over the same rule: every live socket is one the store still holds.
const registryCheck = (name: string, store: Roster, hub: Sockets, stakes: string): InvariantCheck => ({
    name,
    // Not `boot`: the hub is empty then by construction, a socket does not survive a restart.
    on: ["sweep"],
    run: async ({ fail }) => {
        const connected = hub.connected();
        if (connected.length === 0) {
            return;
        }
        const enrolled = new Set((await store.list()).map((peer) => peer.id));
        const strays = connected.filter((id) => !enrolled.has(id));
        if (strays.length > 0) {
            fail(`${strays.length} socket(s) are live for ids the enrollment store does not hold (${strays.join(", ")}): ${stakes}`);
        }
    },
});

export const checks = (deps: PeerRegistryDeps): readonly InvariantCheck[] => [
    registryCheck("live-hosts-are-enrolled", deps.hosts, deps.hostHub, "a device the owner disconnected that the agent can still drive"),
    registryCheck("live-browsers-are-enrolled", deps.webexts, deps.webextHub, "a browser the owner disconnected that the agent can still drive"),
    registryCheck("live-runners-are-enrolled", deps.runners, deps.runnerHub, "a revoked runner still receiving this sandbox's turns and credentials"),
];
