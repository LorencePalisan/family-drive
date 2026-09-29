import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams, useNavigate } from "react-router";
import clsx from "clsx";
import { ChevronDown, ChevronRight, Clock, Compass, FolderOpen, HardDrive, Info, MoreVertical, Search, Star, Trash2, Users } from "lucide-react";
import type { DriveFile } from "../lib/types";
import { api } from "../lib/api";
import { FileBrowser, ViewToggle } from "../ui/FileBrowser";
import { FileContextMenu, FileDropdown } from "../ui/FileMenu";
import { Button, FileIcon, IconButton } from "../ui/primitives";
import { useDriveUI, useFileActions } from "../ui/DriveUI";

function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="sticky top-0 z-(--z-header) -mx-4 flex min-h-16 flex-wrap items-center gap-2 bg-surface px-4 pt-2 sm:-mx-5 sm:px-5">
      <h1 className="min-w-0 flex-1 text-2xl">{title}</h1>
      {actions}
      <ViewToggle />
    </div>
  );
}

function Empty({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children?: ReactNode }) {
  return (
    <div className="animate-rise flex flex-col items-center px-4 pt-20 pb-24 text-center">
      <div className="mb-6 flex size-32 items-center justify-center rounded-full bg-surface-2 text-fg-3">{icon}</div>
      <h2 className="mb-2 text-xl">{title}</h2>
      <p className="max-w-md text-sm text-fg-2">{body}</p>
      {children}
    </div>
  );
}

const listQuery = (path: string) => ({ queryKey: ["drive", path], queryFn: () => api<{ items: DriveFile[] }>(path) });

export function HomePage() {
  const act = useFileActions();
  const q = useQuery({ queryKey: ["drive", "home"], queryFn: () => api<{ folders: DriveFile[]; files: DriveFile[] }>("/drive/home") });
  const [showFolders, setShowFolders] = useState(true);
  const [showFiles, setShowFiles] = useState(true);
  const folders = q.data?.folders ?? [];
  const toggle = (open: boolean, set: (v: boolean) => void, label: string) => (
    <button onClick={() => set(!open)} className="-ml-2 flex h-10 items-center gap-2 rounded-full px-2 text-base font-medium hover:bg-hover" aria-expanded={open}>
      {open ? <ChevronDown size={20} /> : <ChevronRight size={20} />} {label}
    </button>
  );
  return (
    <>
      <div className="sticky top-0 z-(--z-header) -mx-4 flex h-16 items-center bg-surface px-4 pt-2 sm:-mx-5 sm:px-5">
        <h1 className="flex-1 text-2xl">Welcome to Family Drive</h1>
      </div>
      {!q.isLoading && !folders.length && !q.data?.files.length ? (
        <Empty icon={<HardDrive size={56} />} title="Welcome to your family drive" body="Use the New button or drag photos, videos and documents here to upload them. Everything keeps its original quality." />
      ) : (
        <>
          {folders.length > 0 && (
            <section className="mb-4">
              {toggle(showFolders, setShowFolders, "Recent folders")}
              {showFolders && (
                <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                  {folders.map((f) => (
                    <FileContextMenu key={f.id} files={[f]} list={folders} context="drive">
                      <div
                        role="link"
                        tabIndex={0}
                        onClick={() => act.open(f)}
                        onKeyDown={(e) => e.key === "Enter" && act.open(f)}
                        className="flex h-14 cursor-pointer items-center gap-3 rounded-xl bg-surface-2 pr-1 pl-4 hover:bg-surface-3"
                      >
                        <FileIcon file={f} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{f.name}</span>
                          <span className="block truncate text-xs text-fg-2">in {f.location.name}</span>
                        </span>
                        <FileDropdown
                          files={[f]}
                          list={folders}
                          context="drive"
                          trigger={
                            <IconButton label={`More actions for ${f.name}`} className="size-9" onClick={(e) => e.stopPropagation()}>
                              <MoreVertical size={20} />
                            </IconButton>
                          }
                        />
                      </div>
                    </FileContextMenu>
                  ))}
                </div>
              )}
            </section>
          )}
          <section>
            <div className="flex items-center justify-between">
              {toggle(showFiles, setShowFiles, "Recent files")}
              <ViewToggle />
            </div>
            {showFiles && <FileBrowser items={q.data?.files ?? []} columns="home" loading={q.isLoading} />}
          </section>
        </>
      )}
    </>
  );
}

export function MyDrivePage() {
  const ui = useDriveUI();
  const q = useQuery(listQuery("/drive/my"));
  return (
    <>
      <PageHeader title="My Files" />
      <FileBrowser
        items={q.data?.items ?? []}
        columns="folder"
        loading={q.isLoading}
        empty={
          <div onDoubleClick={() => ui.newFolder(null)}>
            <Empty icon={<HardDrive size={56} />} title="A place for all of your files" body="Drag your files and folders here or use the New button to upload." />
          </div>
        }
      />
    </>
  );
}

export function FolderPage() {
  const { id } = useParams();
  const ui = useDriveUI();
  const q = useQuery({
    queryKey: ["drive", "folder", id],
    queryFn: () => api<{ folder: DriveFile; path: { id: string | null; name: string }[]; items: DriveFile[] }>(`/folders/${id}`),
  });
  if (q.isError) return <Empty icon={<FolderOpen size={56} />} title="Folder not available" body={(q.error as Error).message} />;
  const path = q.data?.path ?? [];
  const folder = q.data?.folder;
  const rootHref = path[0]?.name === "My Files" ? "/drive" : "/shared";

  return (
    <>
      <PageHeader
        title={
          <nav className="flex min-w-0 items-center text-2xl" aria-label="Breadcrumb">
            {path.slice(0, -1).map((p, i) => (
              <span key={p.id ?? "root"} className={clsx("flex min-w-0 items-center", i < path.length - 3 && "max-sm:hidden")}>
                <Link to={p.id ? `/folders/${p.id}` : rootHref} className="truncate rounded-full px-3 py-1 hover:bg-hover">
                  {p.name}
                </Link>
                <ChevronRight size={20} className="shrink-0" />
              </span>
            ))}
            {folder && (
              <FileDropdown
                files={[folder]}
                list={[]}
                context="drive"
                align="start"
                trigger={
                  <button className="flex min-w-0 items-center gap-1 rounded-full px-3 py-1 hover:bg-hover">
                    <span className="truncate">{folder.name}</span>
                    <ChevronDown size={20} className="shrink-0" />
                  </button>
                }
              />
            )}
          </nav>
        }
        actions={
          folder && (
            <IconButton label="Folder details" onClick={() => ui.setDetailsId(folder.id)}>
              <Info size={20} />
            </IconButton>
          )
        }
      />
      <FileBrowser
        items={q.data?.items ?? []}
        columns="folder"
        loading={q.isLoading}
        empty={
          <Empty
            icon={<FolderOpen size={56} />}
            title="Drop files here"
            body={folder?.role === "viewer" ? "This folder is empty." : "or use the New button. You can also drag files between folders."}
          />
        }
      />
    </>
  );
}

export function SharedPage() {
  const q = useQuery(listQuery("/drive/shared"));
  return (
    <>
      <PageHeader title="Shared with me" />
      <FileBrowser items={q.data?.items ?? []} columns="shared" context="shared" loading={q.isLoading} empty={<Empty icon={<Users size={56} />} title="Files shared with you" body="Things your family shares with you show up here." />} />
    </>
  );
}

export function RecentPage() {
  const q = useQuery(listQuery("/drive/recent"));
  return (
    <>
      <PageHeader title="Recent" />
      <FileBrowser items={q.data?.items ?? []} columns="recent" loading={q.isLoading} empty={<Empty icon={<Clock size={56} />} title="No recent files" body="See all the files you've recently opened, edited or uploaded." />} />
    </>
  );
}

export function StarredPage() {
  const q = useQuery(listQuery("/drive/starred"));
  return (
    <>
      <PageHeader title="Starred" />
      <FileBrowser items={q.data?.items ?? []} columns="starred" loading={q.isLoading} empty={<Empty icon={<Star size={56} />} title="No starred files" body="Add stars to things you want to find easily later." />} />
    </>
  );
}

export function TrashPage() {
  const ui = useDriveUI();
  const act = useFileActions();
  const q = useQuery(listQuery("/drive/trash"));
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Trash"
        actions={
          items.some((f) => f.owner.isMe) && (
            <Button
              onClick={async () => {
                const ok = await ui.confirm({ title: "Delete forever?", body: "All items you own in the trash will be deleted forever. You can't undo this.", confirmLabel: "Delete forever" });
                if (ok) {
                  await api("/drive/trash", { method: "DELETE" });
                  act.refresh();
                }
              }}
            >
              Empty trash
            </Button>
          )
        }
      />
      {items.length > 0 && <div className="mb-3 rounded-lg bg-surface-2 px-4 py-3 text-sm text-fg-2">Items in trash will be deleted forever after 30 days</div>}
      <FileBrowser items={items} columns="trash" context="trash" loading={q.isLoading} empty={<Empty icon={<Trash2 size={56} />} title="Nothing in trash" body="Move items you don't need to trash. Items in trash will be deleted forever after 30 days." />} />
    </>
  );
}

const TYPES = [
  ["", "Any type"],
  ["folder", "Folders"],
  ["image", "Photos & images"],
  ["video", "Videos"],
  ["pdf", "PDFs"],
  ["document", "Documents"],
  ["spreadsheet", "Spreadsheets"],
  ["presentation", "Presentations"],
  ["audio", "Audio"],
] as const;

export function SearchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qs = params.toString();
  const q = useQuery({ queryKey: ["drive", "search", qs], queryFn: () => api<{ items: DriveFile[] }>(`/drive/search?${qs}`) });
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    navigate(`/search?${next}`);
  };
  return (
    <>
      <PageHeader title="Search results" />
      <div className="mb-4 flex flex-wrap gap-2">
        <select value={params.get("type") ?? ""} onChange={(e) => set("type", e.target.value)} className="h-8 rounded-lg border border-line bg-surface px-2 text-sm" aria-label="Type">
          {TYPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={params.get("owner") ?? ""} onChange={(e) => set("owner", e.target.value)} className="h-8 rounded-lg border border-line bg-surface px-2 text-sm" aria-label="People">
          <option value="">Anyone</option>
          <option value="me">Owned by me</option>
          <option value="others">Not owned by me</option>
        </select>
      </div>
      <FileBrowser
        items={q.data?.items ?? []}
        columns="search"
        loading={q.isLoading}
        empty={<Empty icon={<Search size={56} />} title="No results" body="Try a different name or file type." />}
      />
    </>
  );
}

export function NotFoundPage() {
  return (
    <Empty icon={<Compass size={56} />} title="This page doesn't exist" body="The link may be mistyped, or the item was moved or deleted.">
      <div className="mt-6 flex gap-2">
        <Link to="/" className="inline-flex h-10 items-center rounded-full bg-primary px-6 text-sm font-medium text-on-primary hover:shadow-1">
          Go to Home
        </Link>
        <Link to="/drive" className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-primary hover:bg-hover">
          Open My Files
        </Link>
      </div>
    </Empty>
  );
}
