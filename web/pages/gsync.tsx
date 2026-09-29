import { useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, CloudDownload, Folder, FolderSync, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import clsx from "clsx";
import { api } from "../lib/api";
import type { SyncSource } from "../lib/types";
import { formatBytes, timeAgo } from "../lib/format";
import { Button, IconButton, Modal, useToast } from "../ui/primitives";

type SyncData = { connected: boolean; dailyLimitReached: boolean; sources: SyncSource[] };

const CONNECT_URL = `/api/auth/google?sync=1&return=${encodeURIComponent("/google-sync")}`;

export function GoogleSyncPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [stopping, setStopping] = useState<SyncSource | null>(null);
  const q = useQuery({
    queryKey: ["gsync"],
    queryFn: () => api<SyncData>("/gsync"),
    // Poll quickly while something is being copied, slowly otherwise.
    refetchInterval: (query) => (query.state.data?.sources.some((s) => s.status === "active" && (s.filesPending || s.foldersPending)) ? 10_000 : 60_000),
  });

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      qc.invalidateQueries({ queryKey: ["gsync"] });
    }
  };

  const data = q.data;
  return (
    <div className="max-w-3xl pb-16">
      <h1 className="pt-4 pb-2 text-2xl">Google Drive sync</h1>
      <p className="mb-6 text-sm text-fg-2">
        Copy folders from your Google Drive into Family Drive and keep them up to date. New and edited files are copied within a few minutes.
        Deleting something in Google Drive never deletes it here.
      </p>

      {q.isLoading && <div className="skeleton h-32 w-full rounded-2xl" />}

      {data && !data.connected && (
        <section className="mb-8 rounded-2xl bg-surface-2 p-5">
          <h2 className="mb-1 text-lg">Connect your Google Drive</h2>
          <p className="mb-4 text-sm text-fg-2">
            Family Drive needs permission to <b>see and download</b> your Google Drive files. It never changes or deletes anything in your Google Drive.
            Google may warn that the app isn't verified: choose <b>Advanced → Go to Family Drive</b> to continue.
          </p>
          <Button variant="filled" onClick={() => (location.href = CONNECT_URL)}>
            <FolderSync size={18} /> Connect Google Drive
          </Button>
        </section>
      )}

      {data?.connected && (
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-lg">Synced folders</h2>
          <Button variant="filled" onClick={() => setPicking(true)}>
            <Plus size={18} /> Add a folder
          </Button>
        </div>
      )}

      {data?.dailyLimitReached && data.sources.some((s) => s.filesPending || s.foldersPending) && (
        <p className="mb-4 rounded-2xl bg-surface-2 px-4 py-3 text-sm text-fg-2">
          Today's copying limit is reached, so big first copies pause until tomorrow (UTC) to keep the rest of Family Drive fast
          and within its free limits. New changes are still checked.
        </p>
      )}

      {data && data.sources.length > 0 && (
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {data.sources.map((s) => (
            <SourceRow
              key={s.id}
              s={s}
              connected={data.connected}
              onRun={() => run(() => api(`/gsync/sources/${s.id}/run`, { body: {} }), "Checking Google Drive for changes…")}
              onPause={() => run(() => api(`/gsync/sources/${s.id}/pause`, { body: {} }), `Paused "${s.name}"`)}
              onResume={() => run(() => api(`/gsync/sources/${s.id}/resume`, { body: {} }), `Resumed "${s.name}"`)}
              onStop={() => setStopping(s)}
            />
          ))}
        </ul>
      )}
      {data?.connected && data.sources.length === 0 && (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-fg-2">
          No folders yet. Choose <b>Add a folder</b> to start copying from Google Drive.
        </p>
      )}

      {picking && (
        <FolderPicker
          onClose={() => setPicking(false)}
          onPick={(id, name) => {
            setPicking(false);
            run(() => api("/gsync/sources", { body: { googleFolderId: id } }), `Started syncing "${name}". Files appear in My Files as they're copied.`);
          }}
        />
      )}

      {stopping && (
        <Modal open onOpenChange={() => setStopping(null)} title={`Stop syncing "${stopping.name}"?`}>
          <p className="text-sm text-fg-2">New changes in Google Drive won't be copied anymore. Files already copied stay in Family Drive.</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={() => setStopping(null)}>Cancel</Button>
            <Button
              variant="filled"
              onClick={() => {
                const s = stopping;
                setStopping(null);
                run(() => api(`/gsync/sources/${s.id}`, { method: "DELETE" }), `Stopped syncing "${s.name}"`);
              }}
            >
              Stop syncing
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SourceRow({
  s,
  connected,
  onRun,
  onPause,
  onResume,
  onStop,
}: {
  s: SyncSource;
  connected: boolean;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const discovering = s.foldersPending > 0;
  const total = s.filesDone + s.filesPending;
  const pct = total ? Math.round((s.filesDone / total) * 100) : 0;
  const busy = s.status === "active" && (discovering || s.filesPending > 0);
  const status =
    s.status === "paused"
      ? s.statusMessage ?? "Paused"
      : s.status === "error"
        ? s.statusMessage ?? "Stopped because of an error"
        : busy
          ? discovering
            ? "Finding files…"
            : `Copying… ${s.filesPending.toLocaleString()} to go`
          : s.lastSyncedAt
            ? `Up to date · checked ${timeAgo(s.lastSyncedAt)}`
            : "Starting…";

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-4">
      <Folder size={22} className="shrink-0 text-fg-2" />
      <div className="min-w-0 flex-1">
        <Link to={`/folders/${s.destFolderId}`} className="block truncate text-sm font-medium hover:underline">
          {s.name}
        </Link>
        <p className={clsx("text-xs", s.status === "active" ? "text-fg-2" : "text-warning")}>{status}</p>
        {busy && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(pct, 2)}%` }} />
          </div>
        )}
        <p className="tabular mt-1 text-xs text-fg-2">
          {s.filesDone.toLocaleString()} files copied · {formatBytes(s.bytesDone)}
          {s.filesSkipped > 0 && ` · ${s.filesSkipped.toLocaleString()} skipped`}
          {s.filesFailed > 0 && <span className="text-danger"> · {s.filesFailed.toLocaleString()} failed (Resume retries them)</span>}
        </p>
      </div>
      <div className="flex items-center">
        {s.status === "active" ? (
          <>
            <IconButton label="Sync now" onClick={onRun}>
              <RefreshCw size={18} />
            </IconButton>
            <IconButton label="Pause" onClick={onPause}>
              <Pause size={18} />
            </IconButton>
          </>
        ) : (
          <IconButton label={connected ? "Resume" : "Reconnect Google Drive first"} onClick={onResume} disabled={!connected}>
            <Play size={18} />
          </IconButton>
        )}
        {s.status === "active" && s.filesFailed > 0 && (
          <IconButton label="Retry failed files" onClick={onResume}>
            <CloudDownload size={18} />
          </IconButton>
        )}
        <IconButton label="Stop syncing" onClick={onStop}>
          <Trash2 size={18} />
        </IconButton>
      </div>
    </li>
  );
}

type Loc = { id: string; name: string };

/** Browse Google Drive folders (My Drive or Shared with me) and pick one to sync. */
function FolderPicker({ onClose, onPick }: { onClose: () => void; onPick: (id: string, name: string) => void }) {
  const [trail, setTrail] = useState<Loc[]>([{ id: "root", name: "My Drive" }]);
  const loc = trail[trail.length - 1];
  const q = useQuery({
    queryKey: ["gsync", "folders", loc.id],
    queryFn: () => api<{ folders: { id: string; name: string }[] }>(`/gsync/folders?parent=${loc.id}`),
  });
  const atSharedRoot = loc.id === "shared";

  return (
    <Modal open onOpenChange={onClose} title="Choose a Google Drive folder" width={520}>
      <div className="mb-3 flex gap-2">
        {[
          { id: "root", name: "My Drive" },
          { id: "shared", name: "Shared with me" },
        ].map((r) => (
          <button
            key={r.id}
            onClick={() => setTrail([r])}
            className={clsx("h-8 rounded-lg border px-3 text-sm", trail[0].id === r.id ? "border-transparent bg-selected" : "border-line hover:bg-hover")}
          >
            {r.name}
          </button>
        ))}
      </div>
      <div className="flex h-10 items-center gap-1 text-sm">
        {trail.length > 1 && (
          <IconButton label="Back" onClick={() => setTrail((t) => t.slice(0, -1))} className="size-8">
            <ArrowLeft size={18} />
          </IconButton>
        )}
        <span className="truncate font-medium">{loc.name}</span>
      </div>
      <ul className="h-72 overflow-auto rounded border border-line">
        {q.isLoading &&
          Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="flex h-11 items-center gap-3 px-3" aria-hidden>
              <div className="skeleton size-5" />
              <div className="skeleton h-3.5" style={{ width: `${35 + i * 9}%` }} />
            </li>
          ))}
        {q.isError && <li className="p-4 text-sm text-danger">{(q.error as Error).message}</li>}
        {q.data && q.data.folders.length === 0 && <li className="p-4 text-sm text-fg-2">No folders here</li>}
        {q.data?.folders.map((f) => (
          <li key={f.id}>
            <button className="flex h-11 w-full items-center gap-3 px-3 text-left text-sm hover:bg-hover" onClick={() => setTrail((t) => [...t, f])}>
              <Folder size={20} className="shrink-0 text-fg-2" />
              <span className="flex-1 truncate">{f.name}</span>
              <ChevronRight size={18} className="text-fg-2" />
            </button>
          </li>
        ))}
      </ul>
      {loc.id === "root" && <p className="mt-3 text-xs text-fg-2">Syncing "My Drive" itself copies your entire Google Drive.</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="filled" disabled={atSharedRoot} onClick={() => onPick(loc.id, loc.name)}>
          Sync this folder
        </Button>
      </div>
    </Modal>
  );
}
