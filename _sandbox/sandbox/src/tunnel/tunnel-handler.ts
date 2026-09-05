import type { CapabilityStatus, IntenticLine } from "@intentic/sandbox-contract";
import type { CapabilityHandler } from "../capabilities/capability.js";
import { removeLoadedSkill, writeLoadedSkill } from "../settings/loaded-skills.js";
import type { TunnelEntry, TunnelKindName } from "./tunnel-links.js";

/* A tunnel kind's capability handler is only the manifest's half of the story: STORE the thing (credentials, a
 * pool, whether it comes up on boot), and let the kind's own links layer do every dial, so the operator's card,
 * the agent's CLI, this apply and the boot restore observe one implementation. What the two kinds' handlers
 * had each written out is here once; a kind declares the data (its skill, its fragments, its echo) and the
 * three verbs its links layer already owns. */

// What the handler needs of a driver: the on-disk half. Both kinds' SPIs carry exactly these three.
export interface TunnelDriverFiles<Config> {
    readonly write: (id: string, config: Config) => Promise<void>;
    readonly erase: (id: string, config: Config) => Promise<void>;
    readonly missingTool: () => Promise<string | undefined>;
}

export interface TunnelKind<Config> {
    readonly kind: TunnelKindName;
    // The skill the agent drives this kind through: shared by every entry of the kind, dropped with the last.
    readonly skill: { readonly name: string; readonly text: string };
    readonly secret: NonNullable<CapabilityHandler["secret"]>;
    readonly echo: CapabilityHandler["echo"];
    readonly fragment: NonNullable<CapabilityHandler["fragment"]>;
    readonly driverOf: (config: Config) => TunnelDriverFiles<Config>;
    // Whether the manifest says this one should be up on its own (auto-connect, auto-start).
    readonly wanted: (config: Config) => boolean;
    readonly up: (entry: TunnelEntry<Config>) => AsyncGenerator<IntenticLine>;
    readonly down: (entry: TunnelEntry<Config>) => Promise<void>;
    readonly status: (entry: TunnelEntry<Config>) => Promise<CapabilityStatus>;
    // What an apply says when it stored the entry and dialled nothing: waiting for a click on the card, or
    // waiting for the rebuild that installs its client.
    readonly stored: (id: string) => string;
    readonly afterRebuild: string;
}

// A live link mapped onto the capability grid's four states. Mid-dial is `pending` rather than `active` on
// purpose: a tunnel coming up is not yet carrying anything, and the grid's pending affordance already means
// "not finished". `unavailable` is the pre-rebuild state, pending for the same reason.
export const tunnelStatus = (
    link: { readonly state: string; readonly detail?: string | undefined },
    live: { readonly active: string; readonly pending: string },
): CapabilityStatus => {
    if (link.state === live.active) {
        return { state: "active" };
    }
    if (link.state === live.pending) {
        return { state: "pending", detail: link.detail ?? live.pending };
    }
    if (link.state === "unavailable") {
        return { state: "pending", detail: "rebuild required" };
    }
    if (link.state === "failed") {
        return { state: "error", ...(link.detail === undefined ? {} : { detail: link.detail }) };
    }
    return { state: "inactive" };
};

export const tunnelHandler = <Config>(spec: TunnelKind<Config>): CapabilityHandler => ({
    secret: spec.secret,
    echo: spec.echo,
    fragment: spec.fragment,
    // A tunnel's files are written per name by its driver and the re-apply writes them under the new one, so a
    // rename only takes the old one down and erases what it left. One that was up comes back where the config
    // says it should, under the name it now has.
    rename: {
        carry: async (_ctx, from, _to, raw) => {
            const config = raw as Config;
            await spec.down({ id: from, config }).catch(() => undefined);
            await spec.driverOf(config).erase(from, config);
        },
    },
    async *apply(ctx, id, raw) {
        const config = raw as Config;
        const entry = { id, config };
        const driver = spec.driverOf(config);
        // Persist first: the manifest entry is what puts the fragment into the overlay, so an add must land
        // even when the client isn't installed yet.
        await driver.write(id, config);
        await writeLoadedSkill(ctx.files, ctx.workspace.root, spec.skill.name, spec.skill.text);
        // Re-applying (an edited credential, a changed country, an auto flip) must never leave the old one
        // running: take it down, then bring it back below if it should be up.
        await spec.down(entry).catch(() => undefined);
        if (!spec.wanted(config)) {
            yield { kind: "log", message: spec.stored(id) };
            return;
        }
        const missing = await driver.missingTool();
        if (missing !== undefined) {
            // Pre-rebuild bootstrap: a missing client is a soft outcome, not a failed add, the overlay this
            // very add composes is what installs it.
            yield { kind: "log", message: `Stored ${id}, this sandbox doesn't carry ${missing} yet. Rebuild it from the Environment card; ${spec.afterRebuild}.` };
            return;
        }
        yield* spec.up(entry);
    },
    status: async (_ctx, id, raw) => await spec.status({ id, config: raw as Config }),
    remove: async (ctx, id, raw) => {
        const config = raw as Config;
        await spec.down({ id, config }).catch(() => undefined);
        await spec.driverOf(config).erase(id, config);
        // The skill is shared by every entry of the kind, so it goes only with the last one. The route removes
        // the manifest entry AFTER this handler, so `id` is still counted here.
        const left = (await ctx.capabilities.list()).filter((capability) => capability.kind === spec.kind).length;
        if (left <= 1) {
            await removeLoadedSkill(ctx.files, ctx.workspace.root, spec.skill.name);
        }
    },
});
