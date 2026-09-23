# Evidence

One discovery run and four replays of the artifact it produced, all against the local target app. Every log line and DOM snapshot here passed through the redactor on the way to disk — `<redacted:ssn>` and `<redacted:memberId>` markers throughout are that layer working, not placeholders.

## `capability/member.savings_balance.read@1.0.0.json`

The artifact. Written by the recorder from the discovery run below — not hand-authored. Worth looking at:

- **`steps[].action.value`** — `{"kind":"secret","ref":"MERIDIAN_USERNAME"}` and `{"kind":"param","param":"memberId"}`. No concrete value is stored anywhere in the file, which is why it is safe to commit and diff.
- **`steps[].action.target.strategies`** — the locator ladder, strongest rung first, with a `rationale` written for the human reviewer.
- **`successCondition`** — `"Member Detail — {memberId}"`, parameterized rather than pinned to the member the run happened to use.
- **`knownOutcomes[].verified`** — `true` for the two vetted per-product outcomes, `false` for the two the model proposed. The model completed the happy path and never saw a failure screen, so its detection text is a guess; flagging that is the difference between a reviewable artifact and a misleading one.

## `01-discovery/`

The genuine LLM-driven run. `gpt-4o`, 8 recorded steps, a real browser against the live surface.

`log.jsonl` shows each decision with the model's stated reason. Two things worth finding:

- **`type_secret`** at steps 0 and 1 — the model signs on without ever being shown a credential. It names the secret; the loop resolves it.
- **`done_rejected`** near the end — the model declared success citing evidence that was not literally on screen. The loop refused it and made it try again. Without that guard the artifact would have carried a success condition that could never match, and every replay would have failed.

`transcript.json` is the intermediate representation the recorder consumes — decoupled from the raw model conversation, which is full of refs that expired the moment they were used.

## `02-replay-success/`

Replay with `memberId=10003` — a member the discovery run never visited. Returns `savingsBalance: 15630.42` as a number, not `"$15,630.42"`. `degradedResolutions: 0`: every locator resolved at its strongest rung, so no drift.

This is the parameterization claim, tested: same artifact, different record, no edits.

## `03-replay-business-outcome-not-found/`

`memberId=99999`. Status is **`business_outcome`**, code `RECORD_NOT_FOUND`, **exit code 0**.

The run was correct and the answer is simply not success. A caller can branch on the code instead of retrying a lookup that can never succeed. Reporting this as a failure is the mistake this whole result contract exists to prevent.

## `04-replay-recovered-interstitial/`

An unscheduled maintenance notice injected mid-flow. The `dismiss_system_notice` recovery rule fires, clears it, and the run completes normally — see `recovery_applied` in the log, and `recoveriesApplied` on the step in `result.json`.

The recovery is recorded rather than handled silently, because a recovery that fires invisibly is indistinguishable from one that never fired.

## `05-replay-failure-session-expired/`

The application signs the run out mid-flow. Status **`failure`**, class **`session_expired`**, **exit code 1** — not a generic timeout, and not a broken-locator report.

`result.json` carries the step, its stated intent, what was expected and what was observed, plus a screenshot and a full frame-by-frame DOM snapshot.

This scenario caught two real bugs, both since fixed:

1. The transient retry re-ran the step against the sign-on page. The strong rungs matched nothing, execution fell through to the positional fallback, and that fallback matched the login form's first textbox and first button — typing a member number into the Operator ID field and clicking Sign On. Replay now refuses to retry into a recognised bad state, and the recorder emits a precondition per step so a step asserts it is on the right screen before acting.
2. Because of that stray login attempt, the "Your session has expired" message was replaced by "Invalid operator ID or password" before anything was captured — so the failure was misclassified *and* the evidence explaining it was gone. Both are visible in this run as they should now behave.

## `catalog.json`

What an AI agent would discover: name, typed parameters, typed returns, risk class, approval state, and the outcome codes it can expect back. Generated with `npm run catalog`.
