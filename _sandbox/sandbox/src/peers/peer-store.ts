import type { z } from "zod";
import { enrollments, pairings } from "../store/enrollment.js";
import type { PeerStoreSpec } from "./peer.js";

/* THE CREDENTIAL HALF of a peer door: enrolled once, then presenting a durable per-peer token on every reconnect
 * (peer-hub.ts is the live half). The mechanic is store/enrollment.ts, which desktop sync shares too; what is
 * here is the binding of a pairing to ONE id, so a redeemed token can only ever become the peer the owner was
 * looking at when they clicked Connect. Nothing about a peer's identity is asserted by the peer.
 *
 * WHERE THIS LIVES IS THE POINT. On /history, not /work/.intentic: a host's token is a key to somebody's actual
 * laptop, a browser's to their signed-in sessions, a runner's to this sandbox's dispatch surface, and /work is
 * the one directory the agent reads and writes all day. The file sits where no tool the agent has can open it,
 * holds digests rather than tokens even there, and survives the `docker rm -f` of a rebuild, so an enrollment
 * keeps working instead of silently going dark until someone re-pairs. */

// What a pairing carries: which id it enrolls, and whatever this door records beside the digest.
type Pairing<Extra> = { readonly id: string } & Extra;

export interface PeerStore<Extra> {
    // Bind a pairing to one id. Single-use, expiring; the raw token is shown once, in the browser (or handed to
    // the provisioner that writes it into a container's env).
    readonly mintPairing: (id: string, extra?: Extra) => { token: string; expiresIn: number };
    /* Arm a pre-agreed pairing: a setup-time token the connect flow passes in the container's env, so the peer
     * that just installed this sandbox can enroll itself without anyone opening a browser. Answers false when
     * the token has already been spent, which is the ordinary case on every boot after the first; that burn is
     * the whole reason a seeded pairing is replayable, and store/enrollment.ts says why at length. */
    readonly seedPairing: (id: string, token: string, extra?: Extra) => Promise<boolean>;
    // Redeem a pairing: the peer gets its durable token, and the pairing is spent whether or not the peer
    // ever connects. Undefined ⇒ unknown, expired or replayed, which the route answers as 401.
    readonly enroll: (pairToken: string) => Promise<({ readonly id: string; readonly token: string } & Extra) | undefined>;
    // Which peer is presenting this token, or undefined. The only authorization on the WebSocket.
    readonly verify: (presented: string) => Promise<string | undefined>;
    readonly enrolled: (id: string) => Promise<boolean>;
    readonly list: () => Promise<Pairing<Extra>[]>;
    // Move an enrollment onto a new id, keeping the peer's key valid: a renamed device must not have to be
    // re-paired by hand at the far end.
    readonly rename: (from: string, to: string) => Promise<void>;
    // Drop a peer's enrollment; its next connect is refused and its live socket is closed by the caller.
    readonly revoke: (id: string) => Promise<boolean>;
}

export const filePeerStore = <Shape extends z.ZodRawShape>(
    historyRoot: string,
    spec: PeerStoreSpec<Shape>,
): PeerStore<z.infer<z.ZodObject<Shape>>> => {
    type Extra = z.infer<z.ZodObject<Shape>>;
    const files = spec.files(historyRoot);
    const pending = pairings<Pairing<Extra>>(files.consumed);
    const records = enrollments({ path: files.enrollments, key: spec.key, prefix: spec.prefix, extra: spec.extra });
    const replayable = spec.replayable === true;

    return {
        mintPairing: (id, extra) => pending.mint({ ...(extra as Extra), id }, { replayable }),
        seedPairing: (id, token, extra) => pending.arm(token, { ...(extra as Extra), id }),
        enroll: async (pairToken) => {
            const pairing = await pending.redeem(pairToken);
            if (pairing === undefined) {
                return undefined;
            }
            const { id, ...extra } = pairing;
            const token = await records.issue(id, extra as Extra);
            return { ...(extra as Extra), id, token };
        },
        verify: records.verify,
        enrolled: records.enrolled,
        list: records.list,
        rename: records.rename,
        revoke: records.revoke,
    };
};
