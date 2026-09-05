import type { Context } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { CONTROL_SCOPES } from "./control-tokens.js";
import { ownerDenied } from "./owner-gates.js";

/* Control tokens, owner-minted (the sync-pair trust model, made durable + revocable), raw value returned
 * exactly once. What each scope reaches is auth/control-tokens.ts. Plain routes before the oRPC catch-all,
 * like the pair block.
 *
 * The scope is REQUIRED rather than defaulted: every default here is wrong for somebody, and a mint that
 * quietly picks the narrowest one produces a token that 403s on the caller's first real call, while a
 * mint that picks a generous one hands out more reach than was asked for. Making the caller say it is one
 * extra field and no ambiguity. */

export type ControlTokenRoutesDeps = Pick<Services, "auth" | "controlTokens">;

export const createControlTokenRoutes = (services: ControlTokenRoutesDeps) => ({
    /** POST /system/control/tokens */
    mint: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const body = (await c.req.json().catch(() => undefined)) as { label?: unknown; scope?: unknown } | undefined;
        const scope = CONTROL_SCOPES.find((candidate) => candidate === body?.scope);
        if (scope === undefined) {
            return c.json({ error: `scope must be one of: ${CONTROL_SCOPES.join(", ")}` }, 400);
        }
        const label = typeof body?.label === "string" && body.label.trim() !== "" ? body.label.trim().slice(0, 60) : scope;
        return c.json(await services.controlTokens.mint(label, scope));
    },
    /** GET /system/control/tokens */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ tokens: await services.controlTokens.list() });
    },
    /** DELETE /system/control/tokens/:id */
    revoke: async (c: Context<AppEnv, "/system/control/tokens/:id">): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        return (await services.controlTokens.revoke(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "no such token" }, 404);
    },
});
