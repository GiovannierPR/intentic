import type { Context } from "hono";
import type { Services } from "../composition.js";
import { authorizeMaintainer, bearerFrom, ForbiddenError } from "./auth.js";

/* The two answers a privileged plain-Hono route asks for before it does anything, as a Response to return
 * when the caller is refused and undefined when they may proceed. Loopback mode (no services.auth) admits
 * everyone, like every other route.
 *
 * `ownerDenied` is the operating gate used by privileged sandbox controls. Maintainer is deliberately
 * owner-equivalent here; ownership itself is kept separate (`ownershipDenied`) for the one thing a revokable
 * grant cannot control: membership. */
export const ownerDenied = async (services: Pick<Services, "auth">, c: Context): Promise<Response | undefined> => {
    if (services.auth === undefined) {
        return undefined;
    }
    try {
        await authorizeMaintainer(services.auth, bearerFrom(c.req.header("authorization")));
        return undefined;
    } catch (error) {
        return error instanceof ForbiddenError ? c.json({ error: error.message }, 403) : c.json({ error: "unauthorized" }, 401);
    }
};

export const ownershipDenied = async (services: Pick<Services, "auth">, c: Context): Promise<Response | undefined> => {
    if (services.auth === undefined) {
        return undefined;
    }
    try {
        await services.auth.authorizeOwner(bearerFrom(c.req.header("authorization")));
        return undefined;
    } catch (error) {
        return error instanceof ForbiddenError ? c.json({ error: error.message }, 403) : c.json({ error: "unauthorized" }, 401);
    }
};
