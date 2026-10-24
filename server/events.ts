import type { Request, Response } from "express";

/**
 * Live updates, pushed to open pages.
 *
 * The signup tracker is the reason this exists. A notification is sent
 * AFTER the response — deliberately, because a bounced email must never
 * fail a signup — so the step that records it lands a second or two
 * after the page has already fetched. Without a push, the page shows a
 * grey step that is no longer true until somebody reloads for a reason
 * they cannot see. Polling hides that; it does not fix it, and it asks
 * every open tab to keep talking whether or not anything is happening.
 *
 * Server-sent events rather than websockets: this is one-way, it is a
 * plain GET that any proxy understands, the browser reconnects on its
 * own, and it needs no dependency.
 *
 * The bus is IN-PROCESS, which is right for a single Reserved VM and
 * would not survive being scaled to several. If this ever runs on more
 * than one instance, swap `emitChange` for Postgres LISTEN/NOTIFY and
 * leave everything else alone — the shape is the same.
 */

/** What changed. Clients map these onto the queries they need to redo. */
export type Topic = "signups" | "rfid" | "users" | "roles" | "settings";

type Client = { id: number; res: Response; email: string };

const clients = new Set<Client>();
let nextId = 1;

/** Tell every open page that something of this kind changed. */
export function emitChange(topic: Topic): void {
  const line = `event: change\ndata: ${JSON.stringify({ topic, at: Date.now() })}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(line);
    } catch {
      // A dead connection is not an error worth surfacing; the browser
      // will reconnect and `close` will tidy the entry.
      clients.delete(c);
    }
  }
}

/** For the boot log and a health check: how many pages are listening. */
export const liveClientCount = (): number => clients.size;

/**
 * Hold the connection open and write changes to it.
 *
 * The heartbeat is not optional. Proxies — Replit's included — close a
 * connection that has been silent for a minute or so, and a stream that
 * dies every minute reconnects every minute, which is polling again
 * with extra steps.
 */
export function streamChanges(req: Request, res: Response): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Nginx and friends buffer by default, which holds every message
    // until the response ends — and this response never ends.
    "x-accel-buffering": "no",
  });
  // Tell the browser to wait this long before reconnecting, rather than
  // whatever its default is.
  res.write("retry: 3000\n\n");

  const client: Client = { id: nextId++, res, email: req.user?.email ?? "" };
  clients.add(client);

  const beat = setInterval(() => {
    // A comment line: valid SSE, ignored by the client, keeps the pipe warm.
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* closed */ }
  }, 25_000);

  const close = () => {
    clearInterval(beat);
    clients.delete(client);
  };
  req.on("close", close);
  req.on("error", close);
  res.on("error", close);
}
