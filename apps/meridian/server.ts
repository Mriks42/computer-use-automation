/**
 * Meridian Core — a stand-in for a legacy credit-union back-office application.
 *
 * Why a local app rather than a public demo site: the brief asks replay to be
 * driven into runtime exceptional states (not-found, permission denial, session
 * expiry, unexpected dialogs, transient slowness, app errors). No public site
 * will produce those on demand, and automating one to try would violate its
 * terms. Owning the target makes the error paths reproducible and the evidence
 * honest.
 *
 * Fault injection is driven through /control/inject, which is deliberately NOT
 * part of the automated surface: the allowlist denies it, so the agent can never
 * reach it. Only the test harness calls it.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { findMember, searchMembers, type Member } from "./data.js";
import * as views from "./views.js";

const SESSION_COOKIE = "mc_session";

interface Session {
  id: string;
  operator: string;
  createdAt: number;
}

interface InjectionState {
  /** Invalidate the session on the next page request. */
  sessionTimeout: boolean;
  /**
   * Invalidate the session after N further page requests.
   *
   * Immediate expiry is not a useful test: the flow simply signs on again and
   * proceeds. Expiry has to land *mid-flow*, after authentication, to exercise
   * the path where a replay is already several steps in when the application
   * signs it out. A countdown makes that deterministic.
   */
  sessionTimeoutAfter: number | null;
  /** Show an unscheduled interstitial before the next page. */
  interstitial: boolean;
  /** Return HTTP 500 on the next page request. */
  appError: boolean;
  /** Deny access to any member on the next detail view. */
  permissionDenied: boolean;
  /** Delay every response by this many milliseconds. */
  slowMs: number;
}

const freshInjection = (): InjectionState => ({
  sessionTimeout: false,
  sessionTimeoutAfter: null,
  interstitial: false,
  appError: false,
  permissionDenied: false,
  slowMs: 0,
});

export function createMeridianApp() {
  const sessions = new Map<string, Session>();
  let injection = freshInjection();

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  const readCookies = (req: Request): Record<string, string> => {
    const header = req.headers.cookie;
    if (!header) return {};
    return Object.fromEntries(
      header.split(";").map((part) => {
        const idx = part.indexOf("=");
        return idx === -1
          ? [part.trim(), ""]
          : [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
      }),
    );
  };

  const currentSession = (req: Request): Session | undefined => {
    const id = readCookies(req)[SESSION_COOKIE];
    return id ? sessions.get(id) : undefined;
  };

  // ---- Fault-injection control plane (not part of the automated surface) ----

  app.post("/control/inject", express.json(), (req: Request, res: Response) => {
    injection = { ...injection, ...(req.body ?? {}) };
    res.json({ ok: true, injection });
  });

  app.post("/control/reset", (_req: Request, res: Response) => {
    injection = freshInjection();
    sessions.clear();
    res.json({ ok: true });
  });

  app.get("/control/state", (_req: Request, res: Response) => {
    res.json({ injection, sessions: sessions.size });
  });

  // ---- Injected-fault middleware, in the order a real app would fail ----

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/control/")) return next();

    if (injection.slowMs > 0) {
      await new Promise((r) => setTimeout(r, injection.slowMs));
    }

    if (injection.appError) {
      injection.appError = false;
      res.status(500).send(views.appError());
      return;
    }

    if (injection.sessionTimeoutAfter !== null && req.path !== "/login") {
      if (injection.sessionTimeoutAfter <= 0) {
        injection.sessionTimeoutAfter = null;
        sessions.clear();
        res.status(200).send(views.loginPage("Your session has expired. Please sign on again."));
        return;
      }
      injection.sessionTimeoutAfter -= 1;
    }

    if (injection.sessionTimeout) {
      injection.sessionTimeout = false;
      sessions.clear();
      res.status(200).send(views.loginPage("Your session has expired. Please sign on again."));
      return;
    }

    next();
  });

  // ---- Authentication ----

  app.get("/", (req: Request, res: Response) => {
    if (currentSession(req)) return res.redirect("/desk");
    res.send(views.loginPage());
  });

  app.post("/login", (req: Request, res: Response) => {
    const username = String(req.body?.username ?? "");
    const password = String(req.body?.password ?? "");
    const expectedUser = process.env.MERIDIAN_USERNAME ?? "teller01";
    const expectedPass = process.env.MERIDIAN_PASSWORD ?? "demo-pass-2024";

    if (username !== expectedUser || password !== expectedPass) {
      res.status(200).send(views.loginPage("Invalid operator ID or password."));
      return;
    }

    const session: Session = { id: randomUUID(), operator: username, createdAt: Date.now() };
    sessions.set(session.id, session);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly`);
    res.redirect("/desk");
  });

  app.get("/logout", (req: Request, res: Response) => {
    const id = readCookies(req)[SESSION_COOKIE];
    if (id) sessions.delete(id);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    res.send(views.loginPage("You have been signed off."));
  });

  // ---- Authenticated area ----

  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const session = currentSession(req);
    if (!session) {
      res.status(200).send(views.loginPage("Your session has expired. Please sign on again."));
      return;
    }
    res.locals.session = session;
    next();
  };

  // Interstitials appear between pages, which is what makes them awkward: they
  // are not tied to any particular step in a recorded flow.
  const maybeInterstitial = (req: Request, res: Response, next: NextFunction) => {
    if (injection.interstitial) {
      injection.interstitial = false;
      res.send(views.interstitial(req.originalUrl));
      return;
    }
    next();
  };

  app.get("/desk", requireSession, (_req: Request, res: Response) => {
    res.send(views.deskFrameset());
  });

  app.get("/nav", requireSession, (_req: Request, res: Response) => {
    res.send(views.navFrame());
  });

  app.get("/main", requireSession, (_req: Request, res: Response) => {
    res.send(views.mainHome(res.locals.session.operator));
  });

  app.get("/reports", requireSession, maybeInterstitial, (_req: Request, res: Response) => {
    res.send(views.reportsPage());
  });

  app.get("/search", requireSession, maybeInterstitial, (_req: Request, res: Response) => {
    res.send(views.searchPage());
  });

  app.get("/search/results", requireSession, maybeInterstitial, (req: Request, res: Response) => {
    const query = String(req.query.q ?? "");
    if (!query.trim()) {
      res.send(views.searchPage("Enter a member number or last name to search."));
      return;
    }
    res.send(views.searchResults(query, searchMembers(query)));
  });

  const loadMember = (req: Request, res: Response): Member | undefined => {
    const id = String(req.params.id ?? "");
    const member = findMember(id);
    if (!member) {
      res.send(views.searchResults(id, []));
      return undefined;
    }
    if (member.status === "restricted" || injection.permissionDenied) {
      injection.permissionDenied = false;
      res.status(200).send(views.permissionDenied(id));
      return undefined;
    }
    return member;
  };

  app.get("/member/:id", requireSession, maybeInterstitial, (req: Request, res: Response) => {
    const member = loadMember(req, res);
    if (member) res.send(views.memberDetail(member));
  });

  app.get("/member/:id/subaccount/new", requireSession, maybeInterstitial, (req: Request, res: Response) => {
    const member = loadMember(req, res);
    if (member) res.send(views.subAccountForm(member));
  });

  app.post("/member/:id/subaccount/create", requireSession, (req: Request, res: Response) => {
    const member = loadMember(req, res);
    if (!member) return;

    const accountType = String(req.body?.accountType ?? "");
    const rawDeposit = String(req.body?.initialDeposit ?? "").replace(/[$,]/g, "");
    const deposit = Number(rawDeposit);

    if (!accountType) {
      res.send(views.subAccountForm(member, "Account Type is required."));
      return;
    }
    if (!rawDeposit || Number.isNaN(deposit)) {
      res.send(views.subAccountForm(member, "Initial Deposit must be a valid amount."));
      return;
    }
    if (deposit < 25) {
      res.send(views.subAccountForm(member, "Initial Deposit must be at least $25.00."));
      return;
    }

    const ref = `SA-${Date.now().toString().slice(-8)}`;
    res.send(
      views.subAccountConfirmation(member, ref, accountType, deposit.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      })),
    );
  });

  return app;
}

export function startMeridian(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createMeridianApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
