import { useQuery } from "@tanstack/react-query";
import { X, Download } from "lucide-react";
import type { AccessInfo, FileDetails } from "../lib/types";
import { api, downloadUrl, driveSource } from "../lib/api";
import { KIND_LABEL, fileKind, formatBytes, formatDateTime, formatDuration } from "../lib/format";
import { Avatar, Button, FileIcon, IconButton } from "./primitives";
import { useDriveUI } from "./DriveUI";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <dt className="text-xs text-fg-2">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  upload: "Uploaded",
  copy: "Copied",
  google_saveback: "Saved from Google",
  google_sync: "Synced from Google Drive",
};

export function DetailsPanel({ id }: { id: string }) {
  const ui = useDriveUI();
  const details = useQuery({ queryKey: ["file", id], queryFn: () => api<FileDetails>(`/files/${id}`) });
  const access = useQuery({ queryKey: ["file", id, "access"], queryFn: () => api<AccessInfo>(`/files/${id}/access`), enabled: !details.data?.trashedAt });
  const f = details.data;

  return (
    <aside className="flex w-full flex-col overflow-hidden rounded-2xl bg-surface max-lg:fixed max-lg:inset-y-2 max-lg:right-2 max-lg:z-(--z-panel) max-lg:w-[min(360px,calc(100vw-16px))] max-lg:shadow-3 animate-rise lg:w-[340px] lg:shrink-0">
      <div className="flex items-center gap-3 p-4 pr-2">
        {f && <FileIcon file={f} />}
        <h2 className="min-w-0 flex-1 truncate text-lg">{f?.name ?? "Details"}</h2>
        <IconButton label="Close details" onClick={() => ui.setDetailsId(null)}>
          <X size={20} />
        </IconButton>
      </div>
      {details.isError && <p className="p-4 text-sm text-fg-2">{(details.error as Error).message}</p>}
      {f && (
        <div className="scrollbar-thin flex-1 overflow-auto px-4 pb-6">
          <div className="mb-5 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl bg-surface-2">
            {f.hasThumbnail ? <img src={driveSource.thumbnail(f)} alt="" className="h-full w-full object-contain" /> : <FileIcon file={f} size={72} />}
          </div>

          {access.data && (
            <section className="mb-6">
              <h3 className="mb-2 font-medium">Who has access</h3>
              <div className="mb-2 flex -space-x-1">
                {[access.data.owner, ...access.data.members].slice(0, 8).map((p) => (
                  <span key={p.id} className="rounded-full ring-2 ring-surface" title={p.name}>
                    <Avatar name={p.name} src={p.avatarUrl} size={32} />
                  </span>
                ))}
              </div>
              <p className="mb-2 text-sm text-fg-2">
                {access.data.members.length ? `Owned by ${f.owner.isMe ? "you" : f.owner.name}. Shared with ${access.data.members.length} ${access.data.members.length === 1 ? "person" : "people"}.` : f.owner.isMe ? "Private to you" : `Owned by ${f.owner.name}`}
                {access.data.links.length > 0 && " Anyone with the link can view."}
              </p>
              <Button variant="outlined" className="h-9 px-4" onClick={() => ui.share(f)}>
                Manage access
              </Button>
            </section>
          )}

          <h3 className="mb-3 font-medium">File details</h3>
          <dl>
            <Row label="Type">{f.isFolder ? "Folder" : `${KIND_LABEL[fileKind(f)]}${f.mime ? ` (${f.mime})` : ""}`}</Row>
            {!f.isFolder && <Row label="Size">{`${formatBytes(f.size)} (${f.size.toLocaleString()} bytes)`}</Row>}
            {f.width && f.height && <Row label="Dimensions">{`${f.width} × ${f.height}`}</Row>}
            {f.duration && <Row label="Duration">{formatDuration(f.duration)}</Row>}
            <Row label="Location">{f.trashedAt ? "Trash" : f.location.name}</Row>
            <Row label="Owner">{f.owner.isMe ? "me" : `${f.owner.name} (${f.owner.email})`}</Row>
            <Row label="Modified">{`${formatDateTime(f.updatedAt)}${f.updatedByName ? ` by ${f.updatedByName}` : ""}`}</Row>
            {f.recent?.action === "opened" && <Row label="Opened by me">{formatDateTime(f.recent.at)}</Row>}
            <Row label="Created">{formatDateTime(f.createdAt)}</Row>
          </dl>

          {f.versions.length > 1 && (
            <section className="mt-2">
              <h3 className="mb-2 font-medium">Versions</h3>
              <ul className="space-y-1">
                {f.versions.map((v, i) => (
                  <li key={v.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {formatDateTime(v.createdAt)}
                        {i === 0 && " (current)"}
                      </span>
                      <span className="block truncate text-xs text-fg-2">
                        {SOURCE_LABEL[v.source] ?? v.source} by {v.createdBy} · {formatBytes(v.size)}
                      </span>
                    </span>
                    <IconButton label="Download this version" className="size-8" onClick={() => downloadUrl(`/api/files/${f.id}/content?download=1&v=${v.id}`)}>
                      <Download size={16} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}
