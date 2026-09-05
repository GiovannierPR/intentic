import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ScopeError } from "../policy.js";
import { destructiveClasses, runCommand } from "./shell.js";

/* THE GAP THIS CLOSES, as a test. `shell` used to be the whole question: a command was checked for WHERE it
 * would start (its cwd, against the roots) and never for WHAT it would do. So an agent told it could run
 * commands on somebody's laptop could run `rm -rf ~/projects` with that person's own privileges, and the
 * sandbox's command gate never saw it, because that gate hooks Bash and the JS backend while this arrives as
 * an MCP tool call on a different machine entirely.
 *
 * These tests run REAL commands, deliberately harmless ones, because the refusal has to happen before the
 * spawn and the only honest way to show that is to hand it something that would otherwise succeed. */

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({
    shell: "on",
    write: "off",
    screen: "on",
    control: "off",
    sandboxes: "off",
    sandboxRemove: "off",
    destructive: "off",
    roots: "/tmp",
    ...overrides,
});

test("a destructive command is refused when only `shell` is on", async () => {
    await expect(runCommand({ command: "rm -rf /tmp/does-not-exist" }, scopes())).rejects.toThrow(ScopeError);
});

// The refusal has to name the switch, or the user is told only that something was blocked and has nowhere to go.
test("the refusal names the switch and what the command would have done", async () => {
    await expect(runCommand({ command: "rm -rf /tmp/does-not-exist" }, scopes())).rejects.toThrow(/Run destructive commands/);
    await expect(runCommand({ command: "mkfs.ext4 /dev/sda1" }, scopes())).rejects.toThrow(/wipe a disk/);
});

/* Read BEFORE the cwd is resolved. A destructive command aimed outside the roots used to be refused for the
 * cwd, whose message sends somebody to widen "Folders it may touch": the opposite of the change they want. */
test("a destructive command outside the roots is refused for what it does, not for where it starts", async () => {
    const failure = await runCommand({ command: "rm -rf /etc", cwd: "/etc" }, scopes()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScopeError);
    expect(String(failure)).toContain("Run destructive commands");
    expect(String(failure)).not.toContain("Folders it may touch");
});

test("turning the switch on lets the same command through", async () => {
    const result = await runCommand({ command: "rm -rf /tmp/intentic-shell-test-absent" }, scopes({ destructive: "on" }));
    expect(result.exitCode).toBe(0);
});

// The whole point of one extra switch rather than five: a connected device stays useful with it off.
test("ordinary work is untouched by the switch", async () => {
    const result = await runCommand({ command: "echo hello" }, scopes());
    expect(result.stdout.trim()).toBe("hello");
});

/* Only the classes that DESTROY something are gated here. Reading a dotenv, publishing a package and reaching
 * the network are the sandbox rulebook's to hold, with a card and a person to answer it; re-asking them on the
 * machine, where a refusal is the only available answer, would make a connected laptop useless. */
test("the other classes are the sandbox's to judge, not this machine's", () => {
    expect(destructiveClasses("cat .env")).toEqual([]);
    expect(destructiveClasses("npm publish")).toEqual([]);
    expect(destructiveClasses("curl https://api.github.com/user")).toEqual([]);
    expect(destructiveClasses("git push --force origin main")).toEqual([]);
});

test("every deletion class is gated, and a root delete is in two of them", () => {
    expect(destructiveClasses("rm -rf build")).toEqual(["files.destructive"]);
    expect(destructiveClasses("rm -rf ~")).toEqual(["files.destructive", "system.destructive"]);
});

/* A CONTAINER VOLUME IS ITS OWN CLASS as of the locus split, and it stays gated HERE while the sandbox hands
 * it to the judge — which is the split working rather than a hole. In this container the reachable volumes are
 * the nested engine's, so they are dev databases the agent made; on somebody's own computer a named volume IS
 * the database, and the scope switch is the thing that decides. */
test("a container volume still needs the destructive switch on a real machine", () => {
    expect(destructiveClasses("docker volume rm app_data")).toEqual(["container.state"]);
    expect(destructiveClasses("docker compose down -v")).toEqual(["container.state"]);
});

/* READ AT THE `device` LOCUS, which is the other half of the split: `~` and `C:` are roots on somebody's
 * computer and scratch in a container, and this file is only ever asked about the former. */
test("a device's roots are the device's, not the sandbox's", () => {
    for (const command of ["rm -rf /usr", "rm -rf /etc", "rm -rf C:\\", "rm -rf /Users"]) {
        expect(destructiveClasses(command), command).toContain("system.destructive");
    }
});

/* A COMMAND THAT ONLY MENTIONS A DELETE DOES NOT NEED THE SWITCH. It never did anything but refuse, and the
 * refusal taught people to leave `destructive` on permanently — which is the opposite of what it is for. */
test("a delete that is printed, searched for or commented is not gated", () => {
    for (const command of [`echo "rm -rf ~" >> notes.md`, `grep -n "rm -rf" scripts/deploy.sh`, `ls # not rm -rf ~`]) {
        expect(destructiveClasses(command), command).toEqual([]);
    }
});

// `shell` still comes first: a machine that may not run commands at all is not asked what kind of command it is.
test("the shell switch is still the outer question", async () => {
    await expect(runCommand({ command: "echo hello" }, scopes({ shell: "off" }))).rejects.toThrow(/Run commands/);
});
