import { publishRuntimeChange } from "../system/runtime-watch.js";
import type { PeerHubSpec } from "./peer.js";

/* THE LIVE HALF of a peer door: which peers are holding a socket right now, and the typed client for each.
 *
 * There is no request/response plumbing in here, and that is the point of the shape. The socket speaks the
 * door's contract over oRPC's websocket adapter, so correlating an answer to its question is the link's job.
 * What is left is what only this daemon can know: who is connected, what they last told us, and what to do
 * when they go away.
 *
 * Everything here is in memory, deliberately. "Online" is a fact about a socket, and a socket does not survive
 * a restart: after one, every peer reconnects on its own backoff and re-announces itself. Persisting liveness
 * would only let the UI claim a laptop is up when the daemon has no way to reach it. */

// What every peer's contract answers, whatever else it carries. Method-typed so an oRPC client's own
// `(input?, options?)` signatures satisfy it structurally, and optional where only some doors have the
// procedure: a runner has no MCP pipe and no owner-ticked grant.
export interface PeerClient<Facts, Scopes> {
    describe(input?: undefined, options?: { readonly signal?: AbortSignal }): Promise<Facts>;
    ping(input?: undefined, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
    mcp?(payload: unknown, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
    setScopes?(scopes: Scopes, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
}

// One peer as a card reads it: liveness from the socket, and what it last said about itself, kept after it
// goes offline so the card can say "last seen" and still name the machine instead of going blank the moment
// a lid closes. `announced` is what its hello carried; `facts` what it answered to `describe`.
export interface PeerState<Announced, Facts> {
    readonly online: boolean;
    readonly lastSeen?: number;
    readonly announced?: Announced;
    readonly facts?: Facts;
}

interface LivePeer<Client, Announced, Facts> {
    readonly client: Client;
    readonly close: (code: number, reason: string) => void;
    readonly heartbeat: NodeJS.Timeout;
    announced: Announced;
    facts: Facts | undefined;
    lastSeen: number;
}

export interface PeerHub<Client extends PeerClient<Facts, Scopes>, Announced, Facts, Scopes> {
    /* Take over as THE connection for this peer, closing any socket it left behind (a laptop waking from sleep
     * reconnects long before the old socket's keepalive gives up on it). Returns a detach function for the
     * socket's own close handler; calling it after a newer connection replaced this one does nothing, which
     * is what stops a stale socket from unregistering its own replacement. */
    readonly attach: (id: string, connection: { client: Client; close: (code: number, reason: string) => void; announced: Announced }) => () => void;
    // Replace what the peer announced about itself, for the one door that learns it mid-session (a runner
    // whose settings were just pushed down the link).
    readonly announce: (id: string, announced: Announced) => void;
    // What the peer answered to `describe`.
    readonly observe: (id: string, facts: Facts) => void;
    /* Re-ask a live peer to describe itself, within a budget, and keep the answer. For a card whose facts
     * change without this daemon being told (a browser's grants are revoked in Chrome's own settings): the
     * last answer stands when the peer is away or slow, so the card renders a stale list rather than nothing. */
    readonly refresh: (id: string, timeoutMs: number) => Promise<void>;
    // The typed client for a connected peer, or undefined when it is offline. Callers that need a REASON for
    // the absence use `mcp`, which throws one the model can read.
    readonly client: (id: string) => Client | undefined;
    /* One MCP message to a peer. Throws when it is offline, with the sentence the agent ends up reading.
     * `signal` is how a caller states its OWN deadline, and a caller serving a browser needs one: the door's
     * ceiling is sized for a tool call an agent made on purpose and will wait minutes for, which is the wrong
     * ceiling entirely for a read behind a page. */
    readonly mcp: (id: string, payload: unknown, options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
    // Push the grant. False ⇒ nobody to push to; the peer gets it on its next connect instead.
    readonly pushScopes: (id: string, scopes: Scopes) => Promise<boolean>;
    // Cut a peer off now: the owner revoking it, or the capability being removed.
    readonly disconnect: (id: string, reason: string) => void;
    /* The last tool list this peer answered with, remembered across disconnects. A turn loads its MCP servers
     * up front, so a peer that is away at that moment would otherwise fail the handshake and take its tools
     * out of the turn entirely; with the list cached the agent still SEES them and gets a readable "this
     * device is asleep" when it calls one. Undefined until the peer has connected once. */
    readonly rememberTools: (id: string, result: unknown) => void;
    readonly knownTools: (id: string) => unknown | undefined;
    readonly online: (id: string) => boolean;
    // Every peer holding a socket right now, for the invariant that holds each against the enrollment store.
    readonly connected: () => readonly string[];
    readonly state: (id: string) => PeerState<Announced, Facts>;
}

export const createPeerHub = <Client extends PeerClient<Facts, Scopes>, Announced, Facts, Scopes>(
    spec: PeerHubSpec,
    logger: { warn: (data: object, message: string) => void },
): PeerHub<Client, Announced, Facts, Scopes> => {
    const live = new Map<string, LivePeer<Client, Announced, Facts>>();
    const seen = new Map<string, { announced: Announced; facts: Facts | undefined; lastSeen: number }>();
    const tools = new Map<string, unknown>();

    /* SAY SO, on every transition of this hub's one fact. A card's state is `online(id)` and nothing else, so
     * the socket opening or closing IS the news, and the browser has no other way to hear it: there is no file
     * to watch and nothing for the runtime sampler to see. Coalesced and rate-limited downstream, and dropped
     * outright when nobody is connected, so a laptop flapping on a bad train wifi costs a set membership.
     * Deliberately NOT published from `refresh`, which a reader path drives: publishing from it would refetch
     * itself forever. */
    const said = (): void => publishRuntimeChange(spec.domain);

    const drop = (id: string, peer: LivePeer<Client, Announced, Facts>): void => {
        clearInterval(peer.heartbeat);
        seen.set(id, { announced: peer.announced, facts: peer.facts, lastSeen: Date.now() });
        live.delete(id);
        said();
    };

    return {
        attach: (id, connection) => {
            const previous = live.get(id);
            if (previous !== undefined) {
                clearInterval(previous.heartbeat);
                previous.close(1000, "replaced");
                live.delete(id);
            }
            const peer: LivePeer<Client, Announced, Facts> = {
                client: connection.client,
                close: connection.close,
                // A peer that stops answering is dropped rather than left looking online: the card's dot is
                // read as "the agent can work here right now", so it has to be a probe, not a memory.
                heartbeat: setInterval(() => {
                    void connection.client.ping().catch((err: unknown) => {
                        logger.warn({ err, id }, `${spec.domain}: heartbeat failed, dropping the connection`);
                        connection.close(1001, "no answer");
                        const current = live.get(id);
                        if (current?.client === connection.client) {
                            drop(id, current);
                        }
                    });
                }, spec.heartbeatMs),
                announced: connection.announced,
                facts: seen.get(id)?.facts,
                lastSeen: Date.now(),
            };
            live.set(id, peer);
            said();
            return () => {
                const current = live.get(id);
                if (current === peer) {
                    drop(id, peer);
                }
            };
        },
        announce: (id, announced) => {
            const peer = live.get(id);
            if (peer === undefined) {
                return;
            }
            peer.announced = announced;
            peer.lastSeen = Date.now();
            said();
        },
        observe: (id, facts) => {
            const peer = live.get(id);
            if (peer === undefined) {
                return;
            }
            peer.facts = facts;
            peer.lastSeen = Date.now();
            // Once, off the hello, which is what makes publishing from here safe (see `said` above).
            said();
        },
        refresh: async (id, timeoutMs) => {
            const peer = live.get(id);
            if (peer === undefined) {
                return;
            }
            // A failure here is not a failure of the card: the peer may have gone in the millisecond between
            // `live.get` and the call, and the last answer still describes it better than nothing does.
            const fresh = await peer.client.describe(undefined, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
            if (fresh !== undefined) {
                peer.facts = fresh;
                peer.lastSeen = Date.now();
            }
        },
        client: (id) => live.get(id)?.client,
        mcp: async (id, payload, options) => {
            const peer = live.get(id);
            if (peer === undefined || peer.client.mcp === undefined) {
                throw new Error(spec.offline(id));
            }
            peer.lastSeen = Date.now();
            return await peer.client.mcp(payload, { signal: options?.signal ?? AbortSignal.timeout(spec.callTimeoutMs) });
        },
        pushScopes: async (id, scopes) => {
            const peer = live.get(id);
            if (peer === undefined || peer.client.setScopes === undefined) {
                return false;
            }
            await peer.client.setScopes(scopes);
            return true;
        },
        rememberTools: (id, result) => void tools.set(id, result),
        knownTools: (id) => tools.get(id),
        disconnect: (id, reason) => {
            const peer = live.get(id);
            if (peer === undefined) {
                return;
            }
            clearInterval(peer.heartbeat);
            peer.close(1000, reason);
            seen.delete(id);
            live.delete(id);
            said();
        },
        online: (id) => live.has(id),
        connected: () => [...live.keys()],
        state: (id) => {
            const peer = live.get(id);
            const remembered = peer ?? seen.get(id);
            return {
                online: peer !== undefined,
                ...(remembered === undefined ? {} : { lastSeen: remembered.lastSeen, announced: remembered.announced }),
                ...(remembered?.facts !== undefined ? { facts: remembered.facts } : {}),
            };
        },
    };
};
