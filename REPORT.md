# Design Report

## 1. Architecture

The system is one process with five layers, composed so that the two execution paths — LLM discovery and deterministic replay — sit on an identical foundation.

```
        discovery (LLM)              replay (no model)
                \                      /
                 ──▶ GuardedSurface ◀──
                        │  allowlist + session lease enforced here
                        ▼
                 PlaywrightSurface
                        │  observe() → Observation,  act(Action)
                        ▼
                 the application
```

**The surface abstraction is the load-bearing decision.** A `Surface` answers two questions — what is on screen, and do this to it — and nothing above it knows that a browser exists. `Observation` deliberately contains no HTML, no DOM tree, no framework detail: it is a flat list of controls with roles, names, and structural context. A replay engine written against that type *cannot* accidentally depend on the DOM, which is the property that makes the desktop story credible rather than aspirational.

**Perception is an accessibility-equivalent view, not DOM selectors.** Playwright's own accessibility snapshot returns almost nothing useful on this markup: an unlabelled `<input>` in a layout table has no accessible name, so it arrives as an anonymous textbox indistinguishable from the two beside it. A human operator has no such trouble — they read the words in the cell to the left. So `src/surface/extractor.ts` computes the real accessible name where the markup earns one, and a **derived name** reconstructed from layout context where it does not. That single piece of work is what makes accessibility-tree automation viable on surfaces that have no accessibility affordances, and it is why most form fields in the recorded flow are targeted by the text beside them.

**Enforcement is a decorator, not caller discipline.** `GuardedSurface` wraps any surface and holds the allowlist and the session lease. There are two callers today and there will be more; enforcement written into a caller has to be written into every caller, correctly, forever. Enforcement at the surface happens once and cannot be bypassed, because there is no path to the application that does not go through it.

**Replay imports no model client.** "No LLM in the decision loop" is structural here, not a promise. `src/replay/` has no provider dependency in its graph.

Trade-offs taken: single process over services (the brief explicitly discourages building scaling infrastructure, and the interesting seams are the artifact and the control model, neither of which is a deployment concern); files on disk over a database for artifacts (an artifact becomes a pull request and approval becomes a code review — which is the audit trail a regulated institution already knows how to operate); synchronous execution over a queue.

## 2. Artifact schema

The artifact serves three readers at once, and its shape follows from that: a **calling agent** needs typed inputs, typed outputs and a truthful statement of what invoking this does to the world; the **replay engine** needs enough precision to execute blind; a **human reviewer at a bank** has to read it and decide whether to approve it. The third reader is why `intent`, `rationale` and `description` are carried alongside the machine-readable parts. An artifact only a machine can check does not get approved for unattended use.

Two structural decisions carry most of the weight.

**`knownOutcomes` sits beside `steps` as a first-class field.** A flow is not "the happy path, plus errors". It is a set of legitimate destinations, only one of which is the one you hoped for. Each declared outcome carries a stable code, a detection checkpoint, and a caller-facing message. Replay checks these *before* it classifies anything as a failure — described in §3.

**Values are never inlined.** Steps reference parameters and secrets by name: `{kind: "param", param: "memberId"}`, `{kind: "secret", ref: "MERIDIAN_PASSWORD"}`. The recorder detects that the run typed `10001` into a field, recognises it as the value of `memberId`, and records the reference. Reuse and non-disclosure turn out to want exactly the same thing — the artifact is both parameterized and safe to commit.

**Targeting is a ladder, not a selector.** A `LocatorDescriptor` is an ordered list of strategies, strongest first:

| rung | strategy | assumes |
|---|---|---|
| 0 | `role_name` | an accessible name exists — also true on a desktop AX tree |
| 1 | `role_name_in_region` | plus an enclosing panel, to disambiguate repeats |
| 2 | `row_anchored` | a grid; the anchor may be **parameterized** |
| 3 | `label_adjacent` | the visible text beside an unlabelled control |
| 4 | `nth_of_role` | stable ordering |
| 5 | `css` | a DOM — web-only debt, flagged as such |
| 6 | `coordinates` | everything; recorded only when nothing semantic was unique |

Two properties justify the complexity. Degradation is **graceful** — a restyled build does not break a flow targeted by role and name. And degradation is **observable** — replay records which rung resolved, so a step that always resolved at rung 0 and now resolves at rung 2 is a drift signal, which is how per-tenant drift gets detected without hand-auditing thousands of app instances.

**The recorder verifies rather than guesses.** At record time it has something replay never will: the element that was acted on *and* the full observation it sat in. So each candidate strategy is tested for uniqueness against the real screen, and only strategies that identified exactly this element are written down. A rung that would have been ambiguous never enters the artifact. This is also why the model is kept away from selectors entirely — it acts on ephemeral refs and cannot express a fragile path even if it wanted to.

One bug this caught, worth stating because it is subtle: the first version recorded the savings-balance cell as `cell named "$8,241.55"` — locating the data by the data, which can only find a value you already have. The same flaw appeared on the member link, whose name *is* the caller-supplied member ID. The rule now is that **a strategy may never encode unparameterized run data**: if an element's name equals a parameter value, or the element is the cell being extracted from, name-based targeting is skipped and the row anchor is used instead. Confidence drops from `high` to `medium` as a result, which is the honest score.

**Outcomes carry a `verified` flag**, because the two sources do not deserve equal trust. Profile outcomes (§4) are written per vendor product against observed screens. Model-proposed outcomes come from an agent that completed the happy path and never saw a failure screen — in the real run here it proposed `MEMBER_NOT_FOUND` detected by `"0 record(s) matched"`, text that appears nowhere in the application. Unverified outcomes are harmless at runtime (text that never appears never matches) but presenting them beside vetted ones as equally established misleads the reviewer who has to approve the artifact.

**The first real discovery run wrote a tax ID into the artifact.** The checkpoint deriver picked the most distinctive new line on the member detail screen, which was the row containing the member's SSN. Evidence writes were redacted; the artifact takes a different path to disk and was not. Two fixes: checkpoint candidates are rejected outright if the redactor would touch them or if they are concatenated table rows (one record's field values, which cannot hold for another input), and `assertArtifactIsClean` now refuses to write any artifact containing recognisable regulated data — it throws rather than masking, because silently masking would hide that a new path to disk had opened up. There is a regression test.

Also present: semantic `version`, `approval` state, `provenance` (which model, which run), `stability` counters, and a `tenant` binding with a per-tenant override map (§4).

## 3. Determinism & error handling

Determinism comes from four things: a fixed step list with no branching, targeting that resolves the same way every time or reports why it did not, **checkpoints after every step**, and waits that are conditions rather than sleeps.

The settle rule is worth calling out because getting it wrong produced genuinely undebuggable flakiness. Waiting on the main frame's load state is insufficient in a frameset — clicking a nav-frame link navigates the content frame while the main document never changes state, so a naive wait returns immediately and the next observation reads the *previous* screen. Replay instead polls the set of frame URLs until it holds still across consecutive samples.

**The evaluation order inside every step is the core of the error model, and it never varies:**

1. **Does a declared business outcome match?** → return it. Not an error.
2. **Does a recovery rule match?** → apply it, retry without consuming the transient budget.
3. **Is this a recognisable surface condition?** → classify it specifically.
4. **Otherwise** → structured failure.

Checking business outcomes *first* is what stops "no such member" being reported as a broken locator. On that screen the member row genuinely is not present, so a targeting-first implementation reports `locator_unresolved` — technically accurate and completely useless to the caller, who will retry a lookup that can never succeed.

The result contract has four statuses:

- `success` — with typed outputs (currency arrives as a number, not `"$8,241.55"`).
- `business_outcome` — `RECORD_NOT_FOUND`, `PERMISSION_DENIED`: correct runs with a non-success answer. Exit code 0.
- `escalated` — a person was brought in; the system behaved correctly but could not finish alone.
- `failure` — with a class from a closed set (`locator_unresolved`, `checkpoint_failed`, `session_expired`, `surface_error`, `policy_denied`, `not_approved`, `input_invalid`, …), the step, the intent, **what was expected, what was observed**, and a screenshot plus DOM snapshot.

**Recoverable conditions** are declared per product rather than per flow, in a `SurfaceProfile`: Meridian's unscheduled maintenance interstitial is cleared by a global rule with an attempt cap, and the recovery is recorded in the trace — a recovery that fires silently is indistinguishable from one that never fired. Transient slowness is handled by bounded retry on the failure classes a mid-render page could plausibly cause, and only those.

**Retrying is gated on the surface not being recognisably broken**, and this came directly from a bug the session-expiry scenario exposed. The application signed the run out, the step's checkpoint failed, and the transient retry re-ran the step against the sign-on page. The strong locator rungs matched nothing, execution fell through to the positional fallback, and a positional fallback matches *something* on almost any screen — in this case the login form's first textbox and first button. Replay typed a member number into the Operator ID field and clicked Sign On. It also destroyed the "session has expired" message, so the failure came back as a generic `checkpoint_failed` with no explanation of itself.

Two fixes. Replay consults `classifySurfaceCondition` **before** retrying and stops immediately on a recognised condition, because waiting will not turn a sign-on page back into a search screen. And the recorder now emits a **precondition per step**, carrying the previous step's checkpoint forward, so every step asserts it is on the expected screen before acting at all. The scenario now reports `session_expired` with the expiry message intact and no stray action taken.

That is the general shape of the risk with a fallback ladder: the weak rungs exist for good reasons, and they will happily fire on the wrong screen. Preconditions are what confine them to the right one.

**Inputs are validated before anything is touched.** A `memberId` failing its declared pattern returns `input_invalid` with an empty trace — nothing was attempted — and the offending value is *not* echoed back, since it may be the regulated data itself.

All of this is tested against a live browser rather than asserted: 12 integration tests cover success, replay with a different member than the one recorded, identical outputs across runs, both business outcomes, interstitial recovery, mid-flow session expiry, application error, evidence capture, input rejection, and the approval gate.

UI drift, secondarily: the ladder absorbs it, the rung index measures it, and `stability.degradedResolutions` accumulates it per artifact.

## 4. Heterogeneity & multi-tenant

**The seam between perceiving a surface and the recorded flow is `Observation` / `Action`.** A step says "click the control with role `button` and accessible name `Sign On`, in region `Operator Sign On`". Nothing in that sentence is web-specific. The role vocabulary is deliberately ARIA's, which is the same vocabulary macOS AX and Windows UIA expose. A desktop adapter implements `observe()` by walking the platform accessibility tree and `act()` via the platform API; rungs 0–4 transfer unchanged, rung 5 (`css`) simply never appears in a desktop recording, and rung 6 (coordinates) means the same thing. A legacy web app is not a different case at all — it is the case this was built for, which is why derived names exist.

What would need work for desktop: window/application identity in place of a URL for allowlisting, and a different human-handoff transport (§5).

**Multi-tenant reuse** is one artifact per *(vendor product, flow)*, not per tenant. The `tenant` binding carries the product, the recorded-on tenant, a list of verified tenants, and an `overrides` map keyed by tenant id holding JSON-pointer patches. A tenant whose build labels the button "Find" instead of "Search" needs a three-line override, reviewable as a diff, not a re-recording. Conditions generic to the *product* live in a `SurfaceProfile` shared by every artifact recorded against it — recovery rules and outcome detection are written once per vendor, not once per flow per tenant.

Drift detection falls out of the ladder for free: replay reports the resolved rung, and `degradedResolutions` rising on one tenant while flat on others localises the problem to that tenant's build before the flow actually breaks. The intended production loop is: roll an artifact to a tenant in shadow, watch rung indices and stability, promote or write an override.

Neither the override resolution nor a desktop adapter is implemented. The schema and the abstractions are shaped so that adding them is additive.

## 5. Escalation & handoff

**"Stuck" is detected three ways:** the model calls `escalate` during discovery (an explicit, first-class outcome, not a failure); replay hits a condition its artifact does not describe; or policy classifies an action as irreversible and there is no standing authorization.

**Control is a lease, not a flag.** `ControlBroker` owns four states — `automation`, `pending_human`, `human`, `released` — and `GuardedSurface.act()` asserts the holder on every action, throwing `ControlViolationError` otherwise. A background retry that wakes while an operator is mid-correction *cannot* type into their form, because the surface refuses it, not because the retry was written carefully.

`pending_human` exists as a distinct state because the interval between automation standing down and a person actually arriving is real and can be long. Collapsing it into `human` would mean the system believes an operator is at the controls before one is.

**Ordering matters in the handoff.** Context is captured *before* standing down — once the lease is released the operator may navigate away and the screen that caused the escalation is gone. The intervention carries the goal, the capability and version, the step, the screenshot, the redacted visible text, what was expected and what was observed, and a suggested action. Then the lease is released, then human-input recording starts.

The operator console (`:4610`) shows that context and a **Take control** button. The operator drives **the same browser window** — the automation's own session, with its cookies and its position in the flow — and hands control back. What they did is recorded via passive capture-phase listeners installed as an init script, so they survive navigation and apply to every frame. **Values are never captured**, only the control's identity and the length of what was entered; recording what an operator typed into a member record would defeat the entire redaction layer.

On resume the engine **re-observes and re-asserts** before continuing. The operator may have left the session somewhere other than where they were asked to, and trusting otherwise is how a handoff corrupts a run.

This is demonstrated rather than described: `evidence/06-escalation-handoff/` is a run where automation pauses, an operator opens a record the replay never visited, hands back, and the next step reads a balance that only exists on that screen. If the transfer were cosmetic the run could not finish. Three integration tests cover the same path, including the abort case. Building it surfaced a bug worth recording: the first implementation buffered operator actions in a `window` array, so a click on a link was captured and then destroyed by the navigation that click caused — the only actions that survived were the ones that changed nothing. Events are now pushed out of the page through an exposed binding as they happen.

Deliberately mocked: the console itself. In production the operator is not sitting at the machine running the browser, so the live surface has to reach them — a CDP screencast over a websocket, or a containerised browser with a VNC/WebRTC channel. Both replace this page's "the window is next to you" assumption. Neither changes the control model, which is the part that is genuinely hard and is therefore the part built for real.

## 6. Safety

**Allowlist**, enforced on every action in both paths. Origins, path regexes, permitted action types, and a risk ceiling. Deny rules beat allow rules — the target app's fault-injection plane at `/control/*` is served from an allowed origin and is refused, as is `/logout`. An origin-only allowlist would permit both. Post-action location is re-checked, because a click is a navigation nobody had to spell out.

**Risk classification** reads the verb on the control, which is what a human operator reads and the only signal these applications reliably offer. It distinguishes not read-from-write but *reversible from not*: typing into a field changes a pending form; clicking "Post Transaction" cannot be taken back. It is heuristic and fails deliberately — an unrecognised button is assumed to write, anything matching the commit vocabulary is assumed irreversible, and a reviewed artifact can override the guess per step. An irreversible action is not denied (some capabilities exist to commit things) — it becomes `confirm`, which routes to a person with the screen attached. With no approver configured, it is refused, because the alternative is performing an irreversible action at a bank because nobody was around to say no.

**Approval gate.** Every recording starts `draft`. Unattended invocation requires promotion by a named human, recorded with actor and timestamp. This is the cheapest useful control in the system: a model's first guess at a flow can never silently become production behaviour.

**Redaction** happens at the writer, not the call site — `RunLogger` redacts everything handed to it, and callers cannot opt out. Two mechanisms because they fail differently: registered values (exact, labelled `<redacted:MERIDIAN_PASSWORD>` so a reader knows what was removed, but only catches what we declared) and shape patterns (catches tax IDs rendered by the *application*, which nothing registered, at the cost of over-redaction). Over-redaction is the correct failure direction. Declared sensitivity beats detection wherever available: a member ID matches no pattern, and only its `pii` classification keeps it out of logs. Card-shaped numbers are Luhn-checked so account numbers stay readable.

**The model never sees credentials.** It has a `type_secret` tool taking a secret's *name*; the loop resolves the value and fills the field. The artifact records the reference.

**Limits, plainly.** Screenshots are not redacted — pixels do not yield to regexes, and a capture of a member detail page contains a tax ID. The mitigation is masking sensitive regions at capture time using element boxes the observation already carries; not implemented. Surface signals are limited to what ARIA actually reports, which on these apps is usually nothing; recognising "this red box means rejected" is semantic knowledge and lives in declared outcomes rather than a colour heuristic that would be wrong undebuggably. The allowlist constrains *where* and *what kind*, not *what data* — an approved read capability could be invoked for members the caller should not see, which is an authorization problem belonging to the calling agent. Prompt injection from page content is unmitigated beyond the action allowlist and the approval gate.

## 7. Cuts

Cut deliberately, with the seam left real:

- **Real co-browsing.** Mocked at the console; the control model, lease enforcement, context capture and action recording are real. Next: CDP screencast over websocket.
- **Desktop adapter.** Not built. The `Surface` interface and ARIA-derived role vocabulary are the seam; no artifact field is web-specific except rung 5.
- **Multi-tenant override resolution.** Schema present, resolver not written. Next, and small.
- **Re-authentication on session expiry.** Detected and classified precisely; not recovered. Deliberate — many shops prefer to fail fast and let the orchestrator retry with a fresh session — but the recovery-rule mechanism could express it.
- **Screenshot redaction.** Named above. The most important gap for a regulated deployment.
- **Bounded LLM fallback on replay failure.** Attractive and dangerous; the approval gate and policy layer it would need are in place, the fallback is not.

What I would build next, in order: screenshot masking, override resolution plus a second tenant variant to prove cross-tenant reuse end-to-end, then the screencast console.

**On the discovery run.** The committed artifact in `capabilities/` and the trail in `evidence/01-discovery/` come from a genuine `gpt-4o` run against the live surface. The hand-authored fixture in `tests/fixtures/` exists only so replay behaviour can be tested deterministically without a model call per test, and without test failures depending on what the model decided that afternoon; it is labelled as such and is not the shipped artifact.

Worth noting what the real run justified. The `done` guard — which rejects a success claim whose evidence is not literally on screen — fired on the first attempt, every time. The model wanted to assert `"Savings 4410029947 $8,241.55 2014-03-11"`, a row it had read as a table but which does not appear as that string in the page text. Without the guard the artifact would have carried a success condition that could never match and every replay would have failed. Three of the bugs described above (the data-encoding locator, the SSN in the artifact, the retry into a sign-on page) were found only by running the thing for real; none would have surfaced against the fixture.
