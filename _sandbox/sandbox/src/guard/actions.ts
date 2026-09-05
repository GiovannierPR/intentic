import {
    type AdmissionPolicy,
    type AdmissionRule,
    COMMAND_CLASS_LABELS,
    type CommandClass,
    type CommandLocus,
    hardRuleClasses,
    type Trigger,
    type WakeSource,
} from "@intentic/sandbox-contract";
import { ALLOW, DENY, defineGuardedAction, HOLD } from "./guard.js";

/* The action catalog, every gated decision, defined once at this module edge and consulted by value.
 *
 * Policy rides IN as input (the settings snapshot the caller read) rather than being fetched here: the decides
 * stay pure, so the whole matrix is testable without a workspace, and a consult site can never observe a
 * different policy than the one it logs.
 */

/* Which admission-floor key a wake falls under, from the automation's trigger. Two listener providers are their
 * own source and everything else shares the "listener" rule, because those two are the ones a STRANGER can
 * reach without the owner having wired anything:
 *
 *   webchat  a visitor on a public widget, which is not the same trust as a Discord channel the owner set up.
 *   issues   a crash report from any browser on a site the owner listed, and the one whose floor is `hold`
 *            rather than `allow` (AdmissionPolicySchema argues why): the toolbox a bug-fix turn needs is the
 *            opposite of the Front Desk persona's, and the brief is a stack trace somebody else's machine wrote.
 */
export const wakeSourceOf = (trigger: Trigger): WakeSource => {
    switch (trigger.kind) {
        case "schedule":
            return "schedule";
        case "event":
            return "event";
        case "listener":
            return LISTENER_SOURCES[trigger.provider] ?? "listener";
        case "workspace":
            return "workspace";
    }
};

// The listener providers that carry their own admission floor. A map rather than a chain of ternaries: the next
// one added is a line here, and the set is small and closed on purpose.
const LISTENER_SOURCES: Readonly<Record<string, WakeSource>> = { webchat: "webchat", issues: "issues" };

export interface SessionStartInput {
    readonly source: WakeSource;
    readonly admission: AdmissionPolicy;
    // The per-automation overrides, absent for doors that have none (the workflow release gate).
    readonly requireApproval?: boolean;
    readonly holdForSeconds?: number;
}

/* May this wake open (or continue) a session? Most-restrictive-wins across the floor and the per-object
 * overrides: deny beats hold beats the countdown beats allow. Only the pure `holdForSeconds` hold carries an
 * autoRun countdown, a hold the floor or `requireApproval` asked for is "ask me", and "ask me" must never
 * become "unless I'm slow". */
export const sessionStart = defineGuardedAction<SessionStartInput>({
    action: "session.start",
    decide: ({ source, admission, requireApproval, holdForSeconds }) => {
        const floor = admission[source];
        if (floor === "deny") {
            return DENY(`${source} sessions are refused by the admission policy`);
        }
        if (requireApproval === true) {
            return HOLD("this automation asks for approval on every wake");
        }
        if (floor === "hold") {
            return HOLD(`${source} sessions are held for approval by the admission policy`);
        }
        if (holdForSeconds !== undefined) {
            return HOLD(`held for ${holdForSeconds}s unless approved or rejected first`, holdForSeconds);
        }
        return ALLOW(`admission policy allows ${source} sessions`);
    },
});

export interface OutboundSendInput {
    // The sniffer's classification of the call (activity/outbound.ts matchers): "discord" + "message.send".
    readonly provider: string;
    readonly type: string;
    // SandboxSettings.actionRules, exact `<provider>.<type>` key wins over the `<provider>.*` wildcard.
    readonly rules: Readonly<Record<string, AdmissionRule>>;
}

/* May this in-turn provider call run? Consulted by the PreToolUse outbound gate BEFORE the command executes,
 * the enforcing twin of the activity sniffer's after-the-fact audit. A "hold" cannot park a running turn
 * (automation turns run unattended; nobody may be there to answer), so the gate translates it into a refusal
 * that points at the approvals queue, a post awaiting owner approval IS the held form of a send. */
export const outboundSend = defineGuardedAction<OutboundSendInput>({
    action: "outbound.send",
    decide: ({ provider, type, rules }) => {
        const rule = rules[`${provider}.${type}`] ?? rules[`${provider}.*`] ?? "allow";
        if (rule === "deny") {
            return DENY(`${provider} ${type} is refused by the action rules`);
        }
        if (rule === "hold") {
            return HOLD(`${provider} ${type} requires owner approval`);
        }
        return ALLOW(`no action rule restricts ${provider} ${type}`);
    },
});

export interface CommandRunInput {
    // ONE of the classes the command fell in (sandbox-contract's command-classes.ts). A command in two classes is two
    // consults, and the gate keeps the most restrictive answer, which is what makes "most restrictive wins"
    // observable at the consult site instead of hidden inside a decide that was handed a list.
    readonly commandClass: CommandClass;
    /* WHICH MACHINE would run it. The hard rule is a different set per locus (contract safety-policy.ts
     * hardRuleClasses argues both), so this is not decoration: the same class is held in one place and judged
     * in the other. `sandbox` for this container's own shell, `device` for a command headed down the tunnel to
     * one of the owner's computers. */
    readonly locus: CommandLocus;
    /* Would a shell RUN the fragment that fired, or is it text — a heredoc body, a comment, a quoted argument to
     * an echo or a grep (contract shell-regions.ts)?
     *
     * THE HARD RULE IS THE ONLY READER OF THIS, and that is deliberate. Everywhere else an over-inclusive match
     * is free, because a false positive costs one judge call; here it costs an interruption nobody can waive, so
     * it is the one place worth spending a scan to tell `echo "rm -rf /" >> notes.md` from the delete. A mention
     * still classifies, still reaches the judge, and is still marked on the card. */
    readonly live: boolean;
}

/* MAY THE AGENT RUN THIS COMMAND WHATEVER ANYONE SAYS? The HARD RULE, and after the safety redesign it is all
 * that is left in this decide.
 *
 * WHAT USED TO BE HERE, and why none of it survived. Three layers: the owner's `commandRules` (a verdict per
 * class), a standing floor under the classes nothing recovers, and a taint floor that held recursive deletes and
 * leaving credential reads in a turn that had read outside content. All three shared one flaw — they decided
 * from a REGEX MATCH, so `echo "rm -rf /"` and an actual delete were the same input and got the same card. That
 * is not a threshold problem, and the redesign replaced the deciding rather than the tuning: triage still fires
 * (contract command-classes.ts), and what it wakes is a model reading the owner's written policy plus what the
 * daemon knows about the turn (agent/command-judge.ts). The taint bit is now a FACT handed to that judge instead
 * of a hard-coded hold, which is what lets "we read a stranger's page, so be careful about deletes" be a
 * sentence the owner can write, narrow, or drop.
 *
 * WHAT DID NOT MOVE INTO THE POLICY. The classes where nothing recovers — a wiped block device, a deleted
 * volume, a delete aimed at a root rather than at something inside one. A model can be argued into anything by
 * text in the command it is judging, and the cost of being wrong once here is the machine. So this stays typed,
 * applies before the judge is ever called, and no verdict can waive it (contract safety-policy.ts
 * hardRuleClasses holds the sets and argues for both).
 *
 * TWO THINGS NARROW IT, and neither is a threshold. WHERE the command runs, because a container rebuilt from an
 * image recovers `/usr` and a laptop does not; and whether the fragment that fired would RUN, because the old
 * rule fired on `echo "rm -rf /"` too and no policy line could ever have said otherwise. Both arrive as facts on
 * the input rather than being re-derived here: the classifier is the only place that knows either.
 *
 * A "hold" means the real thing: the gate raises a permission card and the command waits. An unattended turn has
 * nobody to raise it to and gets a refusal instead; the gate words that, because whether anyone is watching is a
 * property of the turn and not of the rule. */
export const commandRun = defineGuardedAction<CommandRunInput>({
    action: "command.run",
    decide: ({ commandClass, locus, live }) => {
        // A mention is not an act. Checked before the set, because it is the cheaper question and because a
        // reason of "it does not run it" is the one a reader of the log actually wants.
        if (!live) {
            return ALLOW(`this only mentions ${commandClass}, it does not do it`);
        }
        return hardRuleClasses(locus).has(commandClass)
            ? HOLD(`this command would ${COMMAND_CLASS_LABELS[commandClass]}, and nothing here undoes that`)
            : ALLOW(`the ${locus} hard rule does not cover ${commandClass}`);
    },
});

export interface CredentialUseInput {
    // Whether the owner put this credential behind named approvers at all. False for the overwhelming
    // majority of uses, which is why this action's ALLOW is the common path and costs a comparison.
    readonly gated: boolean;
    // Whether this conversation already holds a release for it (a `conversation`-scoped gate somebody
    // already answered). The grant is consulted at the CONSULT SITE and arrives as a fact, the catalog's own
    // rule: policy rides in, IO stays outside, so the whole matrix is testable without a store.
    readonly granted: boolean;
    readonly unattended: boolean;
    // Whether a card CAN be raised: there is a live conversation to draw it in. Looked up rather than
    // guessed, the childSpawn decide's own correction one door along.
    readonly canPark: boolean;
}

/* MAY THE AGENT USE THIS CREDENTIAL RIGHT NOW? Consulted at every exit a stored value can leave through and
 * at every mount that hands one to a turn (secrets/credential-gate.ts), which is what makes the rule bind on
 * all of them at once instead of once per door.
 *
 * A "hold" ASKS, and asks a NAMED PERSON rather than whoever is looking: this is the only card in the sandbox
 * addressed to a list, and the reply route checks the clicker's verified identity against it. That is why the
 * two refusals below are refusals and not holds. An unattended turn has nobody to ask, and a turn with no live
 * conversation has nowhere to draw the card — both are properties of the TURN rather than of the policy, which
 * is why they are decided here and worded by the gate (commandRun's own division of labour).
 *
 * IT NEVER DENIES ON POLICY GROUNDS. A gate is not a ban: the owner's sentence is "ask Bob", never "never".
 * So the only DENY here is the absence of anybody to ask, and a gate whose approvers are all asleep produces
 * an unanswered card and a refusal that says so, not a permanent no. */
export const credentialUse = defineGuardedAction<CredentialUseInput>({
    action: "credential.use",
    decide: ({ gated, granted, unattended, canPark }) => {
        if (!gated) {
            return ALLOW("no gate covers this credential");
        }
        if (granted) {
            return ALLOW("this conversation already holds a release for it");
        }
        if (unattended) {
            return DENY("this turn is running unattended, and a gated credential needs a named person's click");
        }
        if (!canPark) {
            return DENY("there is no live conversation to raise the release card in");
        }
        return HOLD("a named approver has to release this credential");
    },
});

export interface ChildSpawnInput {
    // The provider the child would run on, so a rule can single one out ("agents.spawn.cursor") or cover the
    // whole surface ("agents.spawn"). The specific key wins, the outbound gate's own precedence shape.
    readonly provider: string;
    // SandboxSettings.actionRules, the same open rulebook the outbound gate reads.
    readonly rules: Readonly<Record<string, AdmissionRule>>;
    /* What first brought outside content into the PARENT's turn (guard/turn-taint.ts), or undefined for a
     * turn working only on the owner's own material. Present ⇒ the parent has read text somebody else wrote,
     * which is the condition the floor below keys on. */
    readonly outsideSource?: string;
}

/* May this turn start, steer or answer a CHILD AGENT? Consulted by the child service on every supervisor
 * mutation (children/children.ts), which is what makes the rule bind on every door at once — the harness
 * tools, Cursor's custom tools, and the `agents` CLI all land on the same consult.
 *
 * A "hold" ASKS. The service raises a permission card on the parent's own turn and waits (children/children.ts
 * askOwner), which is commandRun's shape rather than outbound.send's, and for commandRun's reason: there is no
 * held form of a spawn the way a draft is the held form of a send — there is the child or there is not.
 *
 * It refuses only where there is genuinely nobody to ask, and that is decided by looking rather than guessing:
 * a live turn run for the parent conversation is a stream to draw a card in, and its absence is the detached
 * `agents` shell or a turn that has already ended. This used to refuse unconditionally on the grounds that the
 * detached case exists, which made the common case (a watched turn, the owner right there) unanswerable.
 *
 * THE TAINT FLOOR rides this action too, and for the wallet's reason: a child spends the owner's connected
 * accounts on the parent's say-so, and a parent that has read a hostile page is exactly the judgment that
 * page may have replaced. Applied only where the owner has said NOTHING: an explicit `allow` is a decision
 * about this workspace, and the floor must not override the person who configured it. */
export const childSpawn = defineGuardedAction<ChildSpawnInput>({
    action: "agents.spawn",
    decide: ({ provider, rules, outsideSource }) => {
        const rule = rules[`agents.spawn.${provider}`] ?? rules["agents.spawn"];
        if (rule === "deny") {
            return DENY(`spawning child agents on ${provider} is refused by the action rules`);
        }
        if (rule === "hold") {
            return HOLD(`spawning child agents on ${provider} requires owner approval`);
        }
        if (rule === undefined && outsideSource !== undefined) {
            return HOLD(
                `this turn has taken in content from outside (${outsideSource}), and a child agent would spend the owner's accounts on its say-so`,
            );
        }
        return ALLOW(`no action rule restricts spawning child agents on ${provider}`);
    },
});
