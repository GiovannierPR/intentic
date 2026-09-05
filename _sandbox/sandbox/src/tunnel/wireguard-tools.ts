import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { toolMissing } from "./net-probe.js";

/* wg-quick, as both tunnel kinds drive it. A WireGuard dial is synchronous (wg-quick returns once the interface
 * is configured), so there is no client process to supervise: the interface IS the tunnel, `wg show` is the
 * liveness answer, and the conf is dialled by PATH so nothing ever has to live in /etc/wireguard. */

const exec = promisify(execFile);

// `wg show <if>` succeeds only for an existing WireGuard interface.
export const wireguardUp = async (name: string): Promise<boolean> =>
    exec("wg", ["show", name]).then(
        () => true,
        () => false,
    );

// wg-quick is the one executable that must exist to dial; it arrives with the capability's image fragment,
// and until then a link reads "unavailable" rather than failing.
export const wireguardMissing = async (): Promise<string | undefined> => ((await toolMissing("wg-quick", ["--help"])) ? "wg-quick" : undefined);

// The [Peer] Endpoint, for display and labelling. Parsed leniently: a conf with no endpoint (a peer that only
// ever dials in) is legal, so a missing label is not worth failing over.
export const wireguardEndpoint = (conf: string): string | undefined => /^\s*Endpoint\s*=\s*(\S+)/im.exec(conf)?.[1];

// The conf holds the interface's private key: 0600 in a 0700 directory, and only its PATH ever reaches a
// command line, so no key appears in argv or in `ps`.
export const writeWireguardConf = async (path: string, conf: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, conf.endsWith("\n") ? conf : `${conf}\n`, { mode: 0o600 });
};

export const wireguardDial = async (confPath: string): Promise<void> => {
    await exec("wg-quick", ["up", confPath]);
};

// Already down, no conf yet, no wg-quick installed: all reduce to "not up", which is the goal state.
export const wireguardDrop = async (confPath: string): Promise<void> => {
    await exec("wg-quick", ["down", confPath]).catch(() => undefined);
};
