#!/usr/bin/env node
/* DEV-AUTH FORK (dev only): mint a daemon session without a Google sign-in.
 *
 * The sandbox daemon's steady-state browser credential is its own HS256 JWT (src/auth/session.ts), signed
 * with <historyRoot>/session-secret — a file the daemon creates on first use. This script signs the same
 * token shape by hand, so a self-hosted dev sandbox can authenticate a browser with no Google in the loop.
 * Pair it with a pre-seeded owner file (<workspaceRoot>/.intentic/identity/owner.json); see docs/dev-auth.md.
 *
 * Usage:  pnpm --filter @intentic/sandbox exec node scripts/dev-session.mjs <email> [historyRoot]
 * Output: one JSON line, { token, expiresAt, email } — the exact shape the web app stores in localStorage
 *         under `intentic.session.<sandboxId>`. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SignJWT } from "jose";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ISSUER = "intentic-sandbox-session";

const [email, historyRoot] = process.argv.slice(2);
if (email === undefined || !email.includes("@")) {
    console.error("usage: node scripts/dev-session.mjs <email> [historyRoot]");
    process.exit(1);
}
if (historyRoot === undefined) {
    console.error("error: historyRoot is required (the daemon's HISTORY_ROOT, where session-secret lives)");
    process.exit(1);
}

const stored = await readFile(join(historyRoot, "session-secret"), "utf8").catch(() => undefined);
if (stored === undefined) {
    console.error(`error: no session secret at ${join(historyRoot, "session-secret")} — start the daemon once first.`);
    process.exit(1);
}
const secret = Buffer.from(stored.trim(), "base64url");
if (secret.length < 32) {
    console.error("error: session secret is shorter than 32 bytes — the daemon would reject it too.");
    process.exit(1);
}

const expiresAt = Date.now() + SESSION_TTL_MS;
const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(secret);

process.stdout.write(JSON.stringify({ token, expiresAt, email }) + "\n");
