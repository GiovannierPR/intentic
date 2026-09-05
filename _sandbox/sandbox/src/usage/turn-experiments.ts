import type { DayWindowQuery, TurnExperiment, TurnMetricReading, UsageTurn } from "@intentic/sandbox-contract";
import type { UsageStore } from "./usage-store.js";

/* THE MECHANISM EXPERIMENTS, read back out of the spend ledger: what each is worth, measured rather than
 * asserted. Two of them today, the iq search teaching and the project map, and they differ in one thing that
 * changes the arithmetic: when the treatment is applied.
 *
 * A cleaned command carries its own baseline, the raw capture and the emitted result come out of the same
 * event, so the input-side report can be exact. A turn cannot: there is no second run of the same turn to see
 * what it would have cost untaught. The only honest number therefore comes from a holdout, which flips a
 * fraction of eligible conversations to the control arm and stamps which arm ran onto the ledger. Both
 * experiments flip whole conversations, so a session that already learned the skill can never be relabelled as
 * cold on its next turn, and a conversation that opened with a map is never counted as unmapped.
 *
 * WHERE THEY PART: THE SAMPLE. The teaching is loaded into a provider session and acts on every turn of it, so
 * a conversation's sample is the AVERAGE over its turns. The map is one note on the opening message, so a
 * conversation's sample is that OPENING TURN and nothing else. Averaging a first-turn treatment over a
 * twelve-turn conversation divides its effect by twelve and reports the remainder as noise, which is the
 * mistake this file would otherwise make silently.
 *
 * AND THE METRIC, which took a corpus to get right. `searchCalls` counts a directory listing and a ripgrep as
 * the same event, deliberately, so a taxonomy cannot report whichever spelling of a search the model reached
 * for. That is correct for the teaching and blind to the map: over 468 mapped sessions of this workspace
 * against 497 unmapped ones, searches before the first file moved +7.6% with a margin of ±17.6pp while the
 * share of sessions opening with a directory listing fell from 46.3% to 32.1%. The map does not shorten the
 * orientation burst, it changes what the burst is made of, so it is judged on `openingListings`.
 *
 * WHY A NUMBER IS WITHHELD, TWICE. Per-turn quantities are wildly heteroscedastic, one turn is "yes", the next
 * is a forty-tool refactor, so a delta over a handful of turns is noise wearing a percentage sign. The first
 * gate is arm size: below MIN_ARM_TURNS the arms are reported without a delta, which the screen shows as
 * "measuring".
 *
 * Clearing it turned out not to be enough. An experiment reached its thirtieth control turn and published
 * +31.2% ± 35.1pp, an interval from −3.4% to +66.7%, which is no measurement at all, and it published it
 * against the arm that had happened to draw the longer tasks. So the second gate is the margin itself: an
 * interval that spans zero yields its resolution and no claim. Between them the two gates are one rule, that a
 * number reaches the screen when it means something and not when it merely exists. */

// Turns per arm before a delta is reported. Thirty is where the normal approximation behind the margin below
// starts to hold for a distribution this skewed; it is also small enough to be reachable in a day of real use.
export const MIN_ARM_TURNS = 30;

// 95% two-sided normal quantile, the margin is a normal approximation (Welch), which is what MIN_ARM_TURNS
// buys. A t-quantile would differ in the third digit at these sample sizes and needs a table this file would
// otherwise have no reason to carry.
const Z_95 = 1.96;

interface Metric {
    readonly name: TurnMetricReading["metric"];
    readonly of: (turn: UsageTurn) => number | undefined;
    readonly round: (value: number) => number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

// A tenth of a search, because a mean turn runs a handful and the delta between two arms is a fraction of one.
const SEARCH_CALLS: Metric = { name: "searchCalls", of: (turn) => turn.searchCalls, round: round1 };
const OPENING_SEARCHES: Metric = { name: "openingSearches", of: (turn) => turn.openingSearches, round: round1 };
// The map's two readings: what it stops the turn doing, and whether the turn got where it was going sooner.
const ROOT_LISTINGS: Metric = { name: "openingListings", of: (turn) => turn.openingListings, round: round1 };
const CALLS_BEFORE_TARGET: Metric = { name: "callsBeforeTarget", of: (turn) => turn.callsBeforeTarget, round: round1 };

interface Arm {
    readonly turns: number;
    readonly mean: number;
    // Sample variance (n−1). Zero for a single turn, which the threshold rules out of the reported path anyway.
    readonly variance: number;
}

const armOfValues = (values: readonly number[]): Arm => {
    if (values.length === 0) {
        return { turns: 0, mean: 0, variance: 0 };
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.length < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    return { turns: values.length, mean, variance };
};

const RESOLVING_MARGIN_PCT = 10;

const controlTurnsNeededFor = (offTurns: number, marginPct: number): number | undefined => {
    if (marginPct <= RESOLVING_MARGIN_PCT) {
        return undefined;
    }
    return Math.ceil(offTurns * (marginPct / RESOLVING_MARGIN_PCT) ** 2) - offTurns;
};

const readingOfArms = (on: Arm, off: Arm, metric: Metric, claimRealizedSaving = true): TurnMetricReading => {
    const arms = {
        metric: metric.name,
        on: { turns: on.turns, mean: metric.round(on.mean) },
        off: { turns: off.turns, mean: metric.round(off.mean) },
    };
    if (on.turns < MIN_ARM_TURNS || off.turns < MIN_ARM_TURNS || off.mean === 0) {
        return arms;
    }

    const standardError = Math.sqrt(on.variance / on.turns + off.variance / off.turns);
    const deltaPct = round1(((on.mean - off.mean) / off.mean) * 100);
    const marginPct = round1(((Z_95 * standardError) / off.mean) * 100);
    if (Math.abs(deltaPct) <= marginPct) {
        const controlTurnsNeeded = controlTurnsNeededFor(off.turns, marginPct);
        return { ...arms, marginPct, ...(controlTurnsNeeded !== undefined ? { controlTurnsNeeded } : {}) };
    }
    return {
        ...arms,
        marginPct,
        deltaPct,
        ...(claimRealizedSaving ? { saved: metric.round((off.mean - on.mean) * on.turns) } : {}),
    };
};

interface ConversationSample {
    readonly arm: boolean;
    readonly turns: readonly UsageTurn[];
}

/* One experiment's shape: how a row says which arm it ran, which revision of the treatment it ran, what it is
 * judged on, and which of a conversation's turns is the sample. Everything below is the same arithmetic over
 * whatever these four say, so a third mechanism is a record here rather than a second copy of the file. */
interface Design {
    readonly arm: (turn: UsageTurn) => boolean | undefined;
    // The treatment's revision, where mixing two of them would turn one experiment into two unnamed ones.
    // Always undefined for a mechanism with no revisions to mix.
    readonly cohort: (turn: UsageTurn) => string | undefined;
    readonly metrics: readonly [Metric, ...Metric[]];
    readonly sampleUnit: NonNullable<TurnExperiment["sampleUnit"]>;
    /* A conversation's contribution, from the turns of it that survived the filters. Undefined ⇒ this
     * conversation says nothing about this metric, which is not the same as saying zero. */
    readonly sample: (turns: readonly UsageTurn[], metric: Metric) => number | undefined;
}

/* THE AVERAGE OVER A CONVERSATION'S TURNS, for a treatment that acts on all of them. */
const meanOfTurns = (turns: readonly UsageTurn[], metric: Metric): number | undefined => {
    const measured = turns.map(metric.of).filter((value) => value !== undefined);
    return measured.length === 0 ? undefined : measured.reduce((sum, value) => sum + value, 0) / measured.length;
};

/* THE CONVERSATION'S OPENING TURN, for a treatment sent once and never again.
 *
 * `turnIndex === 0` rather than "the earliest row in the window", which is the same thing only when the window
 * happens to contain the conversation's start. Under a seven-day window it is not: every conversation that
 * began the week before would offer a mid-conversation turn as its opening one, in whichever arm it drew.
 *
 * A row with no `turnIndex` predates the field and is passed over rather than guessed at, so this reading
 * begins empty on an old ledger and fills up as turns run, which is the honest shape for a new measurement. */
const openingTurn = (turns: readonly UsageTurn[], metric: Metric): number | undefined => {
    const opening = turns.filter((turn) => turn.turnIndex === 0).toSorted((left, right) => left.at - right.at)[0];
    return opening === undefined ? undefined : metric.of(opening);
};

const experimentOf = (turns: readonly UsageTurn[], design: Design): TurnExperiment | undefined => {
    const latest = turns
        .filter((turn) => design.arm(turn) !== undefined && design.cohort(turn) !== undefined)
        .toSorted((left, right) => right.at - left.at)[0];
    const cohort = latest === undefined ? undefined : design.cohort(latest);
    const cohortTurns =
        cohort === undefined ? turns.filter((turn) => design.cohort(turn) === undefined) : turns.filter((turn) => design.cohort(turn) === cohort);
    const grouped = new Map<string, { arm: boolean; valid: boolean; turns: UsageTurn[] }>();
    for (const turn of cohortTurns) {
        const arm = design.arm(turn);
        if (turn.conversationId === undefined || arm === undefined) {
            continue;
        }
        const current = grouped.get(turn.conversationId);
        if (current === undefined) {
            grouped.set(turn.conversationId, { arm, valid: true, turns: [turn] });
        } else {
            current.valid &&= current.arm === arm;
            current.turns.push(turn);
        }
    }
    const samples: ConversationSample[] = [...grouped.values()]
        .filter((entry) => entry.valid)
        .map((entry) => ({ arm: entry.arm, turns: entry.turns }));
    if (samples.length === 0) {
        return undefined;
    }
    const reading = (metric: Metric): TurnMetricReading => {
        const values = (arm: boolean): number[] =>
            samples.flatMap((sample) => {
                const value = sample.arm === arm ? design.sample(sample.turns, metric) : undefined;
                return value === undefined ? [] : [value];
            });
        return readingOfArms(armOfValues(values(true)), armOfValues(values(false)), metric, false);
    };
    const [headline, ...rest] = design.metrics;
    return {
        metrics: [reading(headline), ...rest.map(reading)],
        minTurns: MIN_ARM_TURNS,
        sampleUnit: design.sampleUnit,
        ...(cohort !== undefined ? { cohort } : {}),
    };
};

const measurable = (turn: UsageTurn): boolean => turn.outcome !== "error" && turn.outcome !== "cancelled";

/* The two mechanisms, as designs. The map's headline is `openingListings` because that is the behaviour its note
 * addresses in so many words; `callsBeforeTarget` is the second reading and the slower one, since it exists
 * only on turns that edited something, which is about a quarter of opening turns. */
const SEARCH_DESIGN: Design = {
    arm: (turn) => turn.iqSearchArm,
    cohort: (turn) => turn.iqSearchCohort,
    metrics: [SEARCH_CALLS, OPENING_SEARCHES],
    sampleUnit: "conversations",
    sample: meanOfTurns,
};

const MAP_DESIGN: Design = {
    arm: (turn) => turn.mapArm,
    // The map has no revisions to keep apart: it is recomputed from the filesystem every time it is sent, so
    // two turns a fortnight apart carry different text by design and there is no wording to cohort by.
    cohort: () => undefined,
    metrics: [ROOT_LISTINGS, CALLS_BEFORE_TARGET],
    sampleUnit: "opening turns",
    sample: openingTurn,
};

export const readTurnExperiments = async (
    usage: UsageStore,
    window: DayWindowQuery,
): Promise<{ readonly search?: TurnExperiment; readonly map?: TurnExperiment }> => {
    const turns = (await usage.turns(window)).filter(measurable);
    const search = experimentOf(turns, SEARCH_DESIGN);
    const map = experimentOf(turns, MAP_DESIGN);
    return { ...(search !== undefined ? { search } : {}), ...(map !== undefined ? { map } : {}) };
};
