import { db, ensureSchema, isDbConfigured } from "../db.js";
import { env } from "../env.js";
import { downloadFile, isSharePointConfigured, listExports, type DriveFile } from "./sharepoint.js";
import { ingestExport } from "./ingest.js";

/**
 * Pulls new export files out of the watched SharePoint folder and imports them.
 *
 * Each SharePoint item is remembered by id + eTag, so a file already seen is
 * not downloaded again — an 11 MB PDF every poll would be wasteful. Content
 * hashing in `ingestExport` is still the real guard against double-importing;
 * this table only avoids the download.
 *
 * A file that fails to import is recorded with its error and NOT retried on
 * every poll, so one malformed export cannot wedge the loop.
 */

export type SyncResult = {
  checked: number;
  imported: { name: string; inserted: number; updated: number; receipts: number; reconciled: boolean }[];
  skipped: number;
  failed: { name: string; error: string }[];
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS import_sources (
  item_id      text PRIMARY KEY,
  etag         text        NOT NULL,
  filename     text        NOT NULL,
  seen_at      timestamptz NOT NULL DEFAULT now(),
  imported_at  timestamptz,
  import_id    bigint,
  status       text        NOT NULL,
  error        text
);
`;

let schemaReady: Promise<void> | null = null;
const ensure = (): Promise<void> => (schemaReady ??= ensureSchema().then(async () => {
  await db().query(SCHEMA);
}));

/** Only these are worth downloading. */
const SUPPORTED = /\.pdf$/i;

export async function syncFromSharePoint(triggeredBy: string): Promise<SyncResult> {
  if (!isDbConfigured()) throw new Error("DATABASE_URL is not set.");
  if (!isSharePointConfigured()) {
    throw new Error(
      "SharePoint sync is not configured. Needs AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, " +
        "SHAREPOINT_DRIVE_ID and SHAREPOINT_FOLDER_ID.",
    );
  }
  await ensure();

  const files = await listExports();
  const result: SyncResult = { checked: files.length, imported: [], skipped: 0, failed: [] };

  for (const file of files) {
    if (!SUPPORTED.test(file.name)) {
      result.skipped++;
      continue;
    }
    if (await alreadyHandled(file)) {
      result.skipped++;
      continue;
    }

    try {
      const bytes = await downloadFile(file);
      const imported = await ingestExport(bytes, file.name, triggeredBy);
      await record(file, imported.duplicateFile ? "duplicate" : "imported", imported.importId, null);
      if (!imported.duplicateFile) {
        result.imported.push({
          name: file.name,
          inserted: imported.inserted,
          updated: imported.updated,
          receipts: imported.receiptsAdded,
          reconciled: imported.reconciled,
        });
      } else {
        result.skipped++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Remember the failure so a bad file is not retried every hour.
      await record(file, "failed", null, message);
      result.failed.push({ name: file.name, error: message });
    }
  }

  return result;
}

async function alreadyHandled(file: DriveFile): Promise<boolean> {
  const { rows } = await db().query<{ etag: string }>(
    "SELECT etag FROM import_sources WHERE item_id = $1", [file.id]);
  // A changed eTag means the file was replaced in place; treat it as new.
  return rows.length > 0 && rows[0]!.etag === file.eTag;
}

async function record(file: DriveFile, status: string, importId: number | null, error: string | null) {
  await db().query(
    `INSERT INTO import_sources (item_id, etag, filename, imported_at, import_id, status, error)
     VALUES ($1,$2,$3,now(),$4,$5,$6)
     ON CONFLICT (item_id) DO UPDATE SET
       etag = EXCLUDED.etag, filename = EXCLUDED.filename, imported_at = now(),
       import_id = EXCLUDED.import_id, status = EXCLUDED.status, error = EXCLUDED.error`,
    [file.id, file.eTag, file.name, importId, status, error],
  );
}

let timer: NodeJS.Timeout | null = null;

/** Start the background poll, if both a database and SharePoint are configured. */
export function startSyncTimer(): void {
  const minutes = env.sharepoint.pollMinutes;
  if (timer || minutes <= 0) return;
  if (!isDbConfigured() || !isSharePointConfigured()) return;

  const run = () => {
    syncFromSharePoint("scheduled")
      .then((r) => {
        if (r.imported.length > 0 || r.failed.length > 0) {
          console.log(`sharepoint sync: imported ${r.imported.length}, failed ${r.failed.length}`);
        }
      })
      .catch((err: unknown) => console.error("sharepoint sync failed:", err));
  };

  // First pass shortly after boot, so a restart picks up anything waiting.
  setTimeout(run, 30_000);
  timer = setInterval(run, minutes * 60_000);
  console.log(`SharePoint sync every ${minutes} min`);
}
