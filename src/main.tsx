import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { installPartnerHeader } from "./lib/partner";
import "./index.css";

/*
 * Before anything renders, and before any query runs.
 *
 * Every Dutch Miller request has to carry the partner account the
 * address bar is in. Installed here rather than inside the shell
 * because a query fired during the shell's own first render would
 * otherwise go out without it.
 */
installPartnerHeader();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 60_000, retry: 1 },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
