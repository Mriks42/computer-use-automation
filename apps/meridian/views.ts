/**
 * HTML for the Meridian Core stand-in.
 *
 * The markup here is intentionally hostile, modelled on real back-office software:
 * frameset navigation, table-based layout, no test IDs, no `for`/`id` label
 * association, inline event handlers. Form fields take their meaning from the
 * text in the adjacent table cell rather than from any accessible attribute.
 *
 * This is the point of the app. Automation that only works against clean markup
 * proves nothing about the environment this system targets.
 */

import { formatCurrency, type Account, type Member } from "./data.js";

const CHROME_STYLE = `
  body { font-family: Verdana, Geneva, sans-serif; font-size: 12px; background: #dfe3e8; margin: 0; padding: 0; }
  table { border-collapse: collapse; }
  .panel { background: #ffffff; border: 2px solid #8a9199; margin: 8px; }
  .panel-title { background: #1f3d63; color: #ffffff; font-weight: bold; padding: 4px 8px; font-size: 12px; }
  .grid td { border: 1px solid #b8bfc7; padding: 3px 7px; }
  .grid th { border: 1px solid #b8bfc7; padding: 3px 7px; background: #c6cdd4; text-align: left; }
  .formtable td { padding: 4px 6px; }
  .err { background: #ffe8e8; border: 2px solid #a11; color: #7a0000; padding: 8px; margin: 8px; font-weight: bold; }
  .warn { background: #fff8d8; border: 2px solid #c9a227; padding: 8px; margin: 8px; }
  .ok { background: #e8f6e8; border: 2px solid #2a7a2a; padding: 8px; margin: 8px; font-weight: bold; }
  input[type=text], input[type=password], select { border: 1px solid #7a828a; font-family: Verdana; font-size: 12px; padding: 2px; }
  input[type=submit], button { font-family: Verdana; font-size: 12px; padding: 2px 10px; }
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>${title}</title><style>${CHROME_STYLE}</style></head>
<body>
${body}
</body>
</html>`;
}

export function loginPage(message?: string): string {
  // No labels, no ids. The field meaning lives in the table cell to the left.
  return page(
    "Meridian Core - Sign On",
    `
<div class="panel" style="width: 420px; margin: 60px auto;">
  <div class="panel-title">Meridian Core Banking &mdash; Operator Sign On</div>
  ${message ? `<div class="warn">${message}</div>` : ""}
  <form method="POST" action="/login">
    <table class="formtable" style="margin: 12px;">
      <tr>
        <td align="right"><b>Operator ID:</b></td>
        <td><input type="text" name="username" size="24"></td>
      </tr>
      <tr>
        <td align="right"><b>Password:</b></td>
        <td><input type="password" name="password" size="24"></td>
      </tr>
      <tr>
        <td></td>
        <td><input type="submit" value="Sign On"></td>
      </tr>
    </table>
  </form>
</div>`,
  );
}

export function deskFrameset(): string {
  return `<!DOCTYPE html>
<html>
<head><title>Meridian Core - Operator Desk</title></head>
<frameset cols="180,*" border="2">
  <frame name="navframe" src="/nav">
  <frame name="mainframe" src="/main">
</frameset>
</html>`;
}

export function navFrame(): string {
  return page(
    "Navigation",
    `
<div style="background:#1f3d63; color:#fff; padding:6px; font-weight:bold;">MERIDIAN</div>
<table style="width:100%; margin-top:6px;">
  <tr><td><a href="/main" target="mainframe">Home</a></td></tr>
  <tr><td><a href="/search" target="mainframe">Member Search</a></td></tr>
  <tr><td><a href="/reports" target="mainframe">Reports</a></td></tr>
  <tr><td><a href="/logout" target="_top">Sign Off</a></td></tr>
</table>`,
  );
}

export function mainHome(operator: string): string {
  return page(
    "Home",
    `
<div class="panel">
  <div class="panel-title">Operator Desk</div>
  <div style="padding:10px;">
    Signed on as <b>${operator}</b>.<br><br>
    Select a function from the navigation panel.
  </div>
</div>`,
  );
}

export function searchPage(error?: string): string {
  // The search input has no label element, no id, and no placeholder.
  return page(
    "Member Search",
    `
<div class="panel">
  <div class="panel-title">Member Search</div>
  ${error ? `<div class="err">${error}</div>` : ""}
  <form method="GET" action="/search/results">
    <table class="formtable" style="margin:10px;">
      <tr>
        <td align="right"><b>Member ID or Last Name:</b></td>
        <td><input type="text" name="q" size="28"></td>
        <td><input type="submit" value="Search"></td>
      </tr>
    </table>
  </form>
</div>`,
  );
}

export function searchResults(query: string, results: Member[]): string {
  if (results.length === 0) {
    // A legitimate business outcome, not an application error. Rendered as a
    // normal page with HTTP 200 so replay has to detect it from content.
    return page(
      "Member Search - No Results",
      `
<div class="panel">
  <div class="panel-title">Member Search Results</div>
  <div class="warn">No member found matching "${query}". Verify the member number and try again.</div>
  <div style="padding:10px;"><a href="/search">Return to search</a></div>
</div>`,
    );
  }

  const rows = results
    .map(
      (m) => `
      <tr>
        <td><a href="/member/${m.id}">${m.id}</a></td>
        <td>${m.lastName}, ${m.firstName}</td>
        <td>${m.branch}</td>
        <td>${m.status.toUpperCase()}</td>
      </tr>`,
    )
    .join("");

  return page(
    "Member Search Results",
    `
<div class="panel">
  <div class="panel-title">Member Search Results</div>
  <div style="padding:10px;">${results.length} record(s) matched "${query}".</div>
  <table class="grid" style="margin:10px;">
    <tr><th>Member No</th><th>Name</th><th>Branch</th><th>Status</th></tr>
    ${rows}
  </table>
</div>`,
  );
}

export function memberDetail(member: Member): string {
  const accountRows = member.accounts
    .map(
      (a: Account) => `
      <tr>
        <td>${a.type}</td>
        <td>${a.number}</td>
        <td align="right">${formatCurrency(a.balance)}</td>
        <td>${a.opened}</td>
      </tr>`,
    )
    .join("");

  return page(
    `Member ${member.id}`,
    `
<div class="panel">
  <div class="panel-title">Member Detail &mdash; ${member.id}</div>
  <table class="formtable" style="margin:10px;">
    <tr><td align="right"><b>Member No:</b></td><td>${member.id}</td>
        <td align="right"><b>Status:</b></td><td>${member.status.toUpperCase()}</td></tr>
    <tr><td align="right"><b>Name:</b></td><td>${member.firstName} ${member.lastName}</td>
        <td align="right"><b>Branch:</b></td><td>${member.branch}</td></tr>
    <tr><td align="right"><b>Member Since:</b></td><td>${member.memberSince}</td>
        <td align="right"><b>Tax ID:</b></td><td>${member.ssn}</td></tr>
  </table>
</div>

<div class="panel">
  <div class="panel-title">Share Accounts</div>
  <table class="grid" style="margin:10px;">
    <tr><th>Type</th><th>Account No</th><th>Current Balance</th><th>Opened</th></tr>
    ${accountRows}
  </table>
  <div style="padding:10px;">
    <a href="/member/${member.id}/subaccount/new">Open Sub-Account</a>
  </div>
</div>`,
  );
}

export function permissionDenied(memberId: string): string {
  return page(
    "Access Denied",
    `
<div class="panel">
  <div class="panel-title">Access Denied</div>
  <div class="err">
    You do not have permission to view member ${memberId}.
    This record is restricted. Contact your branch administrator.
  </div>
  <div style="padding:10px;"><a href="/search">Return to search</a></div>
</div>`,
  );
}

export function subAccountForm(member: Member, error?: string): string {
  // Label-less fields again; meaning comes from the left-hand cell text.
  return page(
    "Open Sub-Account",
    `
<div class="panel">
  <div class="panel-title">Open Sub-Account &mdash; Member ${member.id}</div>
  ${error ? `<div class="err">${error}</div>` : ""}
  <form method="POST" action="/member/${member.id}/subaccount/create">
    <table class="formtable" style="margin:10px;">
      <tr>
        <td align="right"><b>Account Type:</b></td>
        <td>
          <select name="accountType">
            <option value="">-- Select --</option>
            <option value="Savings">Savings</option>
            <option value="Checking">Checking</option>
            <option value="Certificate">Certificate</option>
          </select>
        </td>
      </tr>
      <tr>
        <td align="right"><b>Initial Deposit:</b></td>
        <td><input type="text" name="initialDeposit" size="14"></td>
      </tr>
      <tr>
        <td align="right"><b>Account Nickname:</b></td>
        <td><input type="text" name="nickname" size="24"></td>
      </tr>
      <tr>
        <td></td>
        <td><input type="submit" value="Submit Request"></td>
      </tr>
    </table>
  </form>
</div>`,
  );
}

export function subAccountConfirmation(member: Member, ref: string, type: string, deposit: string): string {
  return page(
    "Sub-Account Confirmation",
    `
<div class="panel">
  <div class="panel-title">Sub-Account Request Confirmation</div>
  <div class="ok">Sub-account request recorded successfully.</div>
  <table class="formtable" style="margin:10px;">
    <tr><td align="right"><b>Confirmation Number:</b></td><td>${ref}</td></tr>
    <tr><td align="right"><b>Member No:</b></td><td>${member.id}</td></tr>
    <tr><td align="right"><b>Account Type:</b></td><td>${type}</td></tr>
    <tr><td align="right"><b>Initial Deposit:</b></td><td>${deposit}</td></tr>
  </table>
</div>`,
  );
}

export function interstitial(returnTo: string): string {
  // Unscheduled interstitial. Appears between any two steps and must be
  // acknowledged before the underlying page is reachable.
  return page(
    "System Notice",
    `
<div class="panel" style="width:480px; margin:40px auto;">
  <div class="panel-title">System Notice</div>
  <div class="warn">
    Scheduled maintenance will occur this weekend. Core services may be
    unavailable Saturday 02:00&ndash;06:00 ET.
  </div>
  <div style="padding:10px;">
    <form method="GET" action="${returnTo}">
      <input type="submit" value="Acknowledge">
    </form>
  </div>
</div>`,
  );
}

export function appError(): string {
  return page(
    "System Error",
    `
<div class="panel">
  <div class="panel-title">System Error</div>
  <div class="err">
    An unexpected error occurred while processing your request.
    Reference MC-5000. Contact technical support.
  </div>
</div>`,
  );
}

export function reportsPage(): string {
  return page(
    "Reports",
    `
<div class="panel">
  <div class="panel-title">Reports</div>
  <div style="padding:10px;">No reports are available for your operator role.</div>
</div>`,
  );
}
