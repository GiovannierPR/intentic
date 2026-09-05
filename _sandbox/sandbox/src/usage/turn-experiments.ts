import type { DayWindowQuery, TurnExperiment, TurnMetricReading, UsageTurn } from "@intentic/sandbox-contract";
import type { UsageStore } from "./usage-store.js";

/* THE IQ SEARCH TEACHING EXPERIMENT, read back out of the spend ledger: what the teaching is worth, measured
 * rather than asserted.
 *
 * A cleaned command carries its own baseline, the raw capture and the emitted result come out of the same
 * event, so the input-side report can be exact. A turn cannot: there is no second run of the same turn to see
 * what it would have cost untaught. The only honest number therefore comes from a holdout, which flips a
 * fraction of eligible conversations to the control arm and stamps which arm ran onto the ledger. Iq search
 * teaching flips whole conversations so a session that already learned the skill can never be relabelled as
 * cold on its next turn.
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

const conversationExperimentOf = (turns: readonly UsageTurn[], metrics: readonly [Metric, ...Metric[]]): TurnExperiment | undefined => {
    const cohort = turns
        .filter((turn) => turn.iqSearchArm !== undefined && turn.iqSearchCohort !== undefined)
        .toSorted((left, right) => right.at - left.at)[0]?.iqSearchCohort;
    const cohortTurns =
        cohort === undefined ? turns.filter((turn) => turn.iqSearchCohort === undefined) : turns.filter((turn) => turn.iqSearchCohort === cohort);
    const grouped = new Map<string, { arm: boolean; valid: boolean; turns: UsageTurn[] }>();
    for (const turn of cohortTurns) {
        if (turn.conversationId === undefined || turn.iqSearchArm === undefined) {
            continue;
        }
        const current = grouped.get(turn.conversationId);
        if (current === undefined) {
            grouped.set(turn.conversationId, { arm: turn.iqSearchArm, valid: true, turns: [turn] });
        } else {
            current.valid &&= current.arm === turn.iqSearchArm;
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
                if (sample.arm !== arm) {
                    return [];
                }
                const measured = sample.turns.map(metric.of).filter((value) => value !== undefined);
                return measured.length === 0 ? [] : [measured.reduce((sum, value) => sum + value, 0) / measured.length];
            });
        return readingOfArms(armOfValues(values(true)), armOfValues(values(false)), metric, false);
    };
    const [headline, ...rest] = metrics;
    return {
        metrics: [reading(headline), ...rest.map(reading)],
        minTurns: MIN_ARM_TURNS,
        sampleUnit: "conversations",
        ...(cohort !== undefined ? { cohort } : {}),
    };
};

const measurable = (turn: UsageTurn): boolean => turn.outcome !== "error" && turn.outcome !== "cancelled";

export const readTurnExperiments = async (
    usage: UsageStore,
    window: DayWindowQuery,
): Promise<{ readonly search?: TurnExperiment }> => {
    const turns = (await usage.turns(window)).filter(measurable);
    const search = conversationExperimentOf(turns, [SEARCH_CALLS, OPENING_SEARCHES]);
    return search !== undefined ? { search } : {};
};
