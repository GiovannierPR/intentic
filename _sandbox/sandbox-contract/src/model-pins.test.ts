import { expect, test } from "vitest";
import { type ModelSource, modelPinKey, parsePinned, resolveRoleModels } from "./model-pins.js";
import type { ModelPin } from "./schemas/agent.js";

/* Which models a job spends, and in which order. The rule answers two surfaces at once: the daemon walks it,
 * the browser names its head in that job's settings row, so what these tests pin is that a sandbox's
 * connections alone decide it, with no stored id to go stale, and that there is always a rung underneath the
 * first one whenever the sandbox has another account to reach for.
 *
 * `commit-message` and `pipeline-fix` stand in for the two KINDS of role here (model-roles.ts): the first is a
 * one-shot, whose empty list derives the Auto ladder, and the second is a whole session, whose empty list
 * resolves to nothing so the caller's own composer pick answers. Everything else about the two is identical,
 * which is why one resolver serves both. */

const HELPER = `commit-message` as const;
const RUN = `pipeline-fix` as const;

// A pin as the settings rows store one. The tests are about ORDER, so most of them name only the pair; the
// knobs an entry can carry ride through untouched and are asserted where that matters.
const pin = (key: string): ModelPin => {
    const at = key.indexOf(`:`);
    return { provider: key.slice(0, at), model: key.slice(at + 1) };
};

// Catalogs as their providers actually publish them: Claude's ranked list, the rest in registry order.
const CLAUDE: ModelSource = { provider: `claude`, ready: true, models: [`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`] };
const GOOGLE: ModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-flash`, `gemini-3-flash-lite`, `gemini-3-pro`] };
const CODEX: ModelSource = { provider: `codex`, ready: true, models: [`gpt-5.4-mini`, `gpt-5.6`] };
const KIMI: ModelSource = { provider: `kimi`, ready: true, models: [`kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`] };

const offline = (source: ModelSource): ModelSource => ({ ...source, ready: false });

// The model that answers when nothing goes wrong: the head of the chain, which is what most of what follows is
// about and what every surface naming the spend up front reads.
const head = (sources: readonly ModelSource[], pinned: readonly string[]): ModelPin | undefined =>
    resolveRoleModels(sources, pinned.map(pin), HELPER)[0];

test("reaches for the efficient rung of the one connected provider, never its flagship", () => {
    expect(head([CLAUDE], [])).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
});

test("spends the FREE channel over the subscription when both offer the same rung", () => {
    // Both publish a cheap-tier row, so nothing separates them on capability, and one of them costs the user
    // nothing while the other eats headroom they watch. A background helper should not quietly bill the Claude plan.
    expect(head([CLAUDE, GOOGLE], [])).toEqual({ provider: `gemini`, model: `gemini-3-flash-lite` });
});

test("puts tier ahead of cost: a free frontier model is still the wrong tool for a commit message", () => {
    // Google connected but publishing only its Pro line. Ordering on price first would seat a flagship here,
    // which is the exact outcome the feature exists to avoid.
    const proOnly: ModelSource = { provider: `gemini`, ready: true, models: [`gemini-3-pro`] };

    expect(head([CLAUDE, proOnly], [])).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
});

test("uses stable provider order when two subscriptions offer the same tier", () => {
    const kimiCheap: ModelSource = { provider: `kimi`, ready: true, models: [`kimi-k2-mini`] };
    const claudeCheap: ModelSource = { provider: `claude`, ready: true, models: [`claude-haiku-4-5`] };

    expect(head([kimiCheap, claudeCheap], [])?.provider).toBe(`claude`);
});

test("answers the same thing however the connected providers happen to be listed", () => {
    // The daemon assembles these from live stores and the browser from its own refs; neither order is a fact.
    const answers = [head([CLAUDE, GOOGLE, CODEX], []), head([CODEX, CLAUDE, GOOGLE], []), head([GOOGLE, CODEX, CLAUDE], [])];

    expect(new Set(answers.map((answer) => modelPinKey(answer!))).size).toBe(1);
});

test("honours a pinned model verbatim, including an id no catalog lists yet", () => {
    expect(head([CLAUDE, GOOGLE], [`claude:claude-opus-5`])).toEqual({ provider: `claude`, model: `claude-opus-5` });
    // The picker's custom-id escape hatch reaches here too: a catalog can lag a release, and running something
    // other than what the settings row names would be the worse failure.
    expect(head([CLAUDE], [`claude:claude-haiku-9`])).toEqual({ provider: `claude`, model: `claude-haiku-9` });
});

test("falls back to Auto when the pinned provider is no longer connected", () => {
    // Rather than failing every click with a credential error while the sandbox can plainly still answer.
    expect(head([offline(CLAUDE), GOOGLE], [`claude:claude-haiku-4-5-20251001`])).toEqual({
        provider: `gemini`,
        model: `gemini-3-flash-lite`,
    });
});

/* A MALFORMED KEY IS REFUSED WHERE KEYS STILL EXIST. A role's list holds PINS, whose two halves are separate
 * fields the schema requires (ModelPinSchema), so "claude with an empty model" is no longer a shape the
 * resolver can be handed — it is rejected at the settings boundary instead. What still travels as a key is
 * `autoFastModels`, so the rule lives with the parser that reads one, and this is where it is pinned. */
test("refuses a malformed key rather than reading half a pin out of it", () => {
    for (const key of [`claude`, `claude:`, `:claude-haiku-4-5`, ` `]) {
        expect(parsePinned(key)).toBeUndefined();
    }
    expect(parsePinned(`claude:claude-haiku-4-5`)).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
});

/* THE TWO KINDS OF ROLE DIFFER ON EXACTLY ONE THING: what an empty list means. It is the whole reason the
 * resolver takes a role rather than a boolean, and the reason the two used to be separate files. */
test("derives a ladder for an unpinned one-shot and nothing at all for an unpinned session", () => {
    // A commit message exists to stay off the frontier tier, so working it out from what is connected is a good
    // answer and gets better as accounts are added.
    expect(resolveRoleModels([CLAUDE, GOOGLE], [], HELPER)).toEqual([
        { provider: `gemini`, model: `gemini-3-flash-lite` },
        { provider: `claude`, model: `claude-haiku-4-5-20251001` },
    ]);
    // A pipeline fix is a whole session billed whole, and nothing here can judge what one is worth — so the
    // caller's own floor (the owner's composer pick) answers instead of a ladder this file invented.
    expect(resolveRoleModels([CLAUDE, GOOGLE], [], RUN)).toEqual([]);
});

test("carries an entry's run settings through untouched, on either kind of role", () => {
    // The resolver picks WHICH entry; how that entry runs is the entry's own business and rides along whole,
    // because the turn (or the one-shot) is composed from all of it.
    const configured: ModelPin = { provider: `claude`, model: `claude-opus-5`, effort: `max`, thinking: true, harness: `claude-code` };

    expect(resolveRoleModels([CLAUDE], [configured], RUN)).toEqual([configured]);
    expect(resolveRoleModels([CLAUDE], [configured], HELPER)).toEqual([configured]);
});

test("serves the newest of a catalog that publishes no cheap tier at all", () => {
    // Kimi names no tier word anywhere. There is no cheaper rung to find, so the newest row is the honest answer.
    expect(head([KIMI], [])).toEqual({ provider: `kimi`, model: `kimi-k3` });
});

test("reports nothing when no account is connected, so the button can say so instead of failing on click", () => {
    expect(head([offline(CLAUDE), offline(GOOGLE)], [])).toBeUndefined();
    expect(resolveRoleModels([offline(CLAUDE), offline(GOOGLE)], [], HELPER)).toEqual([]);
    expect(head([], [`claude:claude-haiku-4-5`])).toBeUndefined();
});

test("skips a connected provider whose catalog has not loaded yet", () => {
    const unloaded: ModelSource = { provider: `grok`, ready: true, models: [] };

    expect(head([unloaded, CLAUDE], [])).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
    expect(head([unloaded], [])).toBeUndefined();
});

/* THE CHAIN: what the daemon walks when the model at the top of it refuses. A spent allowance is the ordinary
 * case, not the exotic one: the account a helper shares with the chat runs out mid-afternoon, and the whole
 * point of the list is that the click still lands on the next rung down. */

test("keeps the pinned models in the order they were written", () => {
    expect(resolveRoleModels([CLAUDE, GOOGLE, CODEX], [`codex:gpt-5.6`, `gemini:gemini-3-flash`, `claude:claude-haiku-4-5-20251001`].map(pin), HELPER)).toEqual([
        { provider: `codex`, model: `gpt-5.6` },
        { provider: `gemini`, model: `gemini-3-flash` },
        { provider: `claude`, model: `claude-haiku-4-5-20251001` },
    ]);
});

test("drops a pin whose provider went away and keeps the rest of the order intact", () => {
    expect(resolveRoleModels([CLAUDE, offline(GOOGLE), CODEX], [`codex:gpt-5.6`, `gemini:gemini-3-flash`, `claude:claude-haiku-4-5`].map(pin), HELPER)).toEqual([
        { provider: `codex`, model: `gpt-5.6` },
        { provider: `claude`, model: `claude-haiku-4-5` },
    ]);
});

test("stops at the end of a pinned list rather than reaching for an account the user left out", () => {
    // Google and Kimi are connected and cheaper. The user wrote down one model, so one model is what this may
    // spend: a pin exists precisely to keep a helper off the accounts it does not name.
    expect(resolveRoleModels([CLAUDE, GOOGLE, KIMI], [`claude:claude-haiku-4-5`].map(pin), HELPER)).toEqual([{ provider: `claude`, model: `claude-haiku-4-5` }]);
});

test("names each model once, however many times the list repeats it", () => {
    // The list is edited by hand; a duplicate would spend a second attempt proving the same account is out.
    expect(resolveRoleModels([CLAUDE], [`claude:claude-haiku-4-5`, `claude:claude-haiku-4-5`].map(pin), HELPER)).toEqual([
        { provider: `claude`, model: `claude-haiku-4-5` },
    ]);
});

test("Auto is a ladder too, every connected provider's cheap rung, best first", () => {
    expect(resolveRoleModels([CLAUDE, GOOGLE, KIMI], [], HELPER)).toEqual([
        { provider: `gemini`, model: `gemini-3-flash-lite` },
        { provider: `claude`, model: `claude-haiku-4-5-20251001` },
        { provider: `kimi`, model: `kimi-k3` },
    ]);
});

/* A MODEL ENDPOINT the user configured is a provider like any other here, and the reason it has to be is the
 * settings row: its options are built from the same picker catalog, so a pin naming one that this resolver
 * dropped would print one model's name in the settings row and spend a different account entirely. */
const OLLAMA: ModelSource = { provider: `endpoint/ollama`, ready: true, models: [`qwen3-coder`, `gemma3-27b`] };

test("honours a pin on a configured endpoint: the whole id, not the half before its slash", () => {
    expect(head([CLAUDE, OLLAMA], [`endpoint/ollama:qwen3-coder`])).toEqual({ provider: `endpoint/ollama`, model: `qwen3-coder` });
    // And it round-trips through the key shape the picker mints, which is where the slash-not-colon rule earns
    // itself: parsePinned splits on the FIRST colon, so an `endpoint:ollama` id would have parsed the provider
    // as "endpoint" and the model as "ollama:qwen3-coder": a pin that silently resolves to nothing.
    expect(modelPinKey({ provider: `endpoint/ollama`, model: `qwen3-coder` })).toBe(`endpoint/ollama:qwen3-coder`);
});

test("leaves Auto to the providers whose price is known, rather than reaching for someone's own server", () => {
    // Claude publishes a Haiku-class row; the endpoint's ids carry no tier word at all, so they are UNRANKED and
    // lose on tier. What a turn on a user's own model API costs is not a fact this repo holds, and Auto should
    // not be asserting one.
    expect(head([CLAUDE, OLLAMA], [])).toEqual({ provider: `claude`, model: `claude-haiku-4-5-20251001` });
});

test("still answers from an endpoint when it is the only thing configured", () => {
    // No tier word in either id, so the shared id-derived ordering decides between them exactly as it does for
    // Kimi above: the point here is that a sandbox whose only model API is its owner's still gets an answer
    // rather than the disabled "nothing connected" button.
    expect(head([offline(CLAUDE), OLLAMA], [])).toEqual({ provider: `endpoint/ollama`, model: `qwen3-coder` });
});
