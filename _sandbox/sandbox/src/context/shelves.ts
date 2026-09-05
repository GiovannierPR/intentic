import { readdir, readFile } from "node:fs/promises";
import { type ContextComposition, type ContextItemId, type ContextItemKind, type ContextShelf, ContextShelfSchema, contextItem } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { statePath } from "../workspace/state-paths.js";

/* THE CONTEXT SHELVES, and the one function that turns a shelf into a conversation's composition.
 *
 * A shelf is the owner's list of what a session may carry, in the order it is loaded and shed
 * (ContextShelfSchema). It lives as one JSON file per shelf under `.intentic/config/context/`, tracked and
 * carried like a persona card, and read here straight off the disk: a shelf is consulted on the turn that
 * creates a conversation's worktrees, by the route that already holds the workspace root, and nothing edits one
 * from inside the daemon yet.
 *
 * `composeSelection` is deliberately the ONLY writer of a composition's items. Three doors will feed it, the shelf
 * itself when nobody picks, a curator model picking within it, a person toggling chips on the card, and every one
 * of them has to come out the same shape: pinned in, denied out, caps applied from the tail of the owner's
 * order. One function is what makes "the shelf is the ceiling" a property of the code rather than a promise each
 * door keeps separately. */

export const shelvesDir = (root: string): string => statePath(root, ".intentic/config/context/");
export const shelfPath = (root: string, id: string): string => statePath(root, ".intentic/config/context/", `${id}.json`);

/* One shelf by id, or undefined when there is no readable one. The FILE NAME is the id everywhere the daemon
 * looks a shelf up, so a file whose `id` field disagrees is refused rather than answered under either name: a
 * card that answers to two ids is how a persona and a setting end up pointing at what look like different
 * shelves and are one. */
export const readShelf = async (root: string, id: string, logger?: Logger): Promise<ContextShelf | undefined> => {
    const text = await readFile(shelfPath(root, id), "utf8").catch(() => undefined);
    if (text === undefined) {
        return undefined;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        logger?.warn({ err: error, shelf: id }, "context: shelf is not JSON, ignored");
        return undefined;
    }
    const parsed = ContextShelfSchema.safeParse(raw);
    if (!parsed.success) {
        logger?.warn({ shelf: id, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, "context: shelf does not validate, ignored");
        return undefined;
    }
    if (parsed.data.id !== id) {
        logger?.warn({ shelf: id, declared: parsed.data.id }, "context: shelf file name and id disagree, ignored");
        return undefined;
    }
    return parsed.data;
};

// Every readable shelf, in file order. A directory that does not exist is a workspace with no shelves.
export const listShelves = async (root: string, logger?: Logger): Promise<ContextShelf[]> => {
    const entries = await readdir(shelvesDir(root), { withFileTypes: true }).catch(() => []);
    const ids = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length))
        .toSorted((a, b) => a.localeCompare(b));
    const shelves = await Promise.all(ids.map((id) => readShelf(root, id, logger)));
    return shelves.filter((shelf): shelf is ContextShelf => shelf !== undefined);
};

// The cap that applies to one kind of item, absent when the shelf sets none for it.
const capFor = (shelf: ContextShelf, kind: ContextItemKind): number | undefined => (kind === "repo" ? shelf.caps?.repos : undefined);

/* THE PICK, from a shelf and (optionally) somebody's choice within it.
 *
 * `requested` absent means nobody chose: the composition is the whole shelf, which is what a shelf with no
 * curator and no toggles produces. Present, it is filtered to what the shelf ALLOWS; an id off the shelf is
 * dropped here, never refused, because this is the last line and the door that took the request is where a
 * refusal has somebody to say it to.
 *
 * ORDER IS THE SHELF'S. Pinned items lead, in their own order, then the allowed ones in theirs. The caps are
 * applied by walking that order and dropping what exceeds them, so the tail of `allowed` is what goes first,
 * which is the one promise the schema makes about the order. Pinned items count toward a cap and are never
 * dropped by one: a shelf whose pins alone exceed its cap has a cap it cannot honour, and the pins win, because
 * "always" is the stronger word. */
export const composeSelection = (shelf: ContextShelf, requested?: readonly string[]): ContextComposition => {
    const denied = new Set<string>(shelf.denied);
    const pinned = shelf.pinned.filter((id) => !denied.has(id));
    const allowed = shelf.allowed.filter((id) => !denied.has(id));
    const asked = new Set<string>(requested === undefined ? allowed : requested.filter((id) => allowed.includes(id)));
    const pinnedSet = new Set<string>(pinned);
    const ordered: ContextItemId[] = [...pinned, ...allowed.filter((id) => !pinnedSet.has(id) && asked.has(id))];
    const counts = new Map<ContextItemKind, number>();
    const items = ordered.filter((id) => {
        const { kind } = contextItem(id);
        const taken = counts.get(kind) ?? 0;
        const cap = capFor(shelf, kind);
        if (!pinnedSet.has(id) && cap !== undefined && taken >= cap) {
            return false;
        }
        counts.set(kind, taken + 1);
        return true;
    });
    return { shelf: shelf.id, items };
};

/* WHICH REPOSITORIES A COMPOSITION MEANS, the answer worktrees.ts takes as its selection. Undefined is "every
 * repository the workspace has", the composition of a conversation that was opened with no shelf, and it is
 * spelled as the absence rather than as a list so that a repository cloned tomorrow joins such a conversation
 * on its next turn exactly as it always has. */
export const repoSelectionOf = (composition: ContextComposition | undefined): readonly string[] | undefined =>
    composition === undefined
        ? undefined
        : composition.items.flatMap((id) => {
              const item = contextItem(id);
              return item.kind === "repo" ? [item.name] : [];
          });
