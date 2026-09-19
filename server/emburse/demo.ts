import { withFlags } from "./policy.js";
import type { EmburseProvider, ExpenseLine, ExpenseReport, FetchWindow, ProviderResult, ReportStatus } from "./types.js";

/**
 * Deterministic sample data used until Emburse credentials are supplied.
 *
 * It is seeded, so a refresh returns the same reports rather than reshuffling
 * under the reviewer, and it is dated relative to today so the review queue and
 * ageing flags stay meaningful. The API marks these responses `demo: true`, and
 * the UI shows a "not connected" banner — nothing here is ever presented as
 * real Emburse data.
 */

function rng(seed: number): () => number {
  // mulberry32 — small, fast, good enough for fixture data.
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EMPLOYEES = [
  ["Dana Whitfield", "Field Operations"],
  ["Marcus Ellery", "Field Operations"],
  ["Priya Raghavan", "Information Technology"],
  ["Tomas Berg", "Information Technology"],
  ["Alicia Monroe", "Marketing"],
  ["Jordan Hale", "Marketing"],
  ["Sam Okafor", "Finance"],
  ["Renee Castillo", "Site Operations"],
  ["Wesley Kim", "Site Operations"],
  ["Harper Nilsen", "People Operations"],
] as const;

const CATEGORIES = [
  ["Mileage", 18, 140],
  ["Fuel", 32, 95],
  ["Meals — Team", 24, 210],
  ["Meals — Individual", 11, 48],
  ["Lodging", 129, 420],
  ["Airfare", 210, 780],
  ["Site Supplies", 22, 340],
  ["Software & Subscriptions", 15, 620],
  ["Tools & Equipment", 45, 890],
  ["Parking & Tolls", 6, 38],
  ["Training & Certification", 95, 1250],
] as const;

const MERCHANTS: Record<string, string[]> = {
  Mileage: ["Personal Vehicle"],
  Fuel: ["QuikTrip", "Shell", "Buc-ee's", "Circle K"],
  "Meals — Team": ["Torchy's Tacos", "Chuy's", "Panera Bread", "Rudy's BBQ"],
  "Meals — Individual": ["Chipotle", "Starbucks", "Subway", "Whataburger"],
  Lodging: ["Hampton Inn", "Courtyard Marriott", "Holiday Inn Express"],
  Airfare: ["Southwest Airlines", "American Airlines", "Delta"],
  "Site Supplies": ["Grainger", "Home Depot", "Uline", "Fastenal"],
  "Software & Subscriptions": ["Adobe", "Atlassian", "Zoom", "Canva"],
  "Tools & Equipment": ["Northern Tool", "Harbor Freight", "Grainger"],
  "Parking & Tolls": ["NTTA", "SpotHero", "Airport Parking"],
  "Training & Certification": ["CompTIA", "Coursera", "ISSA"],
};

const REPORT_TITLES = [
  "Site visit — DFW cluster",
  "Weekly field expenses",
  "Regional manager travel",
  "Equipment restock",
  "Marketing event spend",
  "Conference travel",
  "Monthly software renewals",
  "New site opening",
  "Team offsite",
  "Vendor site audit",
];

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const round2 = (n: number): number => Math.round(n * 100) / 100;

export class DemoProvider implements EmburseProvider {
  readonly id = "demo";
  readonly label = "Demo data";

  async fetchReports(window: FetchWindow): Promise<ProviderResult> {
    const start = Date.parse(window.startDate);
    const end = Date.parse(window.endDate);
    const spanDays = Math.max(1, Math.round((end - start) / 86_400_000));
    const rand = rng(0x4d4f4a4f); // "MOJO"
    const reports: ExpenseReport[] = [];

    // Scale volume with the window so a 12-month view genuinely holds more
    // spend than a 30-day one, the way real data does.
    const count = Math.min(180, Math.max(14, Math.round(spanDays * 0.6)));

    for (let i = 0; i < count; i++) {
      const employee = EMPLOYEES[Math.floor(rand() * EMPLOYEES.length)]!;
      // Skew toward recent so the review queue is populated the way a real one
      // is — a backlog of fresh submissions over a tail of settled reports.
      const daysAgo = Math.floor(rand() ** 2 * spanDays);
      const submitted = new Date(end - daysAgo * 86_400_000);
      const status = pickStatus(rand(), daysAgo);
      const id = `DEMO-${String(1000 + i)}`;

      const lines: ExpenseLine[] = [];
      const lineCount = 2 + Math.floor(rand() * 7);
      for (let j = 0; j < lineCount; j++) {
        const [category, lo, hi] = CATEGORIES[Math.floor(rand() * CATEGORIES.length)]!;
        const merchants = MERCHANTS[category] ?? ["Misc Vendor"];
        const amount = round2(lo + rand() * (hi - lo));
        lines.push({
          id: `${id}-L${j + 1}`,
          reportId: id,
          date: iso(new Date(submitted.getTime() - Math.floor(rand() * 12) * 86_400_000)),
          category,
          merchant: merchants[Math.floor(rand() * merchants.length)]!,
          amount,
          currency: "USD",
          reimbursable: category !== "Software & Subscriptions",
          billable: rand() < 0.15,
          // Deliberately leave some larger lines without a receipt so the
          // missing-receipt flag has something to catch.
          hasReceipt: amount < 25 ? rand() < 0.4 : rand() > 0.18,
          receiptId: "",
          receiptUrl: "",
          glCode: `6${100 + Math.floor(rand() * 40)}`,
          note: rand() < 0.25 ? "Approved by regional manager" : "",
        });
      }

      // A receipted demo line gets an id so the viewer has something to open;
      // `receipts.ts` renders a placeholder image for any DEMO- id.
      for (const l of lines) if (l.hasReceipt) l.receiptId = `${l.id}-R`;

      // Seed one exact-duplicate pair every few reports.
      if (i % 7 === 3 && lines[0]) {
        lines.push({ ...lines[0], id: `${id}-L${lines.length + 1}` });
      }

      const total = round2(lines.reduce((a, l) => a + l.amount, 0));
      reports.push(
        withFlags({
          id,
          reference: id,
          name: REPORT_TITLES[i % REPORT_TITLES.length]!,
          employeeName: employee[0],
          employeeEmail: `${employee[0].toLowerCase().replace(/[^a-z]+/g, ".")}@mojocarwash.com`,
          department: employee[1],
          status,
          submittedDate: status === "draft" ? null : iso(submitted),
          approvedDate:
            status === "approved" || status === "processed"
              ? iso(new Date(submitted.getTime() + 2 * 86_400_000))
              : null,
          processedDate: status === "processed" ? iso(new Date(submitted.getTime() + 6 * 86_400_000)) : null,
          approverName: status === "draft" ? "" : "Eric S.",
          total,
          reimbursableTotal: round2(lines.filter((l) => l.reimbursable).reduce((a, l) => a + l.amount, 0)),
          currency: "USD",
          lineCount: lines.length,
          lines,
        }),
      );
    }

    return {
      reports,
      warnings: ["Emburse is not connected — every figure on this page is generated sample data."],
      fetchedAt: new Date().toISOString(),
    };
  }
}

function pickStatus(r: number, daysAgo: number): ReportStatus {
  // Recent reports skew toward the review queue; older ones toward processed.
  if (daysAgo < 14) return r < 0.62 ? "submitted" : r < 0.85 ? "approved" : "draft";
  if (daysAgo < 45) return r < 0.3 ? "submitted" : r < 0.5 ? "approved" : r < 0.93 ? "processed" : "rejected";
  return r < 0.08 ? "rejected" : "processed";
}
