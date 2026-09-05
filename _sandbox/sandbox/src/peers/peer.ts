import type { RuntimeDomain } from "@intentic/sandbox-contract";
import type { z } from "zod";

/* A PEER is something of the user's that DIALS this sandbox and then serves a contract back over the socket it
 * opened: their computer (hosts/), their browser (webext/), one of this sandbox's own runners (runners/). The
 * three were written one after another, each "the previous one's shape retold", and by the third the retelling
 * was a hub, a connect route, an MCP bridge, four owner routes, a store and an invariant that differed in a
 * noun, two timeouts and one per-kind hook. This directory is that shape written once; a door is the data that
 * varies, declared beside the code that is genuinely its own.
 *
 * WHAT A DOOR DECLARES, and nothing more:
 *   slug       the path segment every route sits under (/system/<slug>/…, /mcp/<slug>/<id>) — also what the
 *              far end dials, so it never changes casually.
 *   noun       the word every sentence uses for the thing on the other end.
 *   domain     the runtime-change domain its liveness is announced on (the card's dot is exactly this).
 *   store      where the enrollment digests live on /history and what rides beside them.
 *   hub        the heartbeat, the tool-call ceiling and the sentence an offline peer answers with.
 *   hello      the first frame's schema and what of it is worth remembering.
 *   scopesKind the capability kind whose config IS the grant pushed down on connect; absent for a peer with no
 *              owner-ticked grant (a runner's parent is its whole authority).
 *   mcp        present when the agent reaches this peer through the loopback MCP bridge, with the one hook
 *              each kind adds to the pipe: a judgement before the call goes out, a seal on what comes back. */
export type PeerSlug = "hosts" | "webext" | "runners";

export interface PeerStoreSpec<Shape extends z.ZodRawShape> {
    /* The two files on /history: the enrollment digests, and the pairings already redeemed (which records that
     * something was spent and must hold nothing that could spend anything). Each door joins its two literal
     * names onto the history root itself rather than deriving them from a stem here, because the history-state
     * manifest (the contract's HISTORY_STATE_FILES) is guarded by reading exactly that expression out of the
     * source. */
    readonly files: (historyRoot: string) => { readonly enrollments: string; readonly consumed: string };
    // The top-level key inside the enrollments file.
    readonly key: string;
    // What the durable token looks like, so a credential in a log says which door it opens.
    readonly prefix: string;
    // What an enrollment records beside its digest (runners: which computer holds the container).
    readonly extra: Shape;
    /* Whether EVERY pairing this door mints ends up somewhere immortal (a container's env, replayed into every
     * rebuild) and must be burned on redemption. Hosts mint ephemeral pairings in the browser and arm immortal
     * ones from the env, so theirs decide per pairing; a runner's is always written into a container. */
    readonly replayable?: boolean;
}

export interface PeerHubSpec {
    readonly domain: RuntimeDomain;
    readonly heartbeatMs: number;
    // The ceiling on one forwarded tool call, far above any tool's own timeout: it only ever catches a socket
    // that is gone but not closed, which the heartbeat is the primary defence against.
    readonly callTimeoutMs: number;
    // What the model reads when it calls a peer that is not holding a socket. An asleep laptop and a shut
    // browser are normal states, not faults, and the sentence says which.
    readonly offline: (id: string) => string;
}

export interface PeerMcpSpec {
    // The `serverInfo.name` the daemon answers the handshake with while the peer is away.
    readonly serverName: (id: string) => string;
}

export interface PeerDoor<Hello extends { readonly token: string }, Announced, Shape extends z.ZodRawShape> {
    readonly slug: PeerSlug;
    readonly noun: string;
    // The key the roster answers under: `{ hosts: [...] }`, `{ browsers: [...] }`, `{ runners: [...] }`.
    readonly listKey: string;
    readonly store: PeerStoreSpec<Shape>;
    readonly hub: PeerHubSpec;
    readonly hello: {
        readonly schema: z.ZodType<Hello>;
        // What of the hello is kept beside the socket: a build number, or a runner's whole parity claim.
        readonly announced: (hello: Hello) => Announced;
    };
    readonly scopesKind?: "host" | "webext";
    readonly mcp?: PeerMcpSpec;
    // The sentence a spent or unknown pairing is refused with, naming where a fresh one comes from.
    readonly expired: string;
}

/* THE DOORS THE AGENT REACHES THROUGH THE MCP BRIDGE, by the capability kind that names each: the slug its
 * bridge is served under. Here rather than only on each door because the turn planner builds the agent's tool
 * list from the kind alone, and must not import a door's own code to learn where its bridge is. A door's spec
 * reads its slug from this table, so the two cannot disagree. */
export const PEER_BRIDGES = { host: "hosts", webext: "webext" } as const satisfies Record<"host" | "webext", PeerSlug>;

// The two doors an anonymous caller may reach on every peer: the socket, and the one-time redemption.
export const peerConnectPath = (slug: PeerSlug): string => `/system/${slug}/connect`;
export const peerEnrollPath = (slug: PeerSlug): string => `/system/${slug}/enroll`;
export const peerMcpPath = (slug: PeerSlug): RegExp => new RegExp(`^/mcp/${slug}/[^/]+$`);
