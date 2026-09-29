import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams, Navigate } from "react-router";
import { ArrowLeft, Download, Mail, RotateCcw, X } from "lucide-react";
import type { DriveFile, FileDetails } from "../lib/types";
import { api, downloadUrl, publicSource } from "../lib/api";
import { formatBytes, formatDate } from "../lib/format";
import { Avatar, Button, FileIcon, IconButton, inputClass, useToast } from "../ui/primitives";
import { useDriveUI, useFileActions } from "../ui/DriveUI";
import { useMe } from "../ui/useMe";
import { LegalLinks } from "./legal";

// ---- /file/:id — deep link from emails and notifications ---------------------------------------

export function FileLinkPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const act = useFileActions();
  const q = useQuery({ queryKey: ["file", id], queryFn: () => api<FileDetails>(`/files/${id}`) });
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!q.data || handled.current === q.data.id) return;
    handled.current = q.data.id;
    const f = q.data;
    navigate(f.location.id ? `/folders/${f.location.id}` : f.owner.isMe ? "/drive" : "/shared", { replace: true });
    act.open(f);
  }, [q.data, navigate, act]);
  if (q.isError) return <p className="p-8 text-fg-2">{(q.error as Error).message}</p>;
  return <p className="p-8 text-fg-2">Opening…</p>;
}

// ---- Manage family (owner only) ----------------------------------------------------------------

type FamilyData = {
  invites: { id: string; email: string; expiresAt: number; createdAt: number }[];
  members: { id: string; email: string; name: string; avatarUrl: string | null; role: string; storageUsed: number; createdAt: number }[];
};

export function FamilyPage() {
  const me = useMe().data;
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["family"], queryFn: () => api<FamilyData>("/invites"), enabled: me?.role === "owner" });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  if (me && me.role !== "owner") return <Navigate to="/" replace />;

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ["family"] });
      qc.invalidateQueries({ queryKey: ["users"] });
    }
  };

  return (
    <div className="max-w-3xl pb-16">
      <h1 className="pt-4 pb-6 text-2xl">Manage family</h1>

      <section className="mb-8 rounded-2xl bg-surface-2 p-5">
        <h2 className="mb-1 text-lg">Invite someone</h2>
        <p className="mb-4 text-sm text-fg-2">They'll get an email with a link and sign in with that Google account.</p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const res = await api<{ emailed: boolean }>("/invites", { body: { email } });
              setEmail("");
              if (!res.emailed) toast("Invite saved, but the email couldn't be sent. Check the email setup.");
            }, `Invite sent to ${email}`);
          }}
        >
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" className={`${inputClass} min-w-60 flex-1 bg-surface`} aria-label="Email address" />
          <Button variant="filled" type="submit" disabled={busy || !email} className="h-12">
            <Mail size={18} /> Send invite
          </Button>
        </form>
      </section>

      {!!q.data?.invites.length && (
        <section className="mb-8">
          <h2 className="mb-2 text-lg">Pending invites</h2>
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {q.data.invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar name={i.email} size={36} />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate">{i.email}</span>
                  <span className="block text-fg-2">{i.expiresAt > Date.now() ? `Expires ${formatDate(i.expiresAt)}` : "Expired"}</span>
                </span>
                <IconButton label="Resend invite" onClick={() => run(() => api(`/invites/${i.id}/resend`, { method: "POST" }), `Invite resent to ${i.email}`)}>
                  <RotateCcw size={18} />
                </IconButton>
                <IconButton label="Cancel invite" onClick={() => run(() => api(`/invites/${i.id}`, { method: "DELETE" }), "Invite cancelled")}>
                  <X size={18} />
                </IconButton>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg">Family members</h2>
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {q.data?.members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={m.name} src={m.avatarUrl} size={36} />
              <span className="min-w-0 flex-1 text-sm">
                <span className="block truncate">
                  {m.name} {m.role === "owner" && <span className="text-fg-2">(owner)</span>}
                </span>
                <span className="block truncate text-fg-2">{m.email}</span>
              </span>
              <span className="text-sm text-fg-2">{formatBytes(m.storageUsed)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---- Login -------------------------------------------------------------------------------------

const LOGIN_ERRORS: Record<string, string> = {
  not_invited: "This Google account hasn't been invited yet. Ask the family drive owner for an invite.",
  invite_invalid: "This invite link has expired or was cancelled. Ask for a new one.",
  unverified: "That Google account's email isn't verified.",
  state: "Sign-in timed out. Please try again.",
  access_denied: "Sign-in was cancelled.",
};

export function LoginPage() {
  const [params] = useSearchParams();
  const error = params.get("error");
  const ret = params.get("return") ?? "/";
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-bg p-4">
      {/* Soft ambient light in the brand colours so the page isn't a flat void. */}
      <div aria-hidden className="pointer-events-none absolute -top-40 -left-32 size-[520px] rounded-full bg-[#0f766e] opacity-[0.14] blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -right-40 -bottom-48 size-[560px] rounded-full bg-[#e0a458] opacity-[0.10] blur-3xl" />
      <div className="animate-rise relative w-full max-w-md rounded-[28px] bg-surface p-10 text-center shadow-3">
        <img src="/favicon.svg" alt="Family Drive logo" className="mx-auto mb-4 size-14" />
        <h1 className="mb-2 text-[32px] leading-tight font-normal">Family Drive</h1>
        <p className="mb-8 text-fg-2">Our photos, videos and documents in one place.</p>
        {error && (
          <p role="alert" className="mb-6 rounded-lg bg-[#fce8e6] px-4 py-3 text-left text-sm text-[#8c1d18]">
            {LOGIN_ERRORS[error] ?? "Couldn't sign you in. Please try again."}
            {params.get("email") && <span className="mt-1 block text-xs">Signed in as {params.get("email")}</span>}
          </p>
        )}
        <a
          href={`/api/auth/google?return=${encodeURIComponent(ret)}`}
          className="inline-flex h-11 items-center gap-3 rounded-full border border-line bg-surface px-6 text-sm font-medium hover:bg-hover hover:shadow-1 active:bg-pressed"
        >
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          Sign in with Google
        </a>
        <p className="mt-8 text-xs text-fg-3">Invite only. Family members get an email invite from the owner.</p>
        <p className="mt-3 text-xs text-fg-3">
          By signing in you agree to the <a href="/terms" className="underline hover:text-fg-2">Terms of Service</a> and{" "}
          <a href="/privacy" className="underline hover:text-fg-2">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}

// ---- /s/:token — public "anyone with the link" page ----------------------------------------------

type PublicItem = { id: string; name: string; isFolder: boolean; mime: string | null; size: number; hasThumbnail: boolean; width: number | null; height: number | null; updatedAt: number };

const asDriveFile = (p: PublicItem): DriveFile => ({
  ...p,
  parentId: null,
  location: { id: null, name: "" },
  owner: { id: "", name: "", email: "", avatarUrl: null, isMe: false },
  role: "viewer",
  starred: false,
  shared: true,
  duration: null,
  createdAt: p.updatedAt,
  trashedAt: null,
  recent: null,
});

export function PublicSharePage() {
  const { token = "" } = useParams();
  const ui = useDriveUI();
  const source = publicSource(token);
  const [trail, setTrail] = useState<{ id?: string; name: string }[]>([]);
  const folderId = trail[trail.length - 1]?.id;
  const q = useQuery({
    queryKey: ["public", token, folderId],
    queryFn: () => api<{ rootId: string; sharedBy: string; file: PublicItem; items: PublicItem[] }>(`/public/${token}${folderId ? `?folderId=${folderId}` : ""}`),
  });
  const data = q.data;

  useEffect(() => {
    if (data && !data.file.isFolder && !trail.length) ui.openPreview({ file: asDriveFile(data.file), list: [asDriveFile(data.file)], source, publicToken: token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.file.id]);

  if (q.isError) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <img src="/favicon.svg" alt="" className="size-12" />
        <h1 className="text-2xl">{(q.error as Error).message}</h1>
        <p className="text-fg-2">Ask the person who shared it for a new link.</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="min-h-full bg-bg p-4" aria-busy="true" aria-label="Loading">
        <div className="skeleton mb-4 h-8 w-64" />
        <div className="skeleton h-[60dvh] w-full rounded-2xl" />
      </div>
    );
  }
  const files = data.items.filter((i) => !i.isFolder).map(asDriveFile);

  return (
    <div className="min-h-full bg-bg">
      <header className="flex h-16 items-center gap-3 px-4">
        <img src="/favicon.svg" alt="" className="size-9" />
        {trail.length > 0 && (
          <IconButton label="Back" onClick={() => setTrail((t) => t.slice(0, -1))}>
            <ArrowLeft size={20} />
          </IconButton>
        )}
        <FileIcon file={data.file} />
        <h1 className="min-w-0 flex-1 truncate text-lg">{data.file.name}</h1>
        <span className="text-sm text-fg-2 max-sm:hidden">Shared by {data.sharedBy}</span>
        <Button
          variant="filled"
          onClick={() => downloadUrl(data.file.isFolder ? `/api/public/${token}/zip?fileId=${data.file.id}` : source.content(data.file, true))}
        >
          <Download size={18} /> {data.file.isFolder ? "Download all" : "Download"}
        </Button>
      </header>
      <main className="mx-2 min-h-[calc(100vh-72px)] rounded-2xl bg-surface p-4 sm:mx-4">
        {data.file.isFolder ? (
          data.items.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
              {data.items.map((item) => (
                <button
                  key={item.id}
                  className="flex flex-col overflow-hidden rounded-xl bg-surface-2 text-left hover:bg-surface-3"
                  onClick={() =>
                    item.isFolder
                      ? setTrail((t) => [...t, { id: item.id, name: item.name }])
                      : ui.openPreview({ file: asDriveFile(item), list: files, source, publicToken: token })
                  }
                >
                  <div className="flex h-11 items-center gap-2 px-3">
                    <FileIcon file={item} />
                    <span className="truncate text-sm font-medium">{item.name}</span>
                  </div>
                  {!item.isFolder && (
                    <div className="mx-2 mb-2 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-surface">
                      {item.hasThumbnail ? <img src={source.thumbnail(item)} alt="" loading="lazy" className="h-full w-full object-cover" /> : <FileIcon file={item} size={48} />}
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="p-8 text-center text-fg-2">This folder is empty</p>
          )
        ) : (
          <div className="flex flex-col items-center gap-4 p-12 text-center">
            <FileIcon file={data.file} size={64} />
            <p>{data.file.name}</p>
            <p className="text-sm text-fg-2">{formatBytes(data.file.size)}</p>
            <Button variant="tonal" onClick={() => ui.openPreview({ file: asDriveFile(data.file), list: [asDriveFile(data.file)], source, publicToken: token })}>
              Preview
            </Button>
          </div>
        )}
      </main>
      <LegalLinks className="py-4 text-center text-xs text-fg-3" />
    </div>
  );
}
