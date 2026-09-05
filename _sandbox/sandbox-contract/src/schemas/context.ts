// context: which part of the workspace a conversation carries
import { z } from "zod";
import { entryId } from "./internal.js";

/* A CONVERSATION SEES A CHOSEN PART OF THE WORKSPACE, and these three schemas are how the choice is spelled.
 *
 * A workspace grows into more than any one session should open on: dozens of repositories, hundreds of skills,
 * a shelf of reference clones. Every conversation used to get all of it, one worktree per repository, frozen at
 * its first turn (sandbox agents/worktrees.ts). The cost is paid twice, in checkouts nobody reads and in a
 * project map and a skill listing that describe everything to a session that needs a corner of it
 * (docs/context-composition-plan.md at the workspace root measures both).
 *
 * THREE WORDS. A SHELF is what the owner writes: the items a session MAY take, in the order they are loaded and,
 * when a cap bites, shed from the tail. A COMPOSITION is the pick for one conversation, a list of item ids in
 * shelf order, stored on its registry entry. An ITEM ID names one thing in the workspace, `<kind>:<name>`.
 *
 * ONE KIND TODAY, `repo:`, which is the whole of what a composition can make real: a repository is in the
 * conversation (a worktree of it exists) or it is not (the directory does not exist). The grammar takes a kind
 * prefix so the next ones (a directory inside a repository through a sparse cone, a skill folder, a reference
 * shelf entry, a capability) widen this list and change nothing else. The root repository is never an item: it
 * is the workspace itself and every conversation stands in it. */
export const CONTEXT_ITEM_KINDS = ["repo"] as const;
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

/* `<kind>:<name>`. The name is a workspace-relative path or an id: safe segments, no `..`, no empty segment, so
 * joining it under a root can never escape, the same shape repo-discovery.ts accepts for a repo id. */
const ITEM = /^(repo):[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;
export const ContextItemIdSchema = z
    .string()
    .min(1)
    .max(200)
    .regex(ITEM)
    .describe("One thing in the workspace a conversation can carry, as `<kind>:<name>`. Today the kind is `repo` and the name is a repository's workspace-relative path.");
export type ContextItemId = z.infer<typeof ContextItemIdSchema>;

// The two halves of an id, for the code that has to act on the name. The schema above already proved the shape.
export const contextItem = (id: ContextItemId): { readonly kind: ContextItemKind; readonly name: string } => {
    const at = id.indexOf(":");
    return { kind: id.slice(0, at) as ContextItemKind, name: id.slice(at + 1) };
};

/* HOW MANY OF EACH KIND A COMPOSITION MAY HOLD. Counted per kind because the kinds cost differently: a repository
 * is a checkout, a skill is a line in every prompt. Absent means no limit. A pinned item is never shed to meet
 * a cap: `pinned` is the owner saying "always", and a cap that could override it would make two fields disagree
 * about the same item. */
export const ContextCapsSchema = z.object({
    repos: z.number().int().min(0).optional().describe("How many repositories a composition may hold. Absent means as many as the shelf allows."),
});
export type ContextCaps = z.infer<typeof ContextCapsSchema>;

/* WHAT A SESSION MAY TAKE, in the owner's order. One file per shelf under `.intentic/config/context/<id>.json`,
 * tracked and carried like a persona card (workspace-state.ts), for the same reason: a shelf is a list of
 * names, holds no credential, and belongs in a pull request.
 *
 * `allowed` IS ORDERED, and the order is the only priority there is: it is what a curator is shown, the order
 * items are loaded, and the order they are shed from the tail when a cap is hit. The owner fixes the order and
 * the ceiling; whoever picks (a model, a person on the card, the shelf itself when nobody picks) decides
 * membership and nothing else.
 *
 * `pinned` is always in, whether or not it is also listed in `allowed`. `denied` wins over everything, including
 * a pinned item, so a shelf that inherits a list it did not write can still take one thing off it. */
export const ContextShelfSchema = z.object({
    id: entryId.describe("The shelf's id, which is also its file name."),
    label: z.string().max(60).optional().describe("What to call it on screen. Absent falls back to the id."),
    pinned: z.array(ContextItemIdSchema).max(200).default([]).describe("Items every composition from this shelf carries."),
    allowed: z
        .array(ContextItemIdSchema)
        .max(500)
        .default([])
        .describe("Items a composition may carry, in the order they are loaded and shed. The order is the priority; nothing else is."),
    denied: z.array(ContextItemIdSchema).max(200).default([]).describe("Items no composition from this shelf carries, whatever else says so."),
    caps: ContextCapsSchema.optional().describe("How many of each kind a composition may hold."),
});
export type ContextShelf = z.infer<typeof ContextShelfSchema>;

/* THE PICK FOR ONE CONVERSATION, on its registry entry beside the worktree composition it decides.
 *
 * `items` is exactly what the conversation carries, in shelf order, and the root repository besides. A
 * conversation whose entry has NO composition carries everything the workspace has, which is what every
 * conversation did before shelves existed and what a conversation opened with no shelf still does. Those two
 * are one state on purpose: the absence is the answer, and a stored "everything" would be a second spelling of
 * it that could disagree with the first. */
export const ContextCompositionSchema = z.object({
    shelf: entryId.optional().describe("Which shelf this pick was made from. Absent when the items were set without one."),
    items: z.array(ContextItemIdSchema).max(500).describe("What the conversation carries, in shelf order. The root repository is always carried and never listed."),
});
export type ContextComposition = z.infer<typeof ContextCompositionSchema>;
