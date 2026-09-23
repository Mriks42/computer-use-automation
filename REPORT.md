# Design Report

## 1. Architecture

One process. Discovery (LLM) and replay (no model) both act through `GuardedSurface` → `PlaywrightSurface` → the application, so policy and control guarantees are identical on both paths.

**The surface abstraction is the load-bearing decision.** A `Surface` answers two questions — what is on screen, and do this to it. `Observation` carries no HTML and no DOM, only controls with roles, names and structural context, so a replay engine written against it *cannot* depend on the DOM. That is what makes the desktop story credible rather than aspirational.

**Perception is an accessibility-equivalent view, not DOM selectors.** Playwright's own tooling returns almost nothing here: an unlabelled `<input>` in a layout table has no accessible name, so `getByRole('textbox', {name:'Operator ID'})` returns **zero** matches and the unnamed query returns two indistinguishable ones. A human reads the words in the cell to the left; `extractor.ts` does the same, computing a **derived name** from layout context wherever markup provides none. That is what makes accessibility-driven automation viable on surfaces with no accessibility affordances.

**Enforcement is a decorator, not caller discipline.** `GuardedSurface` holds the allowlist and session lease. Enforcement in a caller must be repeated in every caller, forever; at the surface it happens once and cannot be bypassed. Relatedly, `src/replay/` has no model client in its dependency graph — "no LLM in the decision loop" is structural, not a promise.

Trade-offs: single process over services, since the interesting seams are the artifact and the control model. Files on disk over a database, so an artifact becomes a pull request and approval a code review — an audit trail regulated institutions already operate.

## 2. Artifact schema

The artifact serves three readers: a **calling agent** needing typed inputs, typed outputs and a truthful statement of what invoking it does; the **replay engine** needing precision to execute blind; and a **human reviewer at a bank** deciding whether to approve it. The third is why `intent` and `rationale` sit beside the machine-readable parts.

**`knownOutcomes` is first-class beside `steps`.** A flow is not "the happy path plus errors" but a set of legitimate destinations, one of which you hoped for. Each carries a stable code, a detection checkpoint and a caller-facing message; replay checks them *before* classifying anything as failure (§3).

**Values are never inlined.** Steps reference parameters and secrets by name — `{kind:"param", param:"memberId"}`, `{kind:"secret", ref:"MERIDIAN_PASSWORD"}`. Reuse and non-disclosure want the same thing: parameterized *and* safe to commit.

**Targeting is a ladder, not a selector**, ordered by how much each rung assumes:

| 0 `role_name` | 1 `role_name_in_region` | 2 `row_anchored` (parameterizable) | 3 `label_adjacent` | 4 `nth_of_role` | 5 `css` | 6 `coordinates` |
|---|---|---|---|---|---|---|

Rungs 0–4 transfer to a desktop AX tree unchanged; rung 5 is web-only debt, flagged; rung 6 is recorded only when nothing semantic was unique. Degradation is **graceful** and **observable** — replay records the resolving rung, so 0 → 2 is a drift signal, which is how per-tenant drift surfaces without hand-auditing thousands of app instances.

**The recorder verifies rather than guesses.** At record time it has what replay never will: the element acted on *and* the observation it sat in. Each candidate is tested for uniqueness against the real screen; ambiguous rungs never enter the artifact. This is also why the model never touches selectors — it acts on ephemeral refs and cannot express a fragile path.

Three findings from the real runs, each fixed with a regression test: locators **encoded run data** (the balance cell recorded as `cell named "$8,241.55"` — locating data by the data), so a strategy may no longer embed unparameterized run values; the first discovery run **wrote a tax ID into the artifact** via a derived checkpoint, so `assertArtifactIsClean` now refuses to write any artifact containing regulated data, throwing rather than masking so a leak path cannot hide; and outcomes now carry a **`verified` flag**, because model-proposed outcomes come from an agent that only saw the happy path and ours proposed detection text appearing nowhere in the app.

Also present: semver `version`, `approval` state, `provenance`, `stability` counters, and a `tenant` binding with per-tenant overrides (§4).

## 3. Determinism & error handling

Determinism comes from a fixed step list with no branching, targeting that resolves identically or reports why it did not, checkpoints after every step, and waits that are conditions rather than sleeps. One subtlety: a frame's load state is insufficient in a frameset, since a nav-frame click navigates the *content* frame while the main document never changes — so replay polls frame URLs until they hold still.

**The evaluation order inside every step never varies:** a declared business outcome returns immediately and is not an error; then a matching recovery rule is applied and retried without consuming the transient budget; then a recognisable surface condition is classified specifically; otherwise, structured failure.

Checking business outcomes *first* is what stops "no such member" being reported as a broken locator. On that screen the row genuinely is absent, so a targeting-first implementation reports `locator_unresolved` — accurate, and useless to a caller who will retry a lookup that can never succeed.

Four statuses: `success` (typed outputs — currency as a number, not `"$8,241.55"`); `business_outcome` (a correct run with a non-success answer, exit 0); `escalated`; and `failure`, carrying a class from a closed set, the step and intent, **expected versus observed**, plus screenshot and DOM snapshot. Recovery rules are declared per product in a `SurfaceProfile` and every recovery is recorded — one that fires silently is indistinguishable from one that never fired.

**Retrying is gated on the surface not being recognisably broken**, which a real bug drove. After a mid-flow session expiry the retry re-ran the step against the sign-on page; the strong rungs matched nothing, execution fell to the positional fallback — which matches *something* on almost any screen — so replay typed a member number into the Operator ID field and clicked Sign On, destroying the expiry message. Fixed two ways: `classifySurfaceCondition` is consulted *before* retrying, and the recorder emits a **precondition per step**. Weak rungs exist for good reasons and will fire on the wrong screen; preconditions confine them to the right one.

Inputs are validated before anything is touched, and a rejected value is never echoed back since it may be the regulated data itself. 15 integration tests cover this against a live browser: replay with a different member than recorded, identical outputs across runs, both business outcomes, interstitial recovery, session expiry, application error, evidence capture, input rejection, the approval gate and the full handoff.

## 4. Heterogeneity & multi-tenant

**The seam is `Observation` / `Action`.** A step says "click the control with role `button` and accessible name `Sign On`, in region `Operator Sign On`" — nothing web-specific. The role vocabulary is deliberately ARIA's, which macOS AX and Windows UIA also expose, so a desktop adapter implements `observe()` against the platform accessibility tree and `act()` against the platform API. Desktop would additionally need window identity in place of a URL for allowlisting, and a different handoff transport (§5).

**Multi-tenant reuse is one artifact per *(vendor product, flow)*, not per tenant.** The `tenant` binding carries the product, recorded-on tenant, verified tenants, and an `overrides` map of JSON-pointer patches, so a tenant whose build says "Find" instead of "Search" needs a three-line override reviewable as a diff, not a re-recording. Product-generic conditions live in the shared `SurfaceProfile`, written once per vendor rather than once per flow per tenant. Drift detection falls out of the ladder: `degradedResolutions` rising on one tenant while flat on others localises the problem before the flow breaks. Neither override resolution nor a desktop adapter is implemented; the abstractions are shaped so adding them is additive.

## 5. Escalation & handoff

**"Stuck" is detected three ways:** the model calls `escalate` during discovery (a first-class outcome, not a failure); replay hits a condition its artifact does not describe; or policy classifies an action as irreversible with no standing authorization.

**Control is a lease, not a flag.** `ControlBroker` owns four states — `automation`, `pending_human`, `human`, `released` — and `GuardedSurface.act()` asserts the holder on every action, throwing otherwise, so a background retry waking mid-correction *cannot* type into the operator's form. `pending_human` is distinct because the gap between standing down and a person arriving is real; collapsing it would mean believing an operator is at the controls before one is.

Context is captured *before* standing down, since once the lease is released the operator may navigate away and the screen that caused the escalation is gone. They drive **the same browser window**, session and position intact. Their actions are recorded but **values never are** — only the control's identity and the length of what was entered. On resume the engine **re-observes and re-asserts** rather than taking their word for it.

This is demonstrated, not described: `evidence/06-escalation-handoff/` is a run where automation pauses, an operator opens a record the replay never visited, hands back, and the next step reads a balance that only exists on that screen — a cosmetic transfer could not complete it. The log also shows `lease_enforced`, where automation attempted an action mid-handoff and the surface refused. Building it surfaced one more bug: operator actions were buffered in a `window` array, so a click was captured then destroyed by the navigation it caused, meaning only actions that changed nothing survived. Events now leave the page through an exposed binding as they fire.

Deliberately mocked: the console. In production the operator is elsewhere, so the live surface must reach them — a CDP screencast, or a containerised browser with a VNC/WebRTC channel. Neither changes the control model, which is the genuinely hard part and is therefore the part built for real.

## 6. Safety

**Allowlist**, enforced on every action in both paths: origins, path regexes, action types, risk ceiling. Deny beats allow — the fault-injection plane at `/control/*` is served from an allowed origin and refused, as is `/logout`; an origin-only allowlist would permit both. Post-action location is re-checked, because a click is a navigation nobody spelled out.

**Risk classification** reads the verb on the control, distinguishing not read-from-write but *reversible from not*: typing changes a pending form; "Post Transaction" cannot be taken back. It is heuristic and fails deliberately — unrecognised buttons are assumed to write, commit vocabulary is assumed irreversible, and a reviewed artifact can override per step. Irreversible actions become `confirm`, routed to a person with the screen attached; with no approver configured they are refused, because the alternative is committing something at a bank because nobody was around to say no.

**Approval gate.** Every recording starts `draft`; unattended invocation requires promotion by a named human with timestamp. The cheapest useful control here — a model's first guess can never silently become production behaviour.

**Redaction happens at the writer**, not the call site, and callers cannot opt out. Two mechanisms because they fail differently: registered values (exact and labelled, but only what we declared) and shape patterns (catching tax IDs the *application* rendered, at the cost of over-redaction — the correct failure direction). Declared sensitivity beats detection where available: a member ID matches no pattern, and only its `pii` classification keeps it out of logs. Card-shaped numbers are Luhn-checked so account numbers stay readable. The model never sees credentials — `type_secret` takes a secret's *name* and the loop resolves it.

**Limits.** Screenshots are not redacted; masking regions at capture time using element boxes the observation already carries is the unimplemented mitigation, and the most important gap for a regulated deployment. Surface signals are limited to what ARIA reports, which here is usually nothing — "this red box means rejected" is semantic knowledge belonging in declared outcomes, not a colour heuristic. The allowlist constrains *where* and *what kind*, not *what data*: an approved read capability could be invoked for members the caller shouldn't see, an authorization problem owned by the calling agent. Prompt injection from page content is unmitigated beyond the action allowlist and the approval gate.

## 7. Cuts

Cut deliberately, seam left real: **real co-browsing** (console mocked; control model, lease enforcement and action recording are real); a **desktop adapter** (`Surface` and the ARIA vocabulary are the seam); **multi-tenant override resolution** (schema present, resolver not written); **re-authentication on session expiry** (detected and classified precisely, not recovered — many shops prefer failing fast with a fresh session); **screenshot redaction**; a **bounded LLM fallback on replay failure** (attractive and dangerous; the approval gate it would need exists); and **vision** — text-first was sufficient here and keeps targeting reviewable, with vision as an escalation when nothing semantic is unique being the right next step for canvas-rendered surfaces.

Next, in order: screenshot masking; override resolution plus a second tenant variant to prove cross-tenant reuse end to end; the screencast console.

**On the discovery run.** The committed artifact and `evidence/01-discovery/` come from a genuine `gpt-4o` run against the live surface; the fixtures in `tests/fixtures/` exist only so replay and handoff can be tested without a model call per test. Worth noting what that run justified: the `done` guard, which rejects a success claim whose evidence is not literally on screen, fired on the first attempt every time — the model wanted to assert a table row it had read visually but which never appears as that string in the page text. Without it the artifact would carry a success condition that could never match. Four of the bugs above were found only by running the thing for real; none would have surfaced against a fixture.
