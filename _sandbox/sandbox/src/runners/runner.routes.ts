import { upgradeWebSocket } from "@hono/node-server";
import { type NeedsAction, RunnerHelloSchema, type RunnerSummary } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { Context } from "hono";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { emitDefinitionToml, parseDefinitionToml, settingsDefinition, settingsDrift } from "../portability/definition.js";
import type { RunnerClient } from "./runner-hub.js";
import { runnerParity } from "./runner-parity.js";

/* The parent-side doors of a runner (docs/remote-runners-plan.md, workspace root):
 *
 *   /system/runners/connect  the runner's own WebSocket, authenticated by its first frame (runner-protocol.ts
 *                            says why it is a frame and not a URL), then handed to the oRPC link.
 *   /system/runners/enroll   redeems its one-time pairing for the durable token — app.ts, beside the hosts'.
 *
 * The host connect route's shape, because the problem is the same: a socket arrives anonymous, has seconds to
 * say whose it is, and from the hello on every byte belongs to the typed link. */

// How long a freshly-opened socket may stay anonymous. It has exactly one job in that window.
const AUTH_DEADLINE_MS = 10_000;

export const createRunnerConnectRoute = (services: Services) =>
    upgradeWebSocket(() => {
        let detach: (() => void) | undefined;
        let deadline: NodeJS.Timeout | undefined;

        return {
            onOpen: (_event, ws) => {
                deadline = setTimeout(() => {
                    if (detach === undefined) {
                        ws.close(1008, "unauthorized");
                    }
                }, AUTH_DEADLINE_MS);
            },
            // The ONLY message this handler ever reads is the hello; a second one is a stray frame the link
            // rejects on its own (host.routes.ts's reasoning, unchanged).
            onMessage: async (event, ws) => {
                if (detach !== undefined) {
                    return;
                }
                const hello = RunnerHelloSchema.safeParse(JSON.parse(String(event.data ?? "")));
                if (!hello.success) {
                    services.logger.warn({ err: hello.error }, "runner: first frame was not a hello");
                    ws.close(1008, "unauthorized");
                    return;
                }
                const id = await services.runners.verify(hello.data.token);
                if (id === undefined) {
                    services.logger.warn("runner: rejected an unenrolled token");
                    ws.close(1008, "unauthorized");
                    return;
                }
                clearTimeout(deadline);
                // node-server hands the real socket on `.raw`, which carries the surface oRPC's link needs.
                const socket = ws.raw as unknown as WebSocket;
                const client: RunnerClient = createORPCClient(new RPCLink({ websocket: socket }));
                detach = services.runnerHub.attach(id, {
                    client,
                    close: (code, reason) => ws.close(code, reason),
                    parity: {
                        version: hello.data.version,
                        image: hello.data.image,
                        ...(hello.data.channel !== undefined ? { channel: hello.data.channel } : {}),
                        ...(hello.data.overlayHash !== undefined ? { overlayHash: hello.data.overlayHash } : {}),
                        ...(hello.data.definitionToml !== undefined ? { definitionToml: hello.data.definitionToml } : {}),
                    },
                });
                services.runnerHub.observe(id, await client.describe());
            },
            onClose: () => {
                clearTimeout(deadline);
                detach?.();
            },
            onError: (event) => {
                services.logger.warn({ event: String(event) }, "runner: socket error");
            },
        };
    });

/* Where one runner's environment stands against this sandbox's, one line per difference — the parity card's
 * content (docs/remote-runners-plan.md §7: surfaced, not enforced). Two halves with two remedies:
 *
 *   overlay  — the hash the run contract stamped on each container, compared directly. A differing line says
 *              so and names the fix (remove and re-add: `ic runner up` rebuilds from the parent's current
 *              approved overlay), because no live-link call can swap a running container's image.
 *   settings — the runner's declared settings (its hello's definitionToml) against this sandbox's, via the
 *              definition machinery, fixable in place through the sync door below.
 *
 * Total over a claim that does not parse: a runner from a stranger build costs its drift lines, never the list. */
const runnerDriftLines = (services: Services, id: string, parent: Awaited<ReturnType<typeof settingsDefinition>>, state: Pick<RunnerSummary, "image" | "overlayHash">): NeedsAction[] | undefined => {
    if (state.image === undefined) {
        // Never connected: there is nothing to compare, and an empty list would falsely read as "agrees".
        return undefined;
    }
    const lines: NeedsAction[] = [];
    const parentHash = services.config.sandbox.environmentHash;
    const runnerHash = state.overlayHash ?? "";
    if (parentHash !== runnerHash) {
        lines.push({
            subject: "Environment overlay",
            detail:
                runnerHash === ""
                    ? "This sandbox runs an environment overlay; the runner runs the bare image. Remove and re-add it to rebuild with the overlay."
                    : parentHash === ""
                      ? "The runner was built with an environment overlay this sandbox no longer runs. Remove and re-add it to rebuild bare."
                      : "The runner was built from a different overlay than this sandbox runs. Remove and re-add it to rebuild from the current one.",
        });
    }
    const toml = services.runnerHub.definitionToml(id);
    if (toml !== undefined) {
        try {
            lines.push(...settingsDrift(parent, parseDefinitionToml(toml)));
        } catch {
            lines.push({ subject: "Declared settings", detail: "The runner's declared settings could not be read; update the runner to a build both sides understand." });
        }
    }
    return lines;
};

// The owner's view: every enrolled runner, with whatever the hub knows about it right now. "Enrolled but
// never connected" must be distinguishable from "connected but asleep", the hosts view's rule.
export const runnerSummaries = async (services: Services): Promise<RunnerSummary[]> => {
    // What THIS sandbox is running, read once for the whole list: every row's parity is measured against it —
    // the one-word verdict (runner-parity.ts) and the itemized drift lines both, so the badge and its details
    // cannot disagree about the same runner.
    const parentBuild = {
        image: services.config.sandbox.image,
        channel: services.config.sandbox.channel,
        overlayHash: services.config.sandbox.environmentHash,
    };
    const parent = await settingsDefinition(services);
    return (await services.runners.list()).map((runner) => {
        const state = services.runnerHub.state(runner.id);
        const drift = runnerDriftLines(services, runner.id, parent, state);
        return Object.assign(
            { id: runner.id },
            runner.host !== undefined ? { host: runner.host } : {},
            state,
            { parity: runnerParity(parentBuild, state.image === undefined ? undefined : { image: state.image, channel: state.channel, overlayHash: state.overlayHash }) },
            drift !== undefined ? { drift } : {},
        );
    });
};

/* The owner's side of this sandbox's RUNNERS (docs/remote-runners-plan.md at the workspace root): the hosts
 * block retold for a container this sandbox provisions on another machine. Pairing is owner-minted and bound
 * to one runner id; enrollment is authorized by the pairing alone (the runner has no Google identity, only
 * the env `ic runner up` wrote); the socket authenticates in its first frame. */
export const createRunnerRoutes = (services: Services) => ({
    /** POST /system/runners/pair */
    pair: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const id = c.req.query("id") ?? "";
        if (id === "") {
            return c.json({ error: "name the runner: /system/runners/pair?id=<name>" }, 400);
        }
        return c.json(services.runners.mintPairing(id));
    },
    /** POST /system/runners/enroll */
    enroll: async (c: Context<AppEnv>): Promise<Response> => {
        const enrolled = await services.runners.enroll(c.req.header("x-intentic-pair") ?? "");
        if (enrolled === undefined) {
            return c.json({ error: "pairing expired or already used, mint a fresh one from the parent sandbox." }, 401);
        }
        return c.json(enrolled);
    },
    /** GET /system/runners */
    list: async (c: Context<AppEnv>): Promise<Response> => c.json({ runners: await runnerSummaries(services) }),
    /** DELETE /system/runners/:id */
    revoke: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const id = c.req.param("id") ?? "";
        services.runnerHub.disconnect(id, "this runner's access was revoked");
        return (await services.runners.revoke(id)) ? c.json({ ok: true }) : c.json({ error: "no such runner" }, 404);
    },
    /* POST /system/runners/:id/definition/sync. Push this sandbox's settings onto one runner, the fix for the
     * drift lines its summary carries: the settings-only definition travels down the runner's own live link
     * and REPLACES the runner's settings (the runner contract says why replace). Owner-only like every other
     * runner mutation, and refused rather than queued when the runner is offline — a deferred settings push
     * landing hours later, after the owner changed their mind again, is drift manufactured by the fix. */
    definitionSync: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const id = c.req.param("id") ?? "";
        const client = services.runnerHub.client(id);
        if (client === undefined) {
            return c.json({ error: "that runner is offline — wake its machine, then sync again." }, 409);
        }
        const toml = emitDefinitionToml(await settingsDefinition(services));
        const report = await client.applyDefinition({ toml });
        // The runner now runs exactly what was sent; adopting it here clears the drift without a reconnect.
        services.runnerHub.adoptDefinition(id, toml);
        return c.json(report);
    },
});
