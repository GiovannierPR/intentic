# Dev auth: run intentic without Google sign-in

**Fork note (dev-auth branch).** Upstream intentic signs the platform in with Google only, and the sandbox
daemon verifies the end user against Google's JWKS directly. This fork adds a self-hosted path that removes
Google from both. It is meant for a development deployment you own end to end — do not expose these ports to
the internet without revisiting the trust model (see docs/second-sign-in-analysis.md, option 4, for the
trade-off upstream documents).

The change set is deliberately small: one config flip, one documented recipe. No auth flow is rewritten.

## 0. Database without Docker: hosted Postgres (Supabase and kin)

`pnpm dev` chains `db:up`, which starts Postgres in Docker. On a machine without Docker, point
`DATABASE_URL` at any hosted Postgres and use the remote variants instead:

```sh
# .env
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-1-<region>.pooler.supabase.com:6543/postgres
```

```sh
pnpm dev:remote         # api + web + site, migrations against DATABASE_URL, no Docker
pnpm dev:light:remote   # api + web only
pnpm db:remote          # migrations alone
```

`db:remote` is `migrate:deploy` alone: the database is already running, there is nothing to compose up.

## 1. Platform: email + password sign-up

`_platform/api/src/auth.ts` now ships `emailAndPassword: { enabled: true }`. Better Auth serves the standard
endpoints out of the box, no UI work required for the API side:

```sh
# Sign up (creates the account and returns the session cookie)
curl -k -X POST https://localhost:6480/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"email": "you@example.com", "password": "a-real-password", "name": "You"}' \
  -c cookies.txt

# Later sign-ins
curl -k -X POST https://localhost:6480/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d '{"email": "you@example.com", "password": "a-real-password"}' \
  -c cookies.txt
```

(`-k` accepts the self-signed dev certificate; skip it if you ran `pnpm cert:trust`.)

The SPA's login page still renders the Google button — the browser side of this fork is the follow-up. Until
then, the session cookie set by the curl above is what the workspace needs: the SPA and the API are same-site
in dev, so once the cookie exists, opening the web app finds you signed in.

## 2. Sandbox daemon: two ways, pick one

### 2a. No daemon auth at all (simplest, loopback-only)

`createServices` (sandbox/src/composition.ts) only builds the authorizer when `GOOGLE_CLIENT_ID` is set in the
daemon's environment. Leave it empty and the daemon runs in its loopback profile: no bearer check on the
routes. This is the right answer while the daemon only listens on loopback inside a private dev machine or
codespace. **Never expose that port**: without the authorizer there is no owner check at all.

### 2b. Pre-seeded owner + hand-minted session (keeps the gates on)

When the daemon DOES have the authorizer but you cannot produce a Google token:

1. Bind ownership directly — the owner is trust-on-first-use persisted as JSON:

   ```sh
   # <workspaceRoot>/.intentic/identity/owner.json
   mkdir -p <workspaceRoot>/.intentic/identity
   printf '{"email": "you@example.com"}' > <workspaceRoot>/.intentic/identity/owner.json
   ```

2. Mint a daemon session — the daemon's steady-state credential is its own HS256 JWT
   (sandbox/src/auth/session.ts), signed with `<historyRoot>/session-secret`, a file the daemon creates on
   first use:

   ```sh
   pnpm --filter @intentic/sandbox exec node scripts/dev-session.mjs you@example.com <historyRoot>
   ```

   The script prints `{ token, expiresAt, email }`.

3. Hand it to the browser — the workspace reads the session from localStorage
   (`_editor/web/src/composables/sandbox/sandboxSession.ts`):

   ```js
   // DevTools console on the web app origin; <sandboxId> is the id the platform assigned the sandbox
   localStorage.setItem(
       'intentic.session.<sandboxId>',
       JSON.stringify({ token: '<token>', expiresAt: <expiresAt>, email: 'you@example.com' }),
   );
   ```

Every daemon call then presents that session; the authorizer verifies it locally and enforces against the
owner file. Google is out of the loop entirely.

## What this deliberately does not touch

- The owner-ticket path (hosted machines) — unchanged.
- `system.session`'s first-bind rule (a session may not seed ownership) — honoured by writing the owner file
  out of band instead of weakening the check.
- Upstream's Google paths — intact; this branch adds a door, it does not brick the old one.
