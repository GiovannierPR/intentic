import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { listShelves, readShelf, shelfPath, shelvesDir } from "./shelves.js";

// The shelf files on disk, read the way the turn reads them. The pure half (composing a selection) is in
// shelves.test.ts; this is the half that opens a temp tree.

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a shelf is read by file name, and a file whose id disagrees or that does not validate is not a shelf", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentic-shelves-"));
    tempDirs.push(root);
    await mkdir(shelvesDir(root), { recursive: true });
    await writeFile(shelfPath(root, "backend"), JSON.stringify({ id: "backend", label: "Backend", allowed: ["repo:api"] }));
    await writeFile(shelfPath(root, "renamed"), JSON.stringify({ id: "other", allowed: ["repo:api"] }));
    await writeFile(shelfPath(root, "broken"), "{ not json");
    await writeFile(shelfPath(root, "wrong"), JSON.stringify({ id: "wrong", allowed: ["lsp"] }));

    expect(await readShelf(root, "backend")).toEqual({ id: "backend", label: "Backend", pinned: [], allowed: ["repo:api"], denied: [] });
    expect(await readShelf(root, "renamed")).toBeUndefined();
    expect(await readShelf(root, "broken")).toBeUndefined();
    expect(await readShelf(root, "wrong")).toBeUndefined();
    expect(await readShelf(root, "absent")).toBeUndefined();
    expect((await listShelves(root)).map((entry) => entry.id)).toEqual(["backend"]);
    // No directory at all is a workspace with no shelves, not a failure.
    expect(await listShelves(join(root, "elsewhere"))).toEqual([]);
});
