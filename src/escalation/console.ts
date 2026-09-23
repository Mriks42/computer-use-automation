/**
 * The operator console.
 *
 * Explicitly a mock, per the brief's scope note — there is no co-browsing video
 * stream here, no queue, no auth, no operator roster. What it is not mocking is
 * the part that matters: the request it displays is the real
 * InterventionRequest, the buttons drive the real ControlBroker, and the browser
 * window the operator drives is the same one the automation was driving a
 * moment ago.
 *
 * The co-browsing piece is the honest cut. In production the operator would not
 * be sitting at the machine running the automation, so the live surface has to
 * reach them — a CDP screencast over a websocket, or a container running the
 * browser with a VNC/WebRTC channel out. Both replace this page's "the browser
 * window is next to you" assumption. Neither changes the control model, which
 * is the thing that is genuinely hard to get right and is therefore the thing
 * built for real here.
 */

import express, { type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import type { HandoffCoordinator } from "./handoff.js";
import type { InterventionRequest, InterventionStore } from "./intervention.js";
import type { ControlBroker } from "./lease.js";

const STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f5f6f8; color: #1b1f24; }
  header { background: #12243d; color: #fff; padding: 14px 22px; display: flex; justify-content: space-between; align-items: center; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: 0.3px; }
  .lease { font-size: 12px; font-family: ui-monospace, monospace; background: rgba(255,255,255,0.14); padding: 4px 10px; border-radius: 4px; }
  main { max-width: 980px; margin: 22px auto; padding: 0 18px; }
  .card { background: #fff; border: 1px solid #dde1e6; border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
  .card h2 { font-size: 14px; margin: 0; padding: 11px 16px; border-bottom: 1px solid #e6e9ed; background: #fafbfc; }
  .card .body { padding: 16px; }
  dl { display: grid; grid-template-columns: 170px 1fr; gap: 7px 14px; margin: 0; font-size: 13px; }
  dt { color: #626b75; }
  dd { margin: 0; font-family: ui-monospace, monospace; word-break: break-word; }
  pre { background: #f6f8fa; border: 1px solid #e3e7eb; padding: 11px; border-radius: 4px; font-size: 12px; max-height: 260px; overflow: auto; white-space: pre-wrap; }
  img.shot { max-width: 100%; border: 1px solid #d0d5da; border-radius: 4px; }
  .pill { display: inline-block; font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
  .open { background: #fdf0d5; color: #8a5a00; }
  .taken { background: #d9e8fb; color: #14457e; }
  .resolved { background: #dcf0dc; color: #1d6b25; }
  .aborted { background: #fadcdc; color: #8c1c1c; }
  form { margin-top: 14px; display: flex; gap: 9px; flex-wrap: wrap; align-items: center; }
  input[type=text] { padding: 7px 10px; border: 1px solid #c3c9d0; border-radius: 4px; font-size: 13px; min-width: 230px; }
  button { padding: 7px 15px; border: 0; border-radius: 4px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .primary { background: #1a63c4; color: #fff; }
  .danger { background: #b02a2a; color: #fff; }
  a { color: #1a63c4; }
  .empty { color: #6b747d; font-size: 13px; }
  .note { background: #fff8e2; border-left: 3px solid #d9a319; padding: 10px 13px; font-size: 12.5px; margin-bottom: 16px; }
`;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(leaseLabel: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Operator Console</title>
<meta http-equiv="refresh" content="5">
<style>${STYLE}</style></head>
<body>
<header>
  <h1>Operator Console &mdash; Computer-Use Automation</h1>
  <span class="lease">lease: ${escapeHtml(leaseLabel)}</span>
</header>
<main>${body}</main>
</body></html>`;
}

function requestCard(request: InterventionRequest, detailed: boolean): string {
  const rows: [string, string][] = [
    ["Intervention", request.id],
    ["Kind", request.kind],
    ["Run", request.runId],
    ["Raised", request.createdAt],
  ];
  if (request.goal) rows.push(["Goal", request.goal]);
  if (request.capabilityId) {
    rows.push(["Capability", `${request.capabilityId}@${request.capabilityVersion ?? "?"}`]);
  }
  if (request.stepId) rows.push(["Step", `${request.stepIndex ?? "?"} — ${request.stepId}`]);
  rows.push(["Reason", request.reason]);
  if (request.expected) rows.push(["Expected", request.expected]);
  if (request.observed) rows.push(["Observed", request.observed]);
  if (request.proposedAction) {
    rows.push(["Awaiting approval", `${request.proposedAction.description} (${request.proposedAction.risk})`]);
  }
  rows.push(["Screen", `${request.context.title} — ${request.context.location}`]);

  const dl = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("");

  const actions =
    request.status === "open"
      ? `<form method="POST" action="/intervention/${request.id}/take">
           <input type="text" name="actor" placeholder="Your operator ID" required>
           <button class="primary" type="submit">Take control of live session</button>
         </form>`
      : request.status === "taken"
        ? `<div class="note">You hold the session lease. Operate the browser window that is already open,
             complete the manual steps, then hand control back.</div>
           <form method="POST" action="/intervention/${request.id}/return">
             <input type="text" name="note" placeholder="What did you do?" required>
             <button class="primary" name="decision" value="approved" type="submit">Hand control back</button>
             <button class="danger" name="decision" value="rejected" type="submit">Abort run</button>
           </form>`
        : `<p class="empty">Resolved by ${escapeHtml(request.resolution?.actor ?? "unknown")} —
             ${escapeHtml(request.resolution?.note ?? "")}</p>`;

  const humanActions = request.resolution?.humanActions?.length
    ? `<h2>Recorded operator actions</h2><div class="body"><pre>${escapeHtml(
        request.resolution.humanActions
          .map((a) => `${a.at}  ${a.type.padEnd(8)} ${a.target ?? ""}${a.valueLength !== undefined ? `  (${a.valueLength} chars)` : ""}`)
          .join("\n"),
      )}</pre></div>`
    : "";

  const screenshot =
    detailed && request.context.screenshotPath
      ? `<h2>Screen at the moment of escalation</h2>
         <div class="body"><img class="shot" src="/screenshot/${request.id}" alt="screen capture"></div>`
      : "";

  const excerpt = detailed
    ? `<h2>Visible text (redacted)</h2><div class="body"><pre>${escapeHtml(request.context.textExcerpt)}</pre></div>`
    : "";

  return `<div class="card">
    <h2>${escapeHtml(request.reason)} <span class="pill ${request.status}">${request.status}</span></h2>
    <div class="body">
      <dl>${dl}</dl>
      ${request.suggestedAction ? `<div class="note" style="margin-top:14px;">Suggested: ${escapeHtml(request.suggestedAction)}</div>` : ""}
      ${actions}
      ${detailed ? "" : `<p style="margin-top:12px;"><a href="/intervention/${request.id}">Open full context &rarr;</a></p>`}
    </div>
    ${screenshot}
    ${excerpt}
    ${humanActions}
  </div>`;
}

export function createOperatorConsole(
  store: InterventionStore,
  coordinator: HandoffCoordinator,
  broker: ControlBroker,
) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  const leaseLabel = () => {
    const state = broker.state();
    return `${state.controller}${state.actor ? ` (${state.actor})` : ""}`;
  };

  app.get("/", (_req: Request, res: Response) => {
    const requests = store.list();
    const open = requests.filter((r) => r.status === "open" || r.status === "taken");
    const closed = requests.filter((r) => r.status === "resolved" || r.status === "aborted");

    const body =
      (open.length
        ? open.map((r) => requestCard(r, false)).join("")
        : `<div class="card"><div class="body"><p class="empty">No open interventions. Automation holds the session.</p></div></div>`) +
      (closed.length
        ? `<div class="card"><h2>History</h2><div class="body">${closed
            .map(
              (r) =>
                `<p><span class="pill ${r.status}">${r.status}</span>
                 <a href="/intervention/${r.id}">${escapeHtml(r.id)}</a> — ${escapeHtml(r.reason)}</p>`,
            )
            .join("")}</div></div>`
        : "");

    res.send(layout(leaseLabel(), body));
  });

  app.get("/intervention/:id", (req: Request, res: Response) => {
    const request = store.get(String(req.params.id));
    if (!request) {
      res.status(404).send(layout(leaseLabel(), `<div class="card"><div class="body">Not found.</div></div>`));
      return;
    }
    res.send(layout(leaseLabel(), requestCard(request, true) + `<p><a href="/">&larr; All interventions</a></p>`));
  });

  app.get("/screenshot/:id", (req: Request, res: Response) => {
    const request = store.get(String(req.params.id));
    const path = request?.context.screenshotPath;
    if (!path) {
      res.status(404).end();
      return;
    }
    try {
      res.setHeader("Content-Type", "image/png");
      res.send(readFileSync(path));
    } catch {
      res.status(404).end();
    }
  });

  app.post("/intervention/:id/take", (req: Request, res: Response) => {
    const actor = String(req.body?.actor ?? "").trim() || "operator";
    coordinator.takeControl(String(req.params.id), actor);
    res.redirect(`/intervention/${req.params.id}`);
  });

  app.post("/intervention/:id/return", async (req: Request, res: Response) => {
    const decision = String(req.body?.decision ?? "approved") as "approved" | "rejected";
    const note = String(req.body?.note ?? "").trim() || "(no note)";
    const request = store.get(String(req.params.id));
    const actor = request?.resolution?.actor ?? "operator";
    await coordinator.returnControl(String(req.params.id), { actor, note, decision });
    res.redirect(`/intervention/${req.params.id}`);
  });

  return app;
}

export function startOperatorConsole(
  store: InterventionStore,
  coordinator: HandoffCoordinator,
  broker: ControlBroker,
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createOperatorConsole(store, coordinator, broker);
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
