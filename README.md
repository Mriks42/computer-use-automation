# Computer-Use Automation System

Record-once / replay-many automation for back-office applications that have no API.

An LLM works out how to complete a task by operating a real UI. The successful run is recorded as a **capability** — a typed, versioned, reviewable artifact with input parameters, declared outputs, per-step targeting, and an explicit set of business outcomes. That artifact then replays **deterministically, with no model in the decision loop**, and returns a structured result to whatever called it.

```
goal ──▶ LLM discovery run ──▶ capability artifact ──▶ deterministic replay ──▶ structured result
                │                                              │
                └────────── human escalation ◀─────────────────┘
                            (same live session)
```

---

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

`.env` needs one thing for discovery:

```
OPENAI_API_KEY=sk-...        # discovery only — replay never calls a model
OPENAI_MODEL=gpt-4o          # optional
```

The other values in `.env.example` have working defaults and can be left alone. The demo credentials are for the bundled stand-in app and are fake by construction.

### Running without model access

Everything except the discovery run works with no API key:

```bash
npm test                     # 51 tests, incl. 12 driving a real browser
npm run replay -- --capability member.savings_balance.read --param memberId=10001
npm run app                  # browse the target app yourself at :4600
```

Replay has no model client in its dependency graph at all — that is the structural guarantee behind "no LLM in the decision loop", not a policy the code politely observes.

---

## Demo path

Three commands, in order.

**1. Discover.** Drives a real browser with a real model, then records the artifact.

```bash
npm run discover -- --goal goals/member-savings-balance.json
```

Writes `capabilities/member.savings_balance.read@1.0.0.json` and a full evidence trail under `runs/discovery-*/`.

**2. Replay it.** No model involved. Note the different member number — the artifact is parameterized, not pinned to the record it was discovered on.

```bash
npm run replay -- --capability member.savings_balance.read --param memberId=10003
```

```
success — 1 output(s)
outputs: {"savingsBalance":15630.42}
```

**3. Replay into an exceptional state.** Same artifact, a fault injected into the app.

```bash
# A legitimate business answer, not a crash. Exit code 0.
npm run replay -- --capability member.savings_balance.read --param memberId=99999

# A restricted record.
npm run replay -- --capability member.savings_balance.read --param memberId=99001

# An unexpected interstitial — recovered automatically, run still completes.
npm run replay -- --capability member.savings_balance.read --param memberId=10001 --inject interstitial

# Signed out mid-flow. A hard failure, classified specifically. Exit code 1.
npm run replay -- --capability member.savings_balance.read --param memberId=10001 --inject session_timeout_midflow

# The application itself errors.
npm run replay -- --capability member.savings_balance.read --param memberId=10001 --inject app_error
```

Injectable faults: `interstitial`, `session_timeout`, `session_timeout_midflow`, `app_error`, `permission_denied`, `slow`.

---

## The human handoff

Any run — discovery or replay — starts an operator console at **http://127.0.0.1:4610**.

When the system cannot safely proceed it pauses, raises an intervention carrying the goal, the step, the screenshot and why it stopped, and releases the session lease. The console shows that context with a **Take control** button. The operator then drives **the same browser window the automation was using** — not a fresh session — and hands control back when done.

To watch it happen, run headed and stop the agent somewhere it cannot proceed:

```bash
npm run discover -- --goal goals/member-savings-balance.json --keep-open
```

Control transfer is enforced at the surface: every `act()` checks the lease and throws if automation is not the holder. A stray retry cannot type into a form an operator is mid-way through correcting.

---

## Capability catalog

Recorded artifacts are callable capabilities. This is the view an AI agent would discover them through:

```bash
npm run capabilities -- list
npm run capabilities -- show --capability member.savings_balance.read
```

```json
{
  "name": "member.savings_balance.read",
  "description": "Signs on to Meridian Core, looks up a member by member number, and returns the current balance of their savings share account.",
  "risk": "reversible_write",
  "approval": "draft",
  "parameters": {
    "type": "object",
    "properties": { "memberId": { "type": "string", "description": "The member number to look up." } },
    "required": ["memberId"]
  },
  "returns": { "savingsBalance": { "type": "currency", "description": "..." } },
  "outcomes": [
    { "code": "RECORD_NOT_FOUND", "description": "No record matched the identifier supplied..." },
    { "code": "PERMISSION_DENIED", "description": "The signed-on operator is not authorized..." }
  ]
}
```

Every recording starts as `draft`. Unattended invocation requires approval, which is a human act:

```bash
npm run capabilities -- approve --capability member.savings_balance.read --artifact-version 1.0.0 --actor your-name --note "reviewed targeting and outcomes"
npm run replay -- --capability member.savings_balance.read --param memberId=10001 --mode unattended
```

---

## The target application

`apps/meridian/` is a stand-in for a legacy credit-union back-office: frameset navigation, table layouts, no test IDs, no `for`/`id` label association, fields whose meaning lives in the cell beside them.

It is local and deliberately hostile rather than a public demo site, for two reasons. The brief asks replay to be driven into runtime exceptional states — permission denials, mid-flow session expiry, unscheduled dialogs — and no public site produces those on demand. Automating one to try would also violate its terms. Owning the target makes the error paths reproducible and the evidence honest.

Its fault-injection plane at `/control/*` is **denied by the allowlist**, so the agent can never reach the switch that makes the application misbehave. Only the test harness calls it.

```bash
npm run app     # http://127.0.0.1:4600, sign on with teller01 / demo-pass-2024
```

---

## Layout

```
apps/meridian/          The legacy stand-in application
goals/                  Goal definitions — the parameter contract for a discovery run
capabilities/           Recorded artifacts, one JSON file per version
evidence/               Committed demonstration runs
runs/                   Local run output (gitignored)

src/surface/            Surface abstraction — the seam for web / desktop / terminal
   types.ts               observe() and act(); nothing above this knows about browsers
   extractor.ts           Accessibility-equivalent view, incl. names derived from layout
   locator.ts             The strategy ladder and its confidence model
   matcher.ts             Pure matching, testable without a browser
   playwright-surface.ts  Web implementation
   guarded.ts             Allowlist + session-lease enforcement, as a decorator

src/capability/         The artifact: schema, recorder, store, per-product profiles
src/agent/              Discovery loop, prompts, model provider, transcript
src/replay/             Deterministic executor, checkpoints, result contract
src/policy/             Allowlist, risk classification, redaction
src/escalation/         Control lease, intervention routing, handoff, operator console
src/evidence/           Redacted run logging and capture
```

Design reasoning, trade-offs and what was deliberately cut: **[REPORT.md](REPORT.md)**.

---

## Tests

```bash
npm test
npm run typecheck
```

39 unit tests over the parts that fail quietly — locator matching, redaction, risk classification, allowlist rules, the control lease. 12 integration tests driving a real Chromium against the real app, covering the claims that only hold against a live surface: deterministic replay, parameterization across different inputs, business outcomes reported as outcomes, interstitial recovery, session-expiry classification, evidence capture, input validation, and the approval gate.
