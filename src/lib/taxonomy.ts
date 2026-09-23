import { useQuery } from "@tanstack/react-query";

/**
 * The permanent lists of Categories, Locations/Sites and Departments.
 *
 * Read-only, and slow-moving: a list only changes when an import brings in a
 * name nobody has used before, so there is no polling here.
 */

export const KINDS = ["category", "location", "department"] as const;
export type Kind = (typeof KINDS)[number];

export type TaxonomyEntry = {
  name: string;
  parent: string | null;
  leaf: string;
  firstSeen: string;
  lastSeen: string;
  uses: number;
  waiting: number;
  totalCents: number;
  lastUsed: string | null;
};

export type TaxonomyList = {
  kind: Kind;
  label: { one: string; many: string };
  entries: TaxonomyEntry[];
  blank: number;
  expenses: number;
};

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const text = await res.text();
  let body: (T & { error?: string }) | null = null;
  try {
    body = JSON.parse(text) as T & { error?: string };
  } catch {
    throw new Error(`The server replied with something unexpected (${res.status}).`);
  }
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
  return body;
}

export function useTaxonomy(kind: Kind) {
  return useQuery({
    queryKey: ["taxonomy", kind],
    queryFn: () => get<TaxonomyList>(`/api/taxonomy/${kind}`),
    staleTime: 60_000,
  });
}

export function useTaxonomyCounts(enabled = true) {
  return useQuery({
    queryKey: ["taxonomy", "counts"],
    queryFn: () => get<{ counts: Record<Kind, number> }>("/api/taxonomy"),
    staleTime: 60_000,
    enabled,
  });
}

/** Names first seen inside this window are shown as new. */
export const NEW_FOR_DAYS = 14;

export const isNew = (e: TaxonomyEntry): boolean =>
  Date.now() - Date.parse(e.firstSeen) < NEW_FOR_DAYS * 86_400_000;
