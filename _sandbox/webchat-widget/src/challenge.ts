/* The second flavour of the bot ceiling: Cloudflare Turnstile. The first, the proof of work, is every embed's
 * and lives in the contract (embed.ts); this one is the Front Desk's alone, because it needs the site's own keys.
 * Both produce ONE token spent on the first message of a visitor thread, a per-message challenge would be a
 * per-message interruption, and the rate limit is what bounds a thread that has already been admitted.
 *
---- Cloudflare Turnstile ----
 *
 * Rendered explicitly into a container the widget slots from the light DOM, for the same reason as Google's
 * button: it is a third-party iframe and belongs in the document. The SECRET half never appears here, the
 * daemon verifies the token against siteverify. */

interface Turnstile {
    render: (container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "error-callback": () => void }) => void;
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let turnstileLoad: Promise<Turnstile> | undefined;

const loadTurnstile = async (): Promise<Turnstile> => {
    turnstileLoad ??= new Promise<Turnstile>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = TURNSTILE_SRC;
        script.async = true;
        script.addEventListener("load", () => {
            const turnstile = (window as unknown as { turnstile?: Turnstile }).turnstile;
            if (turnstile === undefined) {
                reject(new Error("The bot check failed to load"));
                return;
            }
            resolve(turnstile);
        });
        script.addEventListener("error", () => reject(new Error("The bot check failed to load")));
        document.head.append(script);
    });
    return turnstileLoad;
};

export const solveTurnstile = async (container: HTMLElement, siteKey: string): Promise<string> => {
    const turnstile = await loadTurnstile();
    return new Promise<string>((resolve, reject) => {
        turnstile.render(container, {
            sitekey: siteKey,
            callback: resolve,
            "error-callback": () => reject(new Error("Bot check failed. Reload the page.")),
        });
    });
};
