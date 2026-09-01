const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const USD_CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const money = (n: number): string => USD.format(n);
export const moneyExact = (n: number): string => USD_CENTS.format(n);

export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export function timeOfDay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
