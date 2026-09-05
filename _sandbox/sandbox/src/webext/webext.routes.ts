import { WebExtSessionExportSchema, WebExtSessionImportSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { bearerFrom } from "../auth/auth.js";
import type { Services } from "../composition.js";
import { exportBrowserSession } from "./session-export.js";
import { importBrowserSession } from "./session-import.js";

/* THE TWO CREDENTIAL DOORS of a connected browser, beside its peer door (webext-peer.ts):
 *
 *   /system/webext/session  where a handed-over site session arrives (never the socket: it must not be a tool result).
 *   /system/webext/lend     the same door outbound, where a sandbox account's session is collected to be lent
 *                           to the person's own browser for a step no remote browser can do (a passkey, a
 *                           hardware key, an SSO that checks the device).
 *
 * Both are authenticated by the extension's OWN enrollment token as a bearer, which is what makes them safe to
 * exempt from the browser's Google auth: the only thing that can post here is an extension the owner paired. */

/* Where a handed-over session lands. Authenticated by the extension's OWN enrollment token as a bearer (the
 * runner-credentials precedent), which is what makes this door safe to exempt from the browser's Google auth:
 * the only thing that can post here is an extension the owner paired, and it can only ever write into this
 * sandbox's own profiles. The payload is never logged, and the answer never quotes it. */
export type WebExtRoutesDeps = Pick<Services, "webexts" | "workspace" | "capabilities" | "logger">;

export const createWebExtSessionRoute =
    (services: WebExtRoutesDeps) =>
    async (c: Context): Promise<Response> => {
        const id = await services.webexts.verify(bearerFrom(c.req.header("authorization")) ?? "");
        if (id === undefined) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const parsed = WebExtSessionImportSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: "That session payload is not one this sandbox can read." }, 400);
        }
        const result = await importBrowserSession(parsed.data, {
            workspaceRoot: services.workspace.root,
            capabilities: await services.capabilities.list(),
        });
        services.logger.info({ browser: id, account: parsed.data.account, ok: result.ok }, "webext: session handed over");
        return c.json(result, result.ok ? 200 : 409);
    };

/* The same door in the other direction: where the extension collects a sandbox account's session to LEND to the
 * person's own browser, for the step no remote browser can do — a passkey, a hardware key, an SSO that checks
 * the device. Authenticated identically, and answering with the cookies ON THIS RESPONSE, which is the whole
 * reason it is a route rather than a socket call: a socket answer is an MCP result, and an MCP result is
 * something the model reads.
 *
 * The log line names the account and the site and never the jar, exactly as the import's does. */
export const createWebExtLendRoute =
    (services: WebExtRoutesDeps) =>
    async (c: Context): Promise<Response> => {
        const id = await services.webexts.verify(bearerFrom(c.req.header("authorization")) ?? "");
        if (id === undefined) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const parsed = WebExtSessionExportSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: "That request is not one this sandbox can read." }, 400);
        }
        const result = await exportBrowserSession(parsed.data, {
            workspaceRoot: services.workspace.root,
            capabilities: await services.capabilities.list(),
        });
        services.logger.info(
            { browser: id, account: parsed.data.account, domain: parsed.data.domain, ok: result.ok, cookies: result.cookies?.length ?? 0 },
            "webext: session lent to the owner's browser",
        );
        return c.json(result, result.ok ? 200 : 409);
    };
