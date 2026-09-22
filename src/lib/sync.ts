import { useMutation, useQueryClient, useIsMutating } from "@tanstack/react-query";

/**
 * Pulling the SharePoint folder, as shared state rather than page state.
 *
 * A sync downloads an 11 MB PDF, parses 200-odd pages and renders every
 * receipt, so it runs for a while. When it lived in the Import page's local
 * state, navigating away mid-sync tore the request's owner down: the spinner
 * vanished, the result landed nowhere, and the queue still showed the old data
 * until someone reloaded.
 *
 * A mutation keyed on the query client survives route changes, because the
 * client outlives the component tree. `useSyncStatus` then lets any page — the
 * header, say — show that one is in flight.
 */

export type SyncResult = {
  checked: number;
  skipped: number;
  imported: { name: string; inserted: number; updated: number; receipts: number; reconciled: boolean }[];
  failed: { name: string; error: string }[];
};

export const SYNC_KEY = ["sharepoint-sync"];

export function useSync() {
  const qc = useQueryClient();

  return useMutation({
    mutationKey: SYNC_KEY,
    mutationFn: async (): Promise<SyncResult> => {
      const res = await fetch("/api/import/sync", { method: "POST" });
      const body = (await res.json()) as SyncResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Sync failed (${res.status})`);
      return body;
    },
    // Always refresh, even when nothing imported: a sync that found nothing
    // still proves the folder was read, and the cheapest way to be sure the
    // screen is not stale is to not reason about when it might be.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["reports"] });
      void qc.invalidateQueries({ queryKey: ["imports"] });
    },
  });
}

/** Whether a sync is running, from anywhere in the tree. */
export function useSyncStatus(): boolean {
  return useIsMutating({ mutationKey: SYNC_KEY }) > 0;
}

/** One line describing what a finished sync did. */
export function describeSync(r: SyncResult): string {
  if (r.imported.length === 0) {
    return `Checked ${r.checked} file${r.checked === 1 ? "" : "s"} in SharePoint — nothing new.`;
  }
  return (
    `Imported ${r.imported.length}: ` +
    r.imported.map((i) => `${i.name} (+${i.inserted} new, ${i.receipts} receipts)`).join(", ")
  );
}
