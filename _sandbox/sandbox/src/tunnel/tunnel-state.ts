import { mkdir, stat, writeFile } from "node:fs/promises";

/* The up marker: touched when a tunnel comes up, removed when it goes down, its mtime the "up since" a card
 * shows. ADVISORY ONLY, and both kinds hold to it: liveness is always read off the machine by the driver's
 * probe, so a tunnel raised outside the daemon shows no uptime rather than a wrong state, and a missing marker
 * costs a label, never a fact. */

export const upSince = async (marker: string): Promise<number | undefined> => (await stat(marker).catch(() => undefined))?.mtimeMs;

// The directory is created here with its MODE, 0700, so what a tunnel remembers is readable by the daemon's own
// user alone; a later mkdir on an existing directory is a no-op that leaves that mode standing.
export const markUp = async (dir: string, marker: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(marker, "", { mode: 0o600 });
};
