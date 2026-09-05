import type { Context } from "hono";
import { streamAgent } from "../agent/agent.routes.js";
import { tokenEquals } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { fireAutomation, PAYLOAD_MAX } from "./scheduler.js";

// POST /automations/:id/fire. Webhook fire for event automations: external systems (GitHub/Sentry/monitors)
// POST here to wake the agent, authenticated by the automation's own token as ?token=…, the only mechanism
// every webhook sender supports. Enforced ALWAYS (fail-closed even in loopback, unlike /enroll, the token
// always exists), which is why the route is exempt from the bearer middleware in app.ts. The body (any format,
// capped) reaches the guard as AUTOMATION_PAYLOAD and is appended to the wake prompt. Responds immediately;
// the agent turn runs detached, exactly like a scheduler fire.
export const createAutomationFireRoute =
    (services: Services) =>
    async (c: Context<AppEnv, "/automations/:id/fire">): Promise<Response> => {
        const automation = await services.automations.get(c.req.param("id"));
        if (automation === undefined || automation.trigger.kind !== "event") {
            return c.json({ error: "no event automation with that id" }, 404);
        }
        const token = automation.trigger.token;
        if (token === undefined || !tokenEquals(c.req.query("token") ?? "", token)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        if (!automation.enabled) {
            return c.json({ error: "automation disabled" }, 409);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > PAYLOAD_MAX) {
            return c.json({ error: "payload too large" }, 413);
        }
        const payload = await c.req.text();
        // A webhook is an outside message too, so its wake opens a surfaced conversation like a Discord mention's
        // does, the sender is a system, not a person, so the origin carries no author or channel.
        void fireAutomation(services, automation, streamAgent, {
            ...(payload === "" ? {} : { payload }),
            origin: { automationId: automation.id, provider: "webhook" },
            title: `Webhook: ${automation.id}`,
        }).catch((error: unknown) => services.logger.error({ err: error, automation: automation.id }, "automation run failed"));
        return c.json({ ok: true });
    };
