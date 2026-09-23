# Design Report

## 1. Architecture

One process, composed so that both execution paths — LLM discovery and deterministic replay — sit on an identical foundation.

```
   discovery (LLM)          replay (no model)
            \                  /
             ──▶ GuardedSurface ◀──   allowlist + session lease enforced here
                     ▼
              PlaywrightSurface       observe() → Observation, act(Action)
                     ▼
              the application
```

**The surface abstraction is the load-bearing decision.** A `Surface` answers two questions — what is on screen, and do this to it — and nothing above it knows a browser exists. `Observation` contains no HTML, no DOM, no framework detail: just controls with roles, names and structural context. A replay engine written against that type *cannot* accidentally depend on the DOM, which is what makes the desktop story credible rather than aspirational.

**Perception is an accessibility-equivalent view, not DOM selectors.** Playwright's own accessibility tooling returns almost nothing here: an unlabelled `<input>` in a layout table has no accessible name, so `getByRole('textbox', {name:'Operator ID'})` returns **zero** matches and the unnamed query returns two indistinguishable ones. A human operator has no such trouble — they read the words in the cell to the left. So `extractor.ts` computes the real accessible name where the markup earns one and a **derived name** from layout context where it does not. That single piece of work is what makes accessibility-driven automation viable on surfaces with no accessibility affordances.

**Enforcement is a decorator, not caller discipline.** `GuardedSurface` holds the allowlist and the session lease. Enforcement written into a caller must be written into every caller, correctly, forever; enforcement at the surface happens once and cannot be bypassed.

**Replay imports no model client.** "No LLM in the decision loop" is structural — `src/replay/` has no provider in its dependency graph.

Trade-offs: single process over services — the interesting seams are the artifact and the control model, neither a deployment concern. Files on disk over a database, so an artifact becomes a pull request and approval becomes a code review: the audit trail a regulated institution already operates.

## 2. Artifact schema

The artifact serves three readers: a **calling agent** needing typed inputs, typed outputs and a truthful statement of what invoking this does to the world; the **replay engine** needing precision to execute blind; and a **human reviewer at a bank** deciding whether to approve it. The third is why `intent` and `rationale` sit beside the machine-readable parts — an artifact only a machine can check does not get approved for unattended use.

**`knownOutcomes` is a first-class field beside `steps`.** A flow is not "the happy path plus errors" — it is a set of legitimate destinations, one of which you hoped for. Each carries a stable code, a detection checkpoint and a caller-facing message, and replay checks them *before* classifying anything as failure (§3).

**Values are never inlined.** Steps reference parameters and secrets by name: `{kind:"param", param:"memberId"}`, `{kind:"secret", ref:"MERIDIAN_PASSWORD"}`. The recorder sees the run typed `10001`, recognises the parameter value and records the reference. Reuse and non-disclosure want the same thing: the artifact is parameterized *and* safe to commit.

**Targeting is a ladder, not a selector:**

| rung | strategy | assumes |
|---|---|---|
| 0 | `role_name` | an accessible name — also true on a desktop AX tree |
| 1 | `role_name_in_region` | an enclosing panel, to disambiguate repeats |
| 2 | `row_anchored` | a grid; the anchor may be **parameterized** |
| 3 | `label_adjacent` | visible text beside an unlabelled control |
| 4 | `nth_of_role` | stable ordering |
| 5 | `css` | a DOM — web-only debt, flagged |
| 6 | `coordinates` | everything; only when nothing semantic was unique |

Degradation is **graceful** (a restyle doesn't break role+name targeting) and **observable** (replay records the resolving rung, so 0 → 2 is a drift signal — how per-tenant drift surfaces without hand-auditing thousands of app instances).

**The recorder verifies rather than guesses.** At record time it has what replay never will: the element acted on *and* the observation it sat in. Each candidate strategy is tested for uniqueness against the real screen; ambiguous rungs never enter the artifact. This is also why the model never touches selectors — it acts on ephemeral refs and cannot express a fragile path.

Three findings from the real runs, all now fixed with tests:

- **Locators encoded run data.** The balance cell was recorded as `cell named "$8,241.55"` — locating data by the data, which can only find a value you already have. The member link had the same flaw: its name *is* the caller-supplied ID. Rule now: a strategy may never encode unparameterized run data. Confidence drops `high` → `medium`, which is the honest score.
- **The first discovery run wrote a tax ID into the artifact.** The checkpoint deriver chose the most distinctive new line on the member screen — the SSN row. Evidence writes were redacted; artifacts take a different path to disk and were not. Candidates are now rejected if the redactor would touch them or if they are concatenated table rows, and `assertArtifactIsClean` refuses to write any artifact containing regulated data. It throws rather than masking, because masking would hide that a new path to disk had opened.
- **Outcomes carry a `verified` flag.** Profile outcomes are vetted per product; model-proposed ones come from an agent that only ever saw the happy path. Ours proposed `MEMBER_NOT_FOUND` detected by `"0 record(s) matched"` — text appearing nowhere in the app. Harmless at runtime, but presenting it beside a vetted outcome misleads the reviewer.

Also present: semver `version`, `approval` state, `provenance`, `stability` counters, and a `tenant` binding with a per-tenant override map (§4).

## 3. Determinism & error handling

Determinism comes from a fixed step list with no branching, targeting that resolves identically or reports why it did not, checkpoints after every step, and waits that are conditions rather than sleeps.

The settle rule matters more than it looks. Waiting on the main frame's load state is insufficient in a frameset — a nav-frame click navigates the *content* frame while the main document never changes state, so a naive wait returns immediately and the next observation reads the previous screen. Replay polls frame URLs until they hold still across consecutive samples.

**The evaluation order inside every step never varies:**

1. **A declared business outcome matches?** → return it. Not an error.
2. **A recovery rule matches?** → apply it, retry without consuming the transient budget.
3. **A recognisable surface condition?** → classify it specifically.
4. **Otherwise** → structured failure.

Checking business outcomes *first* is what stops "no such member" being reported as a broken locator. On that screen the row genuinely is absent, so a targeting-first implementation reports `locator_unresolved` — accurate, and useless to a caller who will retry a lookup that can never succeed.

Four statuses: `success` (typed outputs — currency as a number, not `"$8,241.55"`); `business_outcome` (correct runs with a non-success answer, exit 0); `escalated`; and `failure`, carrying a class from a closed set, the step and intent, **what was expected and what was observed**, plus screenshot and DOM snapshot.

**Recovery rules are declared per product, not per flow**, in a `SurfaceProfile` — the maintenance interstitial is cleared by a global rule with an attempt cap, and the recovery is recorded in the trace, because a recovery that fires silently is indistinguishable from one that never fired.

**Retrying is gated on the surface not being recognisably broken.** This came from a real bug. The app signed the run out; the checkpoint failed; the transient retry re-ran the step against the sign-on page. The strong rungs matched nothing, execution fell to the positional fallback — and a positional fallback matches *something* on almost any screen. Replay typed a member number into the Operator ID field and clicked Sign On, which also destroyed the "session has expired" message, so the failure returned as a generic `checkpoint_failed` explaining nothing.

Two fixes: replay consults `classifySurfaceCondition` *before* retrying and stops on a recognised condition, because waiting will not turn a sign-on page back into a search screen; and the recorder emits a **precondition per step**, carrying the previous checkpoint forward, so every step asserts it is on the expected screen before acting. That is the general risk with a fallback ladder — weak rungs exist for good reasons and will happily fire on the wrong screen. Preconditions confine them to the right one.

**Inputs are validated before anything is touched**, and a rejected value is not echoed back, since it may be the regulated data itself.

All of it is tested against a live browser, not asserted: 15 integration tests covering replay with a member other than the one recorded, identical outputs across runs, both business outcomes, interstitial recovery, mid-flow session expiry, application error, evidence capture, input rejection, the approval gate and the full handoff.

## 4. Heterogeneity & multi-tenant

**The seam is `Observation` / `Action`.** A step says "click the control with role `button` and accessible name `Sign On`, in region `Operator Sign On`" — nothing web-specific. The role vocabulary is deliberately ARIA's, the same vocabulary macOS AX and Windows UIA expose. A desktop adapter implements `observe()` against the platform accessibility tree and `act()` against the platform API; rungs 0–4 transfer unchanged, rung 5 never appears in a desktop recording, rung 6 means the same thing. A legacy web app is not a different case — it is the case this was built for.

Desktop would additionally need window identity in place of a URL for allowlisting, and a different handoff transport (§5).

**Multi-tenant reuse is one artifact per *(vendor product, flow)*, not per tenant.** The `tenant` binding carries the product, the recorded-on tenant, verified tenants, and an `overrides` map of JSON-pointer patches. A tenant whose build says "Find" instead of "Search" needs a three-line override reviewable as a diff, not a re-recording. Product-generic conditions live in the shared `SurfaceProfile` — written once per vendor, not once per flow per tenant.

Drift detection falls out of the ladder: `degradedResolutions` rising on one tenant while flat on others localises the problem to that tenant's build before the flow breaks. Intended loop: roll to a tenant in shadow, watch rung indices, promote or write an override.

Neither override resolution nor a desktop adapter is implemented; the abstractions are shaped so adding them is additive.

## 5. Escalation & handoff

**"Stuck" is detected three ways:** the model calls `escalate` during discovery (a first-class outcome, not a failure); replay hits a condition its artifact does not describe; or policy classifies an action as irreversible with no standing authorization.

**Control is a lease, not a flag.** `ControlBroker` owns four states — `automation`, `pending_human`, `human`, `released` — and `GuardedSurface.act()` asserts the holder on every action, throwing `ControlViolationError` otherwise. A background retry waking mid-correction *cannot* type into the operator's form, because the surface refuses it. `pending_human` is a distinct state because the gap between standing down and a person arriving is real; collapsing it into `human` would mean believing an operator is at the controls before one is.

**Ordering matters.** Context is captured *before* standing down — once the lease is released the operator may navigate away and the screen that caused the escalation is gone. Then the lease is released, then recording starts. The intervention carries capability, version, step, screenshot, redacted screen text, expected-vs-observed, and a suggested action.

The operator drives **the same browser window** — the automation's own session, cookies and position intact — and hands control back. Their actions are recorded but **values never are**: only the control's identity and the length of what was entered. On resume the engine **re-observes and re-asserts** rather than taking their word for where they left things.

This is demonstrated, not described. `evidence/06-escalation-handoff/` is a run where automation pauses, an operator opens a record the replay never visited, hands back, and the next step reads a balance that only exists on that screen — a cosmetic transfer could not complete it. The log also shows `lease_enforced`: automation attempted an action mid-handoff and the surface refused. Building this surfaced a bug worth recording — operator actions were buffered in a `window` array, so a click on a link was captured then destroyed by the navigation it caused, meaning the only actions surviving were the ones that changed nothing. Events now leave the page through an exposed binding as they fire.

Deliberately mocked: the console itself. In production the operator is elsewhere, so the live surface must reach them — a CDP screencast over websocket, or a containerised browser with a VNC/WebRTC channel. Neither changes the control model, which is the genuinely hard part and is therefore the part built for real.

## 6. Safety

**Allowlist**, enforced on every action in both paths: origins, path regexes, action types, risk ceiling. Deny beats allow — the app's fault-injection plane at `/control/*` is served from an allowed origin and refused, as is `/logout`. An origin-only allowlist would permit both. Post-action location is re-checked, because a click is a navigation nobody spelled out.

**Risk classification** reads the verb on the control — what a human operator reads, and the only signal these apps reliably offer. It distinguishes not read-from-write but *reversible from not*: typing changes a pending form; "Post Transaction" cannot be taken back. It is heuristic and fails deliberately — unrecognised buttons are assumed to write, commit vocabulary is assumed irreversible, and a reviewed artifact can override per step. Irreversible actions are not denied, since some capabilities exist to commit things; they become `confirm`, routed to a person with the screen attached. With no approver configured they are refused — the alternative is committing something at a bank because nobody was around to say no.

**Approval gate.** Every recording starts `draft`; unattended invocation requires promotion by a named human, with actor and timestamp. The cheapest useful control here — a model's first guess can never silently become production behaviour.

**Redaction happens at the writer**, not the call site; callers cannot opt out. Two mechanisms because they fail differently: registered values (exact, labelled so a reader knows what was removed, but only catches what we declared) and shape patterns (catches tax IDs the *application* rendered, at the cost of over-redaction — the correct failure direction). Declared sensitivity beats detection where available: a member ID matches no pattern, and only its `pii` classification keeps it out of logs. Card-shaped numbers are Luhn-checked so account numbers stay readable.

**The model never sees credentials** — `type_secret` takes a secret's *name*; the loop resolves it.

**Limits.** Screenshots are not redacted; pixels do not yield to regexes, and a member detail capture contains a tax ID. Masking regions at capture time using element boxes the observation already carries is the mitigation — not implemented, and the most important gap for a regulated deployment. Surface signals are limited to what ARIA reports, which here is usually nothing; "this red box means rejected" is semantic knowledge belonging in declared outcomes, not a colour heuristic that would be undebuggably wrong. The allowlist constrains *where* and *what kind*, not *what data* — an approved read capability could be invoked for members the caller shouldn't see, which is an authorization problem owned by the calling agent. Prompt injection from page content is unmitigated beyond the action allowlist and the approval gate.

## 7. Cuts

Cut deliberately, seam left real:

- **Real co-browsing** — console mocked; control model, lease enforcement, context capture and action recording are real. Next: CDP screencast.
- **Desktop adapter** — not built. `Surface` and the ARIA role vocabulary are the seam.
- **Multi-tenant override resolution** — schema present, resolver not written. Small.
- **Re-authentication on session expiry** — detected and classified precisely, not recovered. Many shops prefer failing fast and retrying with a fresh session, but a recovery rule could express it.
- **Screenshot redaction** — the most important gap above.
- **Bounded LLM fallback on replay failure** — attractive and dangerous; the approval gate and policy layer it would need exist, the fallback does not.
- **Vision** — the model sees the structural view, not screenshots. Text-first was sufficient here and keeps targeting reviewable; vision as an escalation when nothing semantic is unique is the right next step for canvas-rendered or image-only surfaces.

Next, in order: screenshot masking; override resolution plus a second tenant variant to prove cross-tenant reuse end to end; the screencast console.

**On the discovery run.** The committed artifact and `evidence/01-discovery/` come from a genuine `gpt-4o` run against the live surface. The hand-authored fixtures in `tests/fixtures/` exist only so replay and handoff behaviour can be tested deterministically without a model call per test; they are labelled as such and are not the shipped artifact.

Worth noting what the real run justified. The `done` guard — which rejects a success claim whose evidence is not literally on screen — fired on the first attempt, every time. The model wanted to assert `"Savings 4410029947 $8,241.55 2014-03-11"`, a row it read as a table but which never appears as that string in the page text. Without the guard the artifact would have carried a success condition that could never match, and every replay would have failed. Four of the bugs described above were found only by running the thing for real; none would have surfaced against a fixture.
