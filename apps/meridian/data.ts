/**
 * Fake member data for the Meridian Core stand-in app.
 *
 * Every value here is synthetic. The SSN-shaped and account-number-shaped fields
 * exist specifically so the redaction layer has something realistic to catch —
 * see src/policy/redact.ts and the redaction tests.
 */

export type MemberStatus = "active" | "restricted" | "closed";

export interface Account {
  number: string;
  type: "Savings" | "Checking" | "Certificate";
  balance: number;
  opened: string;
}

export interface Member {
  id: string;
  firstName: string;
  lastName: string;
  status: MemberStatus;
  ssn: string;
  branch: string;
  memberSince: string;
  accounts: Account[];
}

export const MEMBERS: Member[] = [
  {
    id: "10001",
    firstName: "Dana",
    lastName: "Whitfield",
    status: "active",
    ssn: "412-55-9034",
    branch: "Riverside",
    memberSince: "2014-03-11",
    accounts: [
      { number: "4410029947", type: "Savings", balance: 8241.55, opened: "2014-03-11" },
      { number: "4410029948", type: "Checking", balance: 1902.13, opened: "2014-03-11" },
      { number: "4410031120", type: "Certificate", balance: 25000.0, opened: "2019-07-02" },
    ],
  },
  {
    id: "10002",
    firstName: "Marcus",
    lastName: "Oyelaran",
    status: "active",
    ssn: "388-21-7741",
    branch: "Downtown",
    memberSince: "2008-11-24",
    accounts: [
      { number: "4410044201", type: "Savings", balance: 312.08, opened: "2008-11-24" },
      { number: "4410044202", type: "Checking", balance: 4780.9, opened: "2011-02-15" },
    ],
  },
  {
    id: "10003",
    firstName: "Priya",
    lastName: "Raghunathan",
    status: "active",
    ssn: "509-63-2218",
    branch: "Riverside",
    memberSince: "2021-06-30",
    accounts: [{ number: "4410077310", type: "Savings", balance: 15630.42, opened: "2021-06-30" }],
  },
  {
    id: "99001",
    firstName: "Eleanor",
    lastName: "Vasquez",
    status: "restricted",
    ssn: "221-40-8876",
    branch: "Executive",
    memberSince: "1998-01-09",
    accounts: [{ number: "4410000001", type: "Savings", balance: 942110.77, opened: "1998-01-09" }],
  },
  {
    id: "10004",
    firstName: "Tobias",
    lastName: "Lindqvist",
    status: "closed",
    ssn: "674-19-3302",
    branch: "Downtown",
    memberSince: "2016-09-14",
    accounts: [{ number: "4410051188", type: "Savings", balance: 0.0, opened: "2016-09-14" }],
  },
];

export function findMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id.trim());
}

export function searchMembers(query: string): Member[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return MEMBERS.filter(
    (m) =>
      m.id === q ||
      m.lastName.toLowerCase().includes(q) ||
      m.firstName.toLowerCase().includes(q) ||
      `${m.firstName} ${m.lastName}`.toLowerCase().includes(q),
  );
}

export function formatCurrency(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
