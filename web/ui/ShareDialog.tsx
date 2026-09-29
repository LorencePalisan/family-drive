import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Link as LinkIcon, Lock, X } from "lucide-react";
import type { AccessInfo, DriveFile, Person } from "../lib/types";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { Avatar, Button, Modal, useToast } from "./primitives";
import { useMe } from "./useMe";

const selectClass = "h-9 rounded border border-line bg-surface px-2 text-sm text-fg";

export function ShareDialog({ file, onClose }: { file: DriveFile; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const access = useQuery({ queryKey: ["file", file.id, "access"], queryFn: () => api<AccessInfo>(`/files/${file.id}/access`) });
  const family = useQuery({ queryKey: ["users"], queryFn: () => api<{ users: (Person & { role: string })[] }>("/users") });
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Person[]>([]);
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["file", file.id, "access"] });
    qc.invalidateQueries({ queryKey: ["drive"] });
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const suggestions = useMemo(() => {
    const has = new Set([access.data?.owner.id, ...(access.data?.members.map((m) => m.id) ?? []), ...picked.map((p) => p.id)]);
    const q = query.trim().toLowerCase();
    return (family.data?.users ?? []).filter((u) => !has.has(u.id) && (!q || u.name.toLowerCase().includes(q) || u.email.includes(q)));
  }, [family.data, access.data, picked, query]);

  const canShare = access.data?.canShare ?? file.role !== "viewer";
  const link = access.data?.links[0];

  return (
    <Modal open onOpenChange={onClose} title={`Share "${file.name}"`} width={560}>
      {canShare && (
        <div className="mb-4">
          <div className="flex min-h-12 flex-wrap items-center gap-1 rounded border border-line px-2 py-1 focus-within:border-primary">
            {picked.map((p) => (
              <span key={p.id} className="flex items-center gap-1 rounded-full border border-line py-0.5 pr-1 pl-0.5 text-sm">
                <Avatar name={p.name} src={p.avatarUrl} size={22} />
                {p.name}
                <button aria-label={`Remove ${p.name}`} onClick={() => setPicked((x) => x.filter((y) => y.id !== p.id))} className="rounded-full p-0.5 hover:bg-hover">
                  <X size={14} />
                </button>
              </span>
            ))}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={picked.length ? "" : "Add family members"}
              className="h-9 min-w-40 flex-1 bg-transparent px-1 outline-none"
              aria-label="Add people"
            />
          </div>
          {(query || picked.length === 0) && suggestions.length > 0 && (
            <ul className="mt-1 max-h-48 overflow-auto rounded border border-line bg-surface-2 py-1">
              {suggestions.map((u) => (
                <li key={u.id}>
                  <button
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-hover"
                    onClick={() => {
                      setPicked((x) => [...x, u]);
                      setQuery("");
                    }}
                  >
                    <Avatar name={u.name} src={u.avatarUrl} size={28} />
                    <span className="min-w-0">
                      <span className="block truncate">{u.name}</span>
                      <span className="block truncate text-xs text-fg-2">{u.email}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query && !suggestions.length && (
            <p className="mt-2 text-sm text-fg-2">
              No family member matches "{query}".{me?.role === "owner" && " Invite them from Manage family first."}
            </p>
          )}
          {picked.length > 0 && (
            <div className="mt-3 space-y-3">
              <div className="flex items-center gap-4">
                <select className={selectClass} value={role} onChange={(e) => setRole(e.target.value as "viewer" | "editor")} aria-label="Role">
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify people by email
                </label>
              </div>
              {notify && (
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Message" className="w-full rounded border border-line bg-transparent p-3 text-sm outline-none focus:border-primary" />
              )}
              <div className="flex justify-end gap-2">
                <Button onClick={() => setPicked([])}>Cancel</Button>
                <Button
                  variant="filled"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api(`/files/${file.id}/shares`, { body: { emails: picked.map((p) => p.email), role, notify, message: message || undefined } });
                      toast(`Shared with ${picked.map((p) => p.name).join(", ")}`);
                      setPicked([]);
                      setMessage("");
                    })
                  }
                >
                  Send
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {picked.length === 0 && (
        <>
          <h3 className="mb-2 font-medium">People with access</h3>
          <ul className="mb-5 max-h-64 overflow-auto">
            {access.data && (
              <li className="flex items-center gap-3 py-2">
                <Avatar name={access.data.owner.name} src={access.data.owner.avatarUrl} size={36} />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate">
                    {access.data.owner.name}
                    {access.data.owner.id === me?.id && " (you)"}
                  </span>
                  <span className="block truncate text-fg-2">{access.data.owner.email}</span>
                </span>
                <span className="text-sm text-fg-2">Owner</span>
              </li>
            )}
            {access.data?.members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2">
                <Avatar name={m.name} src={m.avatarUrl} size={36} />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate">
                    {m.name}
                    {m.id === me?.id && " (you)"}
                  </span>
                  <span className="block truncate text-fg-2">{m.inheritedFrom ? `Access from folder "${m.inheritedFrom}"` : m.email}</span>
                </span>
                {canShare && !m.inheritedFrom ? (
                  <select
                    className={selectClass}
                    value={m.role}
                    aria-label={`Access for ${m.name}`}
                    onChange={(e) =>
                      run(() =>
                        e.target.value === "remove"
                          ? api(`/files/${file.id}/shares/${m.id}`, { method: "DELETE" })
                          : api(`/files/${file.id}/shares/${m.id}`, { method: "PATCH", body: { role: e.target.value } }),
                      )
                    }
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="remove">Remove access</option>
                  </select>
                ) : (
                  <span className="text-sm text-fg-2 capitalize">{m.role}</span>
                )}
              </li>
            ))}
          </ul>

          <h3 className="mb-2 font-medium">General access</h3>
          <div className="flex items-center gap-3">
            <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${link ? "bg-primary-soft text-primary" : "bg-surface-3"}`}>
              {link ? <Globe size={18} /> : <Lock size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              {canShare ? (
                <select
                  className="-ml-1 rounded bg-transparent py-1 text-sm font-medium hover:bg-hover"
                  value={link ? "link" : "restricted"}
                  aria-label="General access"
                  onChange={(e) =>
                    run(() =>
                      e.target.value === "link"
                        ? api(`/files/${file.id}/links`, { method: "POST", body: {} })
                        : api(`/files/${file.id}/links`, { method: "DELETE" }),
                    )
                  }
                >
                  <option value="restricted">Restricted</option>
                  <option value="link">Anyone with the link</option>
                </select>
              ) : (
                <span className="text-sm font-medium">{link ? "Anyone with the link" : "Restricted"}</span>
              )}
              <p className="text-xs text-fg-2">
                {link
                  ? `Anyone on the internet with the link can view${link.expiresAt ? ` until ${formatDate(link.expiresAt)}` : ""}`
                  : "Only family members with access can open with the link"}
              </p>
            </div>
            {link && canShare && (
              <select
                className={selectClass}
                aria-label="Link expiry"
                value={link.expiresAt ? "custom" : "never"}
                onChange={(e) => run(() => api(`/files/${file.id}/links`, { method: "POST", body: { expiresInDays: e.target.value === "never" ? null : Number(e.target.value) } }))}
              >
                <option value="never">No expiry</option>
                {link.expiresAt && <option value="custom">Expires {formatDate(link.expiresAt)}</option>}
                <option value="1">Expire in 1 day</option>
                <option value="7">Expire in 7 days</option>
                <option value="30">Expire in 30 days</option>
              </select>
            )}
          </div>

          <div className="mt-6 flex items-center justify-between">
            <Button
              variant="outlined"
              className="px-4"
              onClick={async () => {
                const url = link?.url ?? `${location.origin}/${file.isFolder ? "folders" : "file"}/${file.id}`;
                await navigator.clipboard.writeText(url);
                toast("Link copied");
              }}
            >
              <LinkIcon size={18} /> Copy link
            </Button>
            <Button variant="filled" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
