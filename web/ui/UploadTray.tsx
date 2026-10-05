import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, RotateCcw, X, AlertCircle } from "lucide-react";
import { cancelAll, cancelUpload, clearFinished, retryAllFailed, retryUpload, useUploads, type UploadItem } from "../lib/upload";
import { formatBytes } from "../lib/format";
import { FileIcon, IconButton } from "./primitives";

function Ring({ value }: { value: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90" aria-label={`${Math.round(value * 100)}%`}>
      <circle cx="12" cy="12" r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
      <circle cx="12" cy="12" r={r} fill="none" stroke="var(--primary)" strokeWidth="3" strokeDasharray={c} strokeDashoffset={c * (1 - value)} />
    </svg>
  );
}

// Rows drawn at most; a 1,000-file upload is summarised by the header and progress bar instead.
const MAX_ROWS = 50;
const ORDER: Record<UploadItem["status"], number> = { error: 0, uploading: 1, queued: 2, cancelled: 3, done: 4 };

export function UploadTray() {
  const uploads = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  if (!uploads.length) return null;
  const active = uploads.filter((u) => u.status === "queued" || u.status === "uploading");
  const done = uploads.filter((u) => u.status === "done").length;
  const failed = uploads.filter((u) => u.status === "error").length;
  const batch = uploads.filter((u) => u.status !== "cancelled");
  const title = active.length
    ? batch.length > 1
      ? `Uploading ${done.toLocaleString()} of ${batch.length.toLocaleString()}`
      : "Uploading 1 item"
    : `${done.toLocaleString()} upload${done === 1 ? "" : "s"} complete${failed ? `, ${failed.toLocaleString()} failed` : ""}`;
  const totalLeft = active.reduce((s, u) => s + (u.size - u.loaded), 0);
  const totalBytes = batch.reduce((s, u) => s + u.size, 0);
  const loadedBytes = batch.reduce((s, u) => s + (u.status === "done" ? u.size : u.loaded), 0);
  const rows = uploads.length > MAX_ROWS ? [...uploads].sort((a, b) => ORDER[a.status] - ORDER[b.status]).slice(0, MAX_ROWS) : uploads;
  const hidden = uploads.length - rows.length;

  return (
    <div className="animate-rise fixed right-4 bottom-0 z-(--z-tray) w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-t-2xl bg-surface shadow-3">
      <div className="flex h-14 items-center gap-1 bg-surface-2 pr-2 pl-5">
        <span className="flex-1 font-medium">{title}</span>
        <IconButton label={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </IconButton>
        <IconButton label={active.length ? "Cancel uploads" : "Close"} onClick={() => (active.length ? setConfirmCancel(true) : clearFinished())}>
          <X size={20} />
        </IconButton>
      </div>
      {active.length > 0 && batch.length > 1 && (
        <div className="h-1 bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((loadedBytes / (totalBytes || 1)) * 100)}>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${(loadedBytes / (totalBytes || 1)) * 100}%` }} />
        </div>
      )}
      {confirmCancel && active.length > 0 && (
        <div className="flex items-center gap-2 bg-surface-2/50 px-5 py-2 text-sm">
          <span className="flex-1">Cancel {active.length.toLocaleString()} remaining upload{active.length === 1 ? "" : "s"}?</span>
          <button className="rounded-full px-3 py-1 font-medium hover:bg-hover" onClick={() => setConfirmCancel(false)}>
            Keep going
          </button>
          <button className="rounded-full px-3 py-1 font-medium text-danger hover:bg-hover" onClick={() => (cancelAll(), setConfirmCancel(false))}>
            Cancel all
          </button>
        </div>
      )}
      {!collapsed && (
        <>
          {(active.length > 0 || failed > 0) && (
            <div className="flex min-h-9 items-center gap-2 bg-surface-2/50 px-5 py-1 text-xs text-fg-2">
              <span className="flex-1">{active.length > 0 && `${formatBytes(totalLeft)} left`}</span>
              {failed > 0 && (
                <button className="flex items-center gap-1 rounded-full px-2 py-1 font-medium text-primary hover:bg-hover" onClick={retryAllFailed}>
                  <RotateCcw size={14} /> Retry {failed > 1 ? `all ${failed.toLocaleString()}` : ""} failed
                </button>
              )}
            </div>
          )}
          <ul className="scrollbar-thin max-h-72 overflow-auto">
            {rows.map((u) => (
              <li key={u.id} className="group flex h-12 items-center gap-3 px-5 hover:bg-hover">
                <FileIcon file={{ name: u.name, mime: null, isFolder: false }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{u.name}</span>
                  {u.status === "error" && <span className="block truncate text-xs text-danger">{u.error}</span>}
                </span>
                {u.status === "done" && <CheckCircle2 size={22} className="text-primary" aria-label="Done" />}
                {u.status === "cancelled" && <span className="text-xs text-fg-2">Cancelled</span>}
                {u.status === "error" && (
                  <>
                    <AlertCircle size={20} className="text-danger" />
                    <IconButton label="Retry" className="size-8" onClick={() => retryUpload(u.id)}>
                      <RotateCcw size={16} />
                    </IconButton>
                  </>
                )}
                {(u.status === "uploading" || u.status === "queued") && (
                  <>
                    <span className="group-hover:hidden">
                      <Ring value={u.size ? u.loaded / u.size : 0} />
                    </span>
                    <IconButton label="Cancel upload" className="hidden size-8 group-hover:inline-flex" onClick={() => cancelUpload(u.id)}>
                      <X size={16} />
                    </IconButton>
                  </>
                )}
              </li>
            ))}
            {hidden > 0 && <li className="px-5 py-3 text-xs text-fg-2">and {hidden.toLocaleString()} more</li>}
          </ul>
        </>
      )}
    </div>
  );
}
