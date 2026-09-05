import { rm } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import type { IntenticLine, VpnConfig, VpnLink } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { notCarriedYet, type TunnelEntry, tunnelEntries } from "../tunnel/tunnel-links.js";
import { markUp, upSince } from "../tunnel/tunnel-state.js";
import { vpnDrivers } from "./vpn-drivers.js";
import { upMarkerPath, vpnDir } from "./vpn-paths.js";

// The one place the manifest ("which VPNs exist") is joined to the machine ("which are up"). Everything that
// can dial a tunnel, the VPN capability card, the `vpn` CLI on the agent's PATH, the capability handler's
// apply, and the boot restore, goes through these three functions, so there is exactly one definition of what
// connecting means and no surface can drift from another.

export type VpnEntry = TunnelEntry<VpnConfig>;

// One configured VPN as the UI and the CLI see it: manifest intent plus whatever the OS reports right now.
export const vpnLink = async (entry: VpnEntry): Promise<VpnLink> => {
    const driver = vpnDrivers[entry.config.provider];
    const probe = await driver.probe(entry.id, entry.config);
    const gateway = driver.gateway(entry.config);
    return {
        id: entry.id,
        provider: entry.config.provider,
        state: probe.state,
        autoConnect: entry.config.autoConnect === "on",
        routes: [...(probe.routes ?? [])],
        // Only a connected link's resolvers are its own: /etc/resolv.conf is global, so attributing it to a
        // tunnel that is down would be a lie.
        dns: probe.state === "connected" ? [...(probe.dns ?? [])] : [],
        ...(gateway === undefined ? {} : { gateway }),
        ...(probe.interface === undefined ? {} : { interface: probe.interface }),
        ...(probe.address === undefined ? {} : { address: probe.address }),
        ...(probe.detail === undefined ? {} : { detail: probe.detail }),
        ...(probe.state === "connected" ? { since: await upSince(upMarkerPath(entry.id)) } : {}),
    };
};

// Every configured VPN with its live state, probed concurrently (the capabilities list's precedent).
export const vpnLinks = async (capabilities: CapabilitiesStore): Promise<VpnLink[]> =>
    Promise.all(tunnelEntries(await capabilities.list(), "vpn").map((entry) => vpnLink(entry)));

// Dial one tunnel, streaming the client's progress. The up marker is written only after the driver reports
// success, so its presence never contradicts a probe.
export async function* connectVpn(entry: VpnEntry, options: { readonly otp?: string | undefined } = {}): AsyncGenerator<IntenticLine> {
    const driver = vpnDrivers[entry.config.provider];
    const missing = await driver.missingTool();
    if (missing !== undefined) {
        throw notCarriedYet(missing, "vpn");
    }
    yield* driver.connect(entry.id, entry.config, options);
    await markUp(vpnDir(), upMarkerPath(entry.id));
}

// Drop one tunnel. Tolerant by contract: the goal state is "not up", so an already-down tunnel is a success.
export const disconnectVpn = async (entry: VpnEntry): Promise<void> => {
    await vpnDrivers[entry.config.provider].disconnect(entry.id, entry.config);
    await rm(upMarkerPath(entry.id), { force: true });
};

// Boot restore: tunnels die with the container while the manifest survives on /work, so main.ts re-dials every
// VPN the user left on auto-connect. Best-effort, a dead gateway must not take the daemon down; the failure
// lands in the link's state and the daemon log.
export const reconnectVpns = async (
    capabilities: CapabilitiesStore,
    logger: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> => {
    for (const entry of tunnelEntries(await capabilities.list(), "vpn")) {
        if (entry.config.autoConnect !== "on") {
            continue;
        }
        const probe = await vpnDrivers[entry.config.provider].probe(entry.id, entry.config);
        if (probe.state === "connected" || probe.state === "connecting") {
            continue;
        }
        try {
            for await (const line of connectVpn(entry)) {
                void line;
            }
            logger.info(`vpn ${entry.id}: reconnected`);
        } catch (error) {
            logger.warn(`vpn ${entry.id}: could not reconnect: ${errorMessage(error)}`);
        }
    }
};
