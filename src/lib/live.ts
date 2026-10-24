import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Live updates, so the app does not need reloading to be right.
 *
 * The signup tracker is why this exists. A notification is sent AFTER
 * the response — on purpose, so a bounced email can never fail a signup
 * — which means the step recording it lands a second or two after the
 * page has already fetched. Without a push the page shows something
 * that stopped being true, until somebody reloads for a reason they
 * cannot see.
 *
 * One server-sent-events connection for the whole app. The browser
 * reconnects by itself, so there is no retry logic here; if it never
 * connects at all, the queries that care keep a slow poll of their own
 * and the page is late rather than wrong.
 */

/** Which queries each kind of change invalidates. */
const AFFECTS: Record<string, string[][]> = {
  signups: [["dm-signups"]],
  rfid: [["dm-rfid"], ["dm-rfid-options"]],
  users: [["dm-users"], ["dm-people"], ["dm-me"]],
  roles: [["dm-roles"], ["dm-users"], ["dm-people"], ["dm-me"]],
  settings: [["dm-notify"]],
};

export function useLiveUpdates(enabled: boolean): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;

    const source = new EventSource("/api/dutch-miller/events");

    source.addEventListener("change", (e) => {
      let topic = "";
      try {
        topic = (JSON.parse((e as MessageEvent).data) as { topic?: string }).topic ?? "";
      } catch { return; }
      for (const key of AFFECTS[topic] ?? []) {
        void qc.invalidateQueries({ queryKey: key });
      }
    });

    // Deliberately no handler beyond logging: EventSource reconnects on
    // its own, and anything clever here would fight it.
    source.onerror = () => { /* the browser will retry */ };

    return () => source.close();
  }, [enabled, qc]);
}
