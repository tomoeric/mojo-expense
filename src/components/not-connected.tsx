import { PlugZap } from "lucide-react";
import type { ConfigResponse } from "@/lib/api";

/**
 * Shown whenever the API answered `demo: true`. Being loud about this matters —
 * every number on screen is fabricated until Emburse credentials are set, and a
 * reviewer must never mistake sample data for their queue.
 */
export function NotConnected({ config }: { config: ConfigResponse | undefined }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
      <div className="flex items-start gap-3">
        <PlugZap className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-amber-900">
            Emburse is not connected — showing sample data
          </p>
          <p className="mt-1 text-amber-800">
            Nothing on this page is real. Set{" "}
            {(config?.missing ?? ["EMBURSE_API_KEY", "EMBURSE_API_SECRET"]).map((k, i, all) => (
              <span key={k}>
                <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs">{k}</code>
                {i < all.length - 1 ? ", " : ""}
              </span>
            ))}{" "}
            as Replit Secrets and restart to pull the live{" "}
            {config?.product === "professional" ? "Emburse Professional" : config?.product ?? "Emburse"} queue.
          </p>
        </div>
      </div>
    </div>
  );
}
