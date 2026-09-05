import type { AgentTurn, ContextComposition, TurnNote } from "@intentic/sandbox-contract";
import { compactedSinceLastTurn } from "../agents/agents-store.js";
import type { ConversationWorktree } from "../agents/worktrees.js";
import type { Services } from "../composition.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import { contextNote } from "./context-note.js";
import { composeSelection, readShelf, repoSelectionOf } from "./shelves.js";

/* A CONVERSATION'S COMPOSITION, decided and described: the two places the daemon reads a shelf.
 *
 * DECIDED once, by the route, on the turn that creates the conversation's worktrees (agent.routes.ts, right
 * before `ensure`), because that is the one moment the answer can still change what gets checked out. The
 * shelf is the closest one that speaks: the persona card the turn wears, then the sandbox setting, then none.
 * None is the ordinary answer today and costs nothing: no shelf, no composition, every repository, exactly as
 * before shelves existed.
 *
 * DESCRIBED on the turn's preamble (turn-plan.ts) from the record the route wrote, so the note and the tree
 * cannot disagree: both are read off the same composition, and the repositories it does not carry are the
 * live ones it does not name, computed against the workspace at the moment the note is built. */

// The shelf id a turn resolves to, or undefined for none. A persona's own answer wins over the sandbox's.
const shelfIdFor = async (services: Services, input: AgentTurn): Promise<string | undefined> => {
    const persona = input.actsAs === undefined ? undefined : await services.personas.get(input.actsAs);
    if (persona?.context !== undefined) {
        return persona.context;
    }
    const { contextShelf } = await services.sandboxSettings.get();
    return contextShelf === "" ? undefined : contextShelf;
};

/* What the conversation about to be created should carry, or undefined for everything. A shelf named but not
 * found is a warning and everything, never a refusal: the card is committed config a person hand-edits, and
 * the honest failure for a typo'd shelf is a session that sees the whole workspace, not one that will not start. */
export const decideComposition = async (services: Services, input: AgentTurn): Promise<ContextComposition | undefined> => {
    const id = await shelfIdFor(services, input);
    if (id === undefined) {
        return undefined;
    }
    const shelf = await readShelf(services.workspace.root, id, services.logger);
    if (shelf === undefined) {
        services.logger.warn({ shelf: id, conversationId: input.conversationId }, "context: no such shelf, the conversation carries everything");
        return undefined;
    }
    return composeSelection(shelf);
};

// Do two records name the same repositories? Bases move (the pre-turn rebase) without the composition changing,
// so this is the comparison that says whether a join or a leave happened and the record has to be rewritten.
export const sameRepos = (before: readonly { readonly repo: string }[], after: readonly { readonly repo: string }[]): boolean =>
    before.length === after.length && before.every(({ repo }, index) => after[index]?.repo === repo);

/* THE CONVERSATION'S CHECKOUT, BROUGHT TO WHAT IT CARRIES: the one call a turn makes for its worktrees, from
 * both arms of the route (agent.routes.ts, the local turn and the runner's mirror), so a shelf narrows a remote
 * conversation exactly as it narrows one that runs here.
 *
 * On the OPENING turn (no repos recorded yet) the composition is decided and written down with the worktrees it
 * shaped. On every later turn the recorded composition is handed back to `ensure`, which brings the checkout to
 * it: a repo it names that the record lacks joins, one it stopped naming leaves (worktrees.ts). The record is
 * rewritten whenever the set of repos moved, which used to happen only on the opening turn because nothing else
 * could move it. `base` is a snapshot to pin every repo to (a workflow's, a fork's), absent for today's files. */
export const ensureComposedWorktree = async (
    services: Services,
    input: AgentTurn,
    conversationId: string,
    base: readonly { repo: string; base: string }[] | undefined,
    namespaced: boolean,
): Promise<ConversationWorktree> => {
    const recorded = services.agents.entry(conversationId)?.repos ?? [];
    const opening = recorded.length === 0;
    const composition = opening ? await decideComposition(services, input) : services.agents.entry(conversationId)?.composition;
    const worktree = await services.agentWorktrees.ensure(conversationId, recorded, base, namespaced, repoSelectionOf(composition));
    if (opening || !sameRepos(recorded, worktree.repos)) {
        await services.agents.recordWorktree(conversationId, worktree.repos, composition);
    }
    return worktree;
};

/* The note on the turns that owe it: the opening turn, and the turn after a compaction, the two moments nothing
 * in the session's own history can be relied on to carry it (agents-store.ts compactedSinceLastTurn). A
 * conversationless turn has no record and carries everything. Read off the composition the route recorded
 * moments ago with the worktrees, so the note describes the tree the turn is about to open on. */
export const contextNoteIfDue = (
    services: Services,
    input: AgentTurn,
    entry: { readonly compactedTurn?: number | undefined } | undefined,
    conversationTurns: number,
): Promise<TurnNote | undefined> => {
    if (input.conversationId === undefined || (conversationTurns !== 0 && !compactedSinceLastTurn(entry, conversationTurns))) {
        return Promise.resolve(undefined);
    }
    return contextNoteFor(services, input.conversationId);
};

/* The preamble's account of the composition, or undefined for a conversation that carries everything, which
 * has nothing to be told. One directory walk (repo-discovery.ts) on the turns that send it. */
export const contextNoteFor = async (services: Services, conversationId: string): Promise<TurnNote | undefined> => {
    const composition = services.agents.entry(conversationId)?.composition;
    if (composition === undefined) {
        return undefined;
    }
    const selected = repoSelectionOf(composition) ?? [];
    const live = await discoverRepos(services.workspace.root);
    const shelf = composition.shelf === undefined ? undefined : await readShelf(services.workspace.root, composition.shelf, services.logger);
    return contextNote({
        shelf: shelf?.label ?? composition.shelf,
        carried: selected.filter((repo) => live.includes(repo)),
        absent: live.filter((repo) => !selected.includes(repo)),
        missing: selected.filter((repo) => !live.includes(repo)),
    });
};
