import { ContextShelfSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { composeSelection, repoSelectionOf } from "./shelves.js";

/* THE ONE WRITER OF A COMPOSITION, checked against the three promises the schema makes about a shelf: the order
 * is the owner's, pinned is always in, denied always wins, and a cap sheds from the tail of that order without
 * ever shedding a pin. */

const shelf = (fields: Partial<ReturnType<typeof ContextShelfSchema.parse>>) => ContextShelfSchema.parse({ id: "s", ...fields });

test("nobody choosing means the whole shelf, in the shelf's order, pinned first", () => {
    const picked = composeSelection(shelf({ pinned: ["repo:b"], allowed: ["repo:a", "repo:b", "repo:c"] }));
    expect(picked).toEqual({ shelf: "s", items: ["repo:b", "repo:a", "repo:c"] });
});

test("a request is filtered to what the shelf allows, and keeps the shelf's order rather than the request's", () => {
    const picked = composeSelection(shelf({ allowed: ["repo:a", "repo:b", "repo:c"] }), ["repo:c", "repo:zzz", "repo:a"]);
    expect(picked.items).toEqual(["repo:a", "repo:c"]);
});

test("pinned is in whether or not it was requested or even listed as allowed", () => {
    const picked = composeSelection(shelf({ pinned: ["repo:p"], allowed: ["repo:a", "repo:b"] }), ["repo:b"]);
    expect(picked.items).toEqual(["repo:p", "repo:b"]);
});

test("denied wins over allowed, over a request, and over a pin", () => {
    const picked = composeSelection(shelf({ pinned: ["repo:p"], allowed: ["repo:a", "repo:b"], denied: ["repo:p", "repo:b"] }), ["repo:a", "repo:b"]);
    expect(picked.items).toEqual(["repo:a"]);
});

test("a cap sheds from the tail of the shelf's order, and never a pin", () => {
    // Three allowed, cap of two: the last allowed goes. The pin counts toward the cap and stays even when it
    // alone would exceed it.
    expect(composeSelection(shelf({ allowed: ["repo:a", "repo:b", "repo:c"], caps: { repos: 2 } })).items).toEqual(["repo:a", "repo:b"]);
    expect(composeSelection(shelf({ pinned: ["repo:p", "repo:q"], allowed: ["repo:a"], caps: { repos: 1 } })).items).toEqual(["repo:p", "repo:q"]);
});

test("the repositories a composition means, and the absence that means every one of them", () => {
    expect(repoSelectionOf(undefined)).toBeUndefined();
    expect(repoSelectionOf({ shelf: "s", items: ["repo:api", "repo:clients/billing"] })).toEqual(["api", "clients/billing"]);
});

test("an item id is a kind and a safe workspace path, nothing else", () => {
    for (const ok of ["repo:api", "repo:clients/billing", "repo:a.b_c-d"]) {
        expect(ContextShelfSchema.safeParse({ id: "s", allowed: [ok] }).success, ok).toBe(true);
    }
    for (const bad of ["api", "skill:lsp", "repo:", "repo:../x", "repo:/x", "repo:a//b", "repo:.hidden", "repo:a b"]) {
        expect(ContextShelfSchema.safeParse({ id: "s", allowed: [bad] }).success, bad).toBe(false);
    }
});
