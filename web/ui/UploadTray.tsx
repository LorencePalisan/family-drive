import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, RotateCcw, X, AlertCircle } from "lucide-react";
import { cancelUpload, clearFinished, retryUpload, useUploads } from "../lib/upload";
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

export function UploadTray() {
  const uploads = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  if (!uploads.length) return null;
  const active = uploads.filter((u) => u.status === "queued" || u.status === "uploading");
  const done = uploads.filter((u) => u.status === "done").length;
  const failed = uploads.filter((u) => u.status === "error").length;
  const title = active.length
    ? `Uploading ${active.length} item${active.length === 1 ? "" : "s"}`
    : `${done} upload${done === 1 ? "" : "s"} complete${failed ? `, ${failed} failed` : ""}`;
  const totalLeft = active.reduce((s, u) => s + (u.size - u.loaded), 0);

  return (
    <div className="animate-rise fixed right-4 bottom-0 z-(--z-tray) w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-t-2xl bg-surface shadow-3">
      <div className="flex h-14 items-center gap-1 bg-surface-2 pr-2 pl-5">
        <span className="flex-1 font-medium">{title}</span>
        <IconButton label={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </IconButton>
        <IconButton label="Close" onClick={() => (active.length ? active.forEach((u) => cancelUpload(u.id)) : clearFinished())}>
          <X size={20} />
        </IconButton>
      </div>
      {!collapsed && (
        <>
          {active.length > 0 && <div className="bg-surface-2/50 px-5 py-2 text-xs text-fg-2">{formatBytes(totalLeft)} left</div>}
          <ul className="scrollbar-thin max-h-72 overflow-auto">
            {uploads.map((u) => (
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
          </ul>
        </>
      )}
    </div>
  );
}
