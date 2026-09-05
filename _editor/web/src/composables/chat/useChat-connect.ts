import { errorMessage } from "@intentic/ui/async";
import { type AgentProvider, type KeyedProvider, type OauthAccount, providerLabel, providerSpec } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { reloadOnHotUpdate } from "../hotReload";
import { translatorAccounts } from "./providerAccounts";
import { active } from "./useChat-tabs";
import { loadProviderModels } from "./useChat-catalog";
import {
    accountBusy,
    addAccount,
    error,
    isMinted,
    managedProvider,
    providerBase,
    refreshAccounts,
    refreshTranslatorAccounts,
} from "./useChat-accounts";
import { sandboxError, sandboxJson, sandboxRequest } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";

/* Where a native sign-in BEGINS, which is the one account path that is not uniform. Claude and Grok both mint
 * their handshake at `<base>/oauth/start`. Cursor's and the minted providers' are `<base>/login/start`, because
 * what those start is not an OAuth handshake this client takes any part in — the daemon runs the exchange (and,
 * for a minted provider, the mint that follows it) itself and the redeemable half never leaves it. Naming them
 * differently is the wire saying so. */
const connectStartPath = (p: AgentProvider): string =>
    p === `cursor` || isMinted(p) ? `${providerBase(p)}/login/start` : `${providerBase(p)}/oauth/start`;

// --- Routed-provider subscriptions --------------------------------------------------------------
// The sandbox's translator (CLIProxyAPI) serves Codex/Grok/Kimi/Google models to the Claude Code harness on the
// user's subscription OAuth, a credential of its own, separate from a provider's native-harness
// account (each program owns and refreshes its own grant; a shared refresh token would rotate out from under
// one of them). The connection state itself lives in conversation.ts beside providerAccounts (so access.ts can
// derive from both without a cycle); what stays here is the login flow it is driven by, held outside
// SandboxAgent so a device-login poll survives that tab unmounting.
// The in-flight subscription login the Agent tab's routed row shows. Device flows may carry a one-time `code`;
// redirect flows ask the user to paste the URL they landed on and `completeTranslator` finishes it against
// `state`. `baseline` is how many accounts
// the provider held when the login started, a provider can hold several, so "connected" is the count GROWING
// past it, not the provider being truthy (which an "add another account" login already is from the start).
export const translatorConnectFlow = ref<
    { provider: KeyedProvider; url: string; code: string; state: string; flow: "device" | "redirect"; baseline: number } | undefined
>(undefined);

/* A routed row's key. Namespaced away from the provider id on purpose: under Grok the native xAI account and
 * the translator subscription are two connections of the SAME provider, sitting one above the other, and keying
 * both as `grok` made a click on either spin both their buttons. With `name`, one specific subscription (auth
 * file names are unique per provider, not across them); without it, that provider's sign-in. */
export const translatorKey = (target: AgentProvider, name?: string): string => `translator:${target}${name === undefined ? `` : `:${name}`}`;
let translatorPollTimer: ReturnType<typeof setTimeout> | undefined;

// What an expired sign-in names itself in the sentence that reports it. The provider's own account label, not a
// fourth chain of ternaries: the one this replaced fell through to "Google" for anything it did not name, so a
// routed provider added tomorrow would have reported its own timeout as Google's.
const translatorProviderLabel = (target: KeyedProvider): string => providerSpec(target)?.accountLabel ?? target;

// CLIProxyAPI finishes every routed login in the background, the device flows poll upstream on their own, and
// a redirect flow resumes the moment `completeTranslator` hands it the pasted URL, so in both cases the UI just
// polls the connection state until the provider flips connected, bounded by the device flows' deadline.
const pollTranslatorOnce = async (target: KeyedProvider, deadline: number): Promise<void> => {
    if (translatorConnectFlow.value?.provider !== target) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The ${translatorProviderLabel(target)} sign-in expired: start the connection again.`;
        translatorConnectFlow.value = undefined;
        return;
    }
    await refreshTranslatorAccounts();
    const flow = translatorConnectFlow.value;
    if (flow?.provider !== target) {
        return;
    }
    if (translatorAccounts.value[target].length > flow.baseline) {
        translatorConnectFlow.value = undefined;
        error.value = null;
        return;
    }
    translatorPollTimer = setTimeout(() => void pollTranslatorOnce(target, deadline), 3_000);
};

// Start a subscription login for a routed provider: the daemon returns the sign-in URL and, for the providers
// that mint one, a one-time code. The user approves upstream and the poll flips the row to connected. One flow
// at a time, a new connect supersedes a prior one (mirroring the daemon, which kills a superseded subprocess).
export const connectTranslator = async (target: KeyedProvider): Promise<void> => {
    if (accountBusy.value !== undefined) {
        return;
    }
    accountBusy.value = translatorKey(target);
    error.value = null;
    clearTimeout(translatorPollTimer);
    try {
        translatorConnectFlow.value = {
            provider: target,
            baseline: translatorAccounts.value[target].length,
            ...(await sandboxJson<{ url: string; code: string; state: string; flow: "device" | "redirect" }>(`/translator/${target}/connect`, {
                method: `POST`,
            })),
        };
        translatorPollTimer = setTimeout(() => void pollTranslatorOnce(target, Date.now() + CODEX_POLL_DEADLINE_MS), 3_000);
    } catch (caught) {
        error.value = errorMessage(caught, `Could not start the subscription connection: is your sandbox online?`);
    } finally {
        accountBusy.value = undefined;
    }
};

// Finish a redirect login by handing the daemon the URL the provider sent the browser to. Google's sign-in ends
// on a loopback address only the sandbox container binds, so the page never loads for the user, but the address
// bar still carries the grant, which is what they paste here. The translator then resumes the exchange on its
// own, so success just means "keep polling"; the row flips connected on the next poll.
export const completeTranslator = async (redirectUrl: string): Promise<void> => {
    const flow = translatorConnectFlow.value;
    if (flow === undefined || flow.flow !== `redirect`) {
        return;
    }
    accountBusy.value = translatorKey(flow.provider);
    error.value = null;
    try {
        await sandboxJson(
            `/translator/${flow.provider}/complete`,
            jsonBody(`POST`, { provider: flow.provider, redirectUrl: redirectUrl.trim(), state: flow.state }),
        );
        await refreshTranslatorAccounts();
    } catch (caught) {
        error.value = errorMessage(caught, `That sign-in link could not be completed: copy the whole URL and try again.`);
    } finally {
        accountBusy.value = undefined;
    }
};

// Drop ONE of the provider's connected accounts, addressed by its translator auth-file name.
export const disconnectTranslator = async (target: KeyedProvider, name: string): Promise<void> => {
    accountBusy.value = translatorKey(target, name);
    try {
        await sandboxRequest(`/translator/${target}/disconnect`, jsonBody(`POST`, { provider: target, name }));
        if (translatorConnectFlow.value?.provider === target) {
            clearTimeout(translatorPollTimer);
            translatorConnectFlow.value = undefined;
        }
        await refreshTranslatorAccounts();
    } finally {
        accountBusy.value = undefined;
    }
};

// Abandon an in-flight subscription login. Dropping the flow is enough to stop its poll (every tick returns
// early once the flow it was started for is gone), but the pending timer is cleared too so a superseded tick
// can't fire against a row the user has moved on from.
export const cancelTranslatorConnect = (): void => {
    clearTimeout(translatorPollTimer);
    translatorConnectFlow.value = undefined;
};

/* The in-flight NATIVE sign-in (Claude / Grok), held between start and completion. It shares the fields the card
 * renders with translatorConnectFlow above; the translator's extra flow discriminator stays at that boundary.
 *
 * It carries the PROVIDER it belongs to, which is what lets a handshake outlive a look at another tab: the flow
 * unfolds under the row that started it and nowhere else, so browsing the switcher can neither smear a Grok
 * device code onto Claude's row nor force us to kill a sign-in the user is still completing at x.ai.
 *
 * `code` is the device code to approve upstream (Grok's, pre-filled at x.ai); it is empty for the flow that
 * hands the user something to paste back instead (Claude's authorization code). `pkce` is
 * Claude's verifier/state round-trip, carried to completeConnect and to nothing else. */
interface NativeConnectFlow {
    readonly provider: AgentProvider;
    readonly url: string;
    readonly code: string;
    readonly pkce?: { readonly verifier: string; readonly state: string };
    /* Cursor and the minted providers: the attempt's id, so abandoning the card also stops the daemon polling
     * upstream for a sign-in nobody is going to complete. Not a credential and not redeemable — the proof that
     * finishes the sign-in never leaves the sandbox — which is exactly why it can sit on this shape when `pkce`
     * above could not have. */
    readonly handshake?: string;
    /* Minted providers only: how this sign-in ENDS, which is the one thing the panel cannot infer from the
     * fields above. Meta polls itself to completion; BigModel dead-ends on a loopback address the user brings
     * back. Both are the same provider row and the same store, so the shape is on the flow rather than the
     * provider. Absent ⇒ the older shapes, which the panel reads the way it always has. */
    readonly flow?: `device` | `redirect`;
    // Minted redirect only: the marker the landing address carries, so a pasted URL can be recognised as this
    // attempt's before it is sent anywhere.
    readonly state?: string;
    // Minted only: which of the provider's estates this attempt signed in to, for the line the panel shows
    // while a two-estate provider is waiting.
    readonly variant?: string;
}
export const nativeConnectFlow = ref<NativeConnectFlow | undefined>(undefined);
// The display label the user typed for the account being connected (blank ⇒ the daemon derives one from the
// sign-in identity or a provider default). Bound by the account panel; read when a connect completes.
export const connectLabel = ref(``);

// Device-code sign-in expires after 15 minutes; stop polling past it.
const CODEX_POLL_DEADLINE_MS = 15 * 60 * 1000;
let nativePollTimer: ReturnType<typeof setTimeout> | undefined;

/* Drop any in-progress handshake: clear the poll timer and the connect UI state. Safe to call repeatedly.
 *
 * A flow that HAS A HANDSHAKE gets one extra step, and Cursor and the minted providers are those: the handshake
 * is a POLL RUNNING IN THE DAEMON, not in this tab, so closing the card would otherwise leave the sandbox
 * asking upstream about a sign-in nobody is completing for the next eighteen minutes. Keyed off the handshake
 * rather than off a provider name, so a fourth flow of this shape is cancelled the day it is added.
 * Fire-and-forget: the attempt expires on its own anyway, so a failed cancel costs nothing worth reporting. */
export const cancelConnect = (): void => {
    if (nativePollTimer !== undefined) {
        clearTimeout(nativePollTimer);
        nativePollTimer = undefined;
    }
    const flow = nativeConnectFlow.value;
    if (flow?.handshake !== undefined) {
        void sandboxRequest(`${providerBase(flow.provider)}/login/cancel`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ handshake: flow.handshake }),
        }).catch(() => undefined);
    }
    nativeConnectFlow.value = undefined;
    connectLabel.value = ``;
};

/* One tick of a NO-PASTE sign-in's poll. Two providers use it and they finish out-of-band for different
 * reasons: OpenCode completes the xAI token exchange itself on approval, and the daemon completes Cursor's PKCE
 * exchange itself (its verifier must never reach this tab). Either way the question this asks is the same one
 * — has an account appeared yet — which is why it is one function taking the provider rather than two nearly
 * identical ones. A paste-back method (Claude's) finishes via completeConnect instead and never polls.
 *
 * Supersession is checked against the flow OBJECT the tick was started for, so a restarted or cancelled
 * handshake retires the ticks of the old one rather than racing them. */
const pollNativeOnce = async (target: AgentProvider, deadline: number): Promise<void> => {
    const flow = nativeConnectFlow.value;
    if (flow?.provider !== target) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The ${providerLabel(target)} sign-in expired: start the connection again.`;
        cancelConnect();
        return;
    }
    try {
        const connectedAccounts = await refreshAccounts(target, false);
        if (nativeConnectFlow.value !== flow) {
            return;
        }
        if (connectedAccounts.length > 0) {
            cancelConnect();
            error.value = null;
            // The account just connected, load its model catalog now so the picker is populated immediately,
            // not only after the next reselect or reload.
            void loadProviderModels(target);
            return;
        }
    } catch {
        // Transient (sandbox blip); keep polling until the deadline.
    }
    if (nativeConnectFlow.value !== flow) {
        return;
    }
    nativePollTimer = setTimeout(() => void pollNativeOnce(target, deadline), 3000);
};

// Step 1 of a NATIVE connect. Claude mints an authorize URL + PKCE challenge; Grok mints a one-time device code
// and starts its poll loop. Routed subscription connects, including Kimi Code, use connectTranslator above.

// Started by the row's own Connect button (never by a provider switch, see setManagedProvider), so the whole
// handshake is a thing the user asked for. `accountBusy` holds the provider for the length of the round-trip:
// that is the click's acknowledgement, and it is why the sign-in can only ever REPLACE the button that started
// it rather than appear next to a button still inviting the same click.
export const startConnect = async (variant?: string): Promise<void> => {
    const target = managedProvider.value;
    if (accountBusy.value !== undefined) {
        return;
    }
    cancelConnect();
    error.value = null;
    // Busy for the WHOLE start, not just the fetch: clearing it a parse earlier would drop the button back to
    // "Connect" for a tick before the flow lands under it, the very blink this is here to remove.
    accountBusy.value = target;
    try {
        const path = connectStartPath(target);
        let response: Response;
        try {
            // The estate to sign in to, for a provider that sells through more than one (Z.ai). Absent takes the
            // provider's default, which is what every single-estate row sends.
            response = await sandboxRequest(path, isMinted(target) ? jsonBody(`POST`, variant === undefined ? {} : { variant }) : { method: `POST` });
        } catch (err) {
            error.value = errorMessage(err, `Could not start the ${providerLabel(target)} connection: is your sandbox online?`);
            return;
        }
        if (!response.ok) {
            error.value = (await sandboxError(response, { method: `POST`, path })).message;
            return;
        }
        if (target === `grok`) {
            // xAI's headless device-code flow: the URL is x.ai's verification page with the code pre-filled, so
            // the user just opens it and approves (no paste-back). `code` is that same pre-filled code, shown
            // for reassurance. OpenCode polls to completion, we poll /grok/accounts until connected.
            const body = (await response.json()) as { url: string; code: string };
            nativeConnectFlow.value = { provider: `grok`, url: body.url, code: body.code };
            nativePollTimer = setTimeout(() => void pollNativeOnce(`grok`, Date.now() + CODEX_POLL_DEADLINE_MS), 3000);
            return;
        }
        if (isMinted(target)) {
            /* A MINTED SIGN-IN, both shapes at once, because the daemon answers the same body for either and the
             * shape is on it (`flow`). The panel reads that field to decide whether it is a read-only card or one
             * with an address to bring back; this side treats them alike in the one way that matters — the POLL
             * IS ARMED EITHER WAY. A device sign-in finishes upstream; a redirect one finishes when the pasted
             * address delivers the grant and the daemon goes on to mint. Neither hands the account back on a
             * response, so both learn it worked from the same place: a row appearing in the account list.
             *
             * The deadline comes off the wire rather than the shared 15-minute constant, for the reason Cursor's
             * does: the daemon's attempt is the one that actually expires, and a card that gave up first would
             * report an abandoned sign-in that is still live. */
            const body = (await response.json()) as {
                url: string;
                code: string;
                state: string;
                flow: `device` | `redirect`;
                variant: string;
                handshake: string;
                expiresAt: number;
            };
            nativeConnectFlow.value = {
                provider: target,
                url: body.url,
                code: body.code,
                state: body.state,
                flow: body.flow,
                variant: body.variant,
                handshake: body.handshake,
            };
            nativePollTimer = setTimeout(() => void pollNativeOnce(target, body.expiresAt), 3000);
            return;
        }
        if (target === `cursor`) {
            /* Cursor's page is already addressed to this attempt, so there is NO code to show and nothing to
             * paste back: the daemon holds the redeemable half and completes the exchange itself. The card is
             * therefore the URL alone, and the poll below is how this tab learns it worked.
             *
             * Its own deadline comes off the wire (`expiresAt`) rather than the shared 15-minute constant,
             * because the daemon's poll is the one that actually expires and a card that gave up first would
             * report an abandoned sign-in that was still live. */
            const body = (await response.json()) as { url: string; handshake: string; expiresAt: number };
            nativeConnectFlow.value = { provider: `cursor`, url: body.url, code: ``, handshake: body.handshake };
            nativePollTimer = setTimeout(() => void pollNativeOnce(`cursor`, body.expiresAt), 3000);
            return;
        }
        const body = (await response.json()) as { authorizeUrl: string; verifier: string; state: string };
        nativeConnectFlow.value = { provider: `claude`, url: body.authorizeUrl, code: ``, pkce: { verifier: body.verifier, state: body.state } };
    } finally {
        accountBusy.value = undefined;
    }
};

/* Point the account card at the provider the active conversation would send to, what it shows when it opens.
 * Skipped while a sign-in is in flight: that handshake (a device poll can outlive the card being closed and the
 * reachable-flash remounting it) owns what the card is looking at, and moving to another provider's rows would
 * hide the code the user is in the middle of approving.
 *
 * Nothing here tears a handshake down, and nothing does on the way out either, there is no "close" hook at all.
 * The Grok device flow completes out-of-band (the user approves at x.ai and the daemon exchanges tokens
 * server-side later), so cancelConnect stays the sole teardown, driven only by genuine invalidation:
 * completion (pollGrokOnce), the 15-minute deadline, a fresh startConnect, the user's own Cancel, or resetChat. */
export const showActiveProvider = (): void => {
    if (nativeConnectFlow.value === undefined && translatorConnectFlow.value === undefined) {
        managedProvider.value = active.value.provider.value;
    }
};

/* Step 2 of a native paste-back connect: hand back what the provider gave the user. Grok and Cursor complete
 * via their device poll loops; routed redirects complete through completeTranslator.
 *
 * TWO PASTE-BACKS, AND THEY END DIFFERENTLY, which is the whole reason this branches rather than taking one
 * path. Anthropic's exchange ANSWERS with the account, so this lands it and stops. A minted provider's redirect
 * only DELIVERS THE GRANT: the daemon still has an exchange and a mint to do behind the answer, so all this can
 * report is that the address was accepted, and the poll already running from `startConnect` is what turns it
 * into a row. Treating the second like the first would clear the card while the sign-in was still working, and
 * a failure minutes later would have nowhere to land. */
const deliverMintedGrant = async (flow: NativeConnectFlow & { readonly handshake: string }, redirectUrl: string): Promise<boolean> => {
    const path = `${providerBase(flow.provider)}/login/complete`;
    let response: Response;
    try {
        response = await sandboxRequest(path, jsonBody(`POST`, { handshake: flow.handshake, redirectUrl }));
    } catch (err) {
        error.value = errorMessage(err, `Could not finish the ${providerLabel(flow.provider)} sign-in: is your sandbox online?`);
        return false;
    }
    if (!response.ok) {
        // The daemon's own words: a state that belongs to another attempt, an address the vendor put an error
        // in, and an address with no code at all send the user somewhere different, and only it knows which
        // happened.
        error.value = (await sandboxError(response, { method: `POST`, path })).message;
        return false;
    }
    // The flow STAYS UP: the mint is still running, and the poll that has been ticking since `start` is what
    // clears the card when the account lands.
    error.value = null;
    return true;
};

export const completeConnect = async (code: string): Promise<boolean> => {
    const flow = nativeConnectFlow.value;
    accountBusy.value = flow?.provider;
    try {
        if (flow?.flow === `redirect` && flow.handshake !== undefined) {
            return await deliverMintedGrant({ ...flow, handshake: flow.handshake }, code);
        }
        if (flow?.pkce === undefined) {
            error.value = `Start the connection first.`;
            return false;
        }
        let response: Response;
        try {
            response = await sandboxRequest(
                `/claude/oauth/exchange`,
                jsonBody(`POST`, { code, ...flow.pkce, label: connectLabel.value.trim() || undefined }),
            );
        } catch {
            error.value = `Could not connect your Claude account: check the code and try again.`;
            return false;
        }
        if (!response.ok) {
            error.value = `Could not connect your Claude account: check the code and try again.`;
            return false;
        }
        addAccount(`claude`, (await response.json()) as OauthAccount);
        cancelConnect();
        error.value = null;
        // The account just connected, supportedModels() needs a Claude credential, so the catalog may only now
        // be discoverable.
        void loadProviderModels(`claude`);
        return true;
    } finally {
        accountBusy.value = undefined;
    }
};

// A singleton per window (hotReload.ts): a hot update that re-ran this module would mint a second sign-in flow
// beside the one the rest of the app still reads.
reloadOnHotUpdate(import.meta);
