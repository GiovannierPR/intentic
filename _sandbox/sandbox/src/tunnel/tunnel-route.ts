import { errorMessage } from "@intentic/base/errors";
import type { IntenticLine } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";

/* ONE MOVE PER TUNNEL AT A TIME, streamed. Two concurrent dials of one id would race the same interface (and,
 * for an exit, the same derived proxy port and routing table) and leave a half-built tunnel behind; rejecting
 * the second is honest, the first is already streaming its progress. The stream ends on the link's own state
 * so the caller (a capability card, the CLI) renders the result without a second round-trip, and a failure is
 * surfaced twice on purpose: as an error frame for the stream's reader and as a thrown ORPCError for the
 * caller. Every streaming tunnel route is this shape; they differ only in the generator they run. */
export async function* heldStream(
    held: Set<string>,
    id: string,
    verb: string,
    run: () => AsyncGenerator<IntenticLine>,
    terminal: () => Promise<string>,
): AsyncGenerator<IntenticLine> {
    if (held.has(id)) {
        throw new ORPCError("CONFLICT", { message: `"${id}" is already ${verb}, wait for it to finish` });
    }
    held.add(id);
    try {
        yield* run();
        yield { kind: "log", message: await terminal() };
        yield { kind: "result", ok: true };
    } catch (error) {
        const message = errorMessage(error);
        yield { kind: "error", message };
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
    } finally {
        held.delete(id);
    }
}
