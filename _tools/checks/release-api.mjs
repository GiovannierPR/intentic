#!/usr/bin/env node
/* THE GITHUB API HELPERS ANSWER QUESTIONS WITH TEXT OR NOTHING, AND FAIL LOUDLY ON WRITES — drilled through
 * bash against a curl that says no.
 *
 *   node _tools/checks/release-api.mjs
 *
 * _tools/scripts/lib/github.sh opens by declaring the split its six callers are written against: a release
 * that does not exist, an asset list that could not be read and a token that cannot see the repo are all "no
 * answer", and the caller decides which of those is fatal; the functions that CHANGE something fail loudly
 * instead. Nothing enforced that split, and it broke in the direction that costs a release.
 *
 * v1.246.0 IS WHY THIS EXISTS. `gh_release_id` was `curl --fail ... | gh_field id`, and every caller sets
 * `set -euo pipefail` — under which a pipeline answers with the status of the FAILED member, not the reader's.
 * So the 404 that means "this tag has no Release yet", which is the answer publish-github.sh asks for on every
 * single release, came back as curl's exit 22 and killed the script before it created anything: a pushed tag,
 * no Release, no installers, and 463ms of empty output to explain it. The tag existing is what makes this the
 * expensive kind of failure — the re-run has to work from an already-tagged commit.
 *
 * The drill stubs `curl` with a shell function (which wins over the binary) and runs each helper under the
 * same `set -euo pipefail` its callers use, so a question that fails, or a write that quietly does not, is
 * caught here rather than on a tag nobody can take back. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root, trackedFiles } from "./lib/repo.mjs";

const SCRIPT = "_tools/scripts/lib/github.sh";

/* ── what each helper must do when curl says no ───────────────────────────────────────────────────────────
 * `status` is the exit status the helper must answer with, `answer` the text it must print. A question is
 * `0` with nothing; a write is anything but `0`, because a write that silently did not happen is the
 * half-published release this whole directory exists to prevent. */
const CASES = [
    { name: "release-id-404", about: "gh_release_id on a tag with no Release yet (the v1.246.0 failure)", status: 0, answer: "" },
    { name: "latest-tag-404", about: "gh_latest_tag on a repo that has never released", status: 0, answer: "" },
    { name: "asset-names-404", about: "gh_asset_names when the asset list cannot be read", status: 0, answer: "" },
    { name: "release-id-ok", about: "gh_release_id reading an id back off a real body", status: 0, answer: "42" },
    { name: "latest-tag-ok", about: "gh_latest_tag reading a tag back off a real body", status: 0, answer: "v1.2.3" },
    { name: "upload-fails", about: "gh_upload_asset when the upload is refused", status: 22, answer: "" },
    { name: "make-latest-fails", about: "gh_make_latest when the flag flip is refused", status: 22, answer: "" },
];

const DRILL = String.raw`
set -euo pipefail
. "$SCRIPT"
export GH_API_TOKEN=stub

# The stub curl: MODE=refuse exits the way --fail does on a 4xx (22), MODE=answer prints $BODY. It replaces the
# binary for every gh_api call, which is the whole surface these helpers have.
curl() {
    if [ "$MODE" = refuse ]; then return 22; fi
    printf '%s' "$BODY"
}

# One case, run in the caller's own shell settings: <name> <status> <answer on one line>.
run() {
    local case_name="$1" status=0 out
    shift
    out="$("$@" 2>/dev/null)" || status=$?
    printf '%s %s %s\n' "$case_name" "$status" "$(printf '%s' "$out" | tr '\n' ' ')"
}

MODE=refuse run release-id-404   gh_release_id  intentic/intentic v1.246.0
MODE=refuse run latest-tag-404   gh_latest_tag  intentic/intentic
MODE=refuse run asset-names-404  gh_asset_names intentic/intentic 42
MODE=answer BODY='{"id":42}'          run release-id-ok gh_release_id intentic/intentic v1.2.3
MODE=answer BODY='{"tag_name":"v1.2.3"}' run latest-tag-ok gh_latest_tag intentic/intentic
MODE=refuse run upload-fails     gh_upload_asset intentic/intentic 42 /dev/null asset.bin
MODE=refuse run make-latest-fails gh_make_latest intentic/intentic 42
`;

const problems = [];
const vouched = [];

/* ── the assumption the helpers are written against, stated at every call site ─────────────────────────────
 * These are only safe to read as "text or nothing" because the caller aborts on a real error itself. A caller
 * that sources this without `set -e` turns a failed write into a step that carries on regardless. */
const sourcesIt = /^\s*\.\s+.*github\.sh"/m;
const setsErrexit = /^\s*set\b[^\n]*-[a-z]*e/m;
for (const path of trackedFiles()) {
    if (!path.endsWith(".sh") || path === SCRIPT) {
        continue;
    }
    const text = readFileSync(join(root, path), "utf8");
    if (sourcesIt.test(text) && !setsErrexit.test(text)) {
        problems.push(`${path} sources github.sh without \`set -e\`, so a refused release write is stepped straight over`);
    }
}

/* ── and the helpers themselves, where bash can run them ──────────────────────────────────────────────────
 * Vouched for less where bash is absent (a Windows pre-push hook), the same trade publish-retry.mjs makes. */
const drill = spawnSync("bash", ["-c", DRILL], { encoding: "utf8", env: { ...process.env, SCRIPT: join(root, SCRIPT) } });
if (drill.error !== undefined) {
    vouched.push(`release-api: call sites checked; the helpers were not exercised (no usable bash here)`);
} else {
    const observed = new Map(
        drill.stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const [name, status, ...rest] = line.trim().split(/\s+/);
                return [name, { status: Number(status), answer: rest.join(" ") }];
            }),
    );
    for (const { name, about, status, answer } of CASES) {
        const got = observed.get(name);
        if (got === undefined) {
            problems.push(`${about}: the drill printed nothing for "${name}" — it did not run (the shape of ${SCRIPT} changed, or the drill died on the case before it)`);
            continue;
        }
        if (got.status !== status || got.answer !== answer) {
            problems.push(`${about}: exited ${got.status} answering "${got.answer}", expected ${status} answering "${answer}"`);
        }
    }
    vouched.push(`release-api: ${CASES.length} helper case(s) drilled against a refusing curl, and every call site aborts on a failed write`);
}

finish([["a github.sh helper no longer answers the way the release scripts are written against", problems]], vouched);
