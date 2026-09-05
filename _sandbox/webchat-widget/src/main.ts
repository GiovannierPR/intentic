import { embedEndpointOf, embedScript } from "@intentic/sandbox-contract/embed";
import { FrontDeskElement } from "./element.js";
import { fetchConfig } from "./transport.js";

/* The embed's entry point. One <script> on a customer's page:
 *
 *   <script src="https://sandbox-<id>.<zone>/webchat/widget.js" data-automation="support" defer></script>
 *
 * Everything else is derived by the contract's embed helpers: the daemon to talk to is the origin this script
 * came from, `data-base` overrides it for a site fronting the sandbox behind its own proxy. */

const TAG = "intentic-front-desk";

// Read at module scope, while the script body is executing (embedScript says why).
const ownScript = embedScript("/webchat/widget.js");

const boot = async (script: HTMLScriptElement): Promise<void> => {
    const endpoint = embedEndpointOf(script);
    if (endpoint === undefined) {
        // The one mistake worth a console line: without it the widget is silently absent and the site owner has
        // nothing to go on. Every other failure surfaces inside the panel, where the visitor can see it.
        console.error(`[intentic] the Front Desk embed needs data-automation="<automation id>"`);
        return;
    }

    // The config fetch is also the reachability probe: a sandbox that is asleep, an automation that was
    // deleted, or an origin that isn't on the allowlist all land here, and in every one of those cases the
    // right thing is to render NOTHING. A launcher that opens onto an error is worse than no launcher.
    const config = await fetchConfig(endpoint).catch((error: unknown) => {
        console.error(`[intentic] Front Desk is unavailable:`, error);
        return undefined;
    });
    if (config === undefined) {
        return;
    }

    if (customElements.get(TAG) === undefined) {
        customElements.define(TAG, FrontDeskElement);
    }
    const element = document.createElement(TAG) as FrontDeskElement;
    element.configure(config, endpoint);
    document.body.append(element);
};

if (ownScript === null) {
    console.error(`[intentic] the Front Desk embed could not find its own <script> tag`);
} else {
    void boot(ownScript);
}
