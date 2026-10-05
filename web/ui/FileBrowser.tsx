import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Check, Download, FolderInput, LayoutGrid, Link, List, MoreVertical, RotateCcw, Star, Trash2, UserPlus, Users, X } from "lucide-react";
import type { DriveFile } from "../lib/types";
import { driveSource } from "../lib/api";
import { fileKind, formatBytes, formatDate } from "../lib/format";
import { Avatar, FileIcon, IconButton } from "./primitives";
import { FileContextMenu, FileDropdown, type MenuContext } from "./FileMenu";
import { useDriveUI, useFileActions } from "./DriveUI";

export type Columns = "folder" | "home" | "recent" | "shared" | "trash" | "search" | "starred";
type SortKey = "name" | "updatedAt" | "size";

const RENDER_STEP = 200;
const DRAG_TYPE = "application/x-drive-ids";
const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

function reason(f: DriveFile) {
  if (!f.recent) return `You ${f.owner.isMe ? "created" : "opened"} • ${formatDate(f.createdAt)}`;
  return `You ${f.recent.action} • ${formatDate(f.recent.at)}`;
}

export function ViewToggle() {
  const { view, setView } = useDriveUI();
  return (
    <div className="flex h-8 overflow-hidden rounded-full border border-fg-3" role="group" aria-label="Layout">
      {(["list", "grid"] as const).map((v) => (
        <button
          key={v}
          aria-pressed={view === v}
          aria-label={v === "list" ? "List layout" : "Grid layout"}
          onClick={() => setView(v)}
          className={clsx("flex items-center gap-1 px-3", view === v ? "bg-selected" : "hover:bg-hover")}
        >
          {view === v && <Check size={16} />}
          {v === "list" ? <List size={18} /> : <LayoutGrid size={18} />}
        </button>
      ))}
    </div>
  );
}

function OwnerCell({ f }: { f: DriveFile }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={f.owner.name} src={f.owner.avatarUrl} size={24} />
      <span className="truncate">{f.owner.isMe ? "me" : f.owner.name}</span>
    </span>
  );
}

function Thumb({ f, className }: { f: DriveFile; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (f.hasThumbnail && !broken) {
    return <img src={driveSource.thumbnail(f)} alt="" loading="lazy" onError={() => setBroken(true)} className={clsx("object-cover", className)} />;
  }
  return (
    <div className={clsx("flex items-center justify-center bg-surface", className)}>
      <FileIcon file={f} size={56} />
    </div>
  );
}

/** Placeholder shaped like the list/grid so the page doesn't jump when data arrives. */
export function BrowserSkeleton({ grid, rows = 8 }: { grid?: boolean; rows?: number }) {
  if (grid) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 pt-10 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" aria-busy="true" aria-label="Loading">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="rounded-xl bg-surface-2 p-2">
            <div className="flex h-11 items-center gap-3 px-2">
              <div className="skeleton size-5" />
              <div className="skeleton h-3.5 flex-1" style={{ maxWidth: `${55 + ((i * 17) % 35)}%` }} />
            </div>
            <div className="skeleton aspect-[4/3] w-full rounded-lg" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="h-12 border-b border-line" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-12 items-center gap-4 border-b border-line px-4">
          <div className="skeleton size-5 shrink-0" />
          <div className="skeleton h-3.5" style={{ width: `${28 + ((i * 23) % 30)}%` }} />
          <div className="skeleton ml-auto h-3.5 w-24 max-sm:hidden" />
          <div className="skeleton h-3.5 w-20 max-md:hidden" />
        </div>
      ))}
    </div>
  );
}

export function FileBrowser({
  items,
  columns,
  context = "drive",
  empty,
  loading,
}: {
  items: DriveFile[];
  columns: Columns;
  context?: MenuContext;
  empty?: ReactNode;
  loading?: boolean;
}) {
  const ui = useDriveUI();
  const act = useFileActions();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return items;
    const val = (f: DriveFile) => (sort.key === "name" ? f.name.toLowerCase() : f[sort.key]);
    return [...items].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [items, sort]);

  // Drop selections that no longer exist (after trash/move).
  useEffect(() => {
    setSelected((s) => {
      const ids = new Set(items.map((i) => i.id));
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [items]);

  // Big folders render in steps as you scroll; selection, sorting and preview still use the full list.
  const [shown, setShown] = useState(RENDER_STEP);
  const visible = sorted.length > shown ? sorted.slice(0, shown) : sorted;
  const sentinel = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && setShown((n) => n + RENDER_STEP), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const more = visible.length < sorted.length && <div ref={sentinel} className="h-px" />;

  const selectedFiles = sorted.filter((f) => selected.has(f.id));
  const filesFor = (f: DriveFile) => (selected.has(f.id) ? selectedFiles : [f]);

  function onRowClick(e: React.MouseEvent, f: DriveFile) {
    e.stopPropagation();
    if (coarse && !selected.size) return act.open(f, sorted);
    if (e.shiftKey && anchor) {
      const a = sorted.findIndex((x) => x.id === anchor);
      const b = sorted.findIndex((x) => x.id === f.id);
      setSelected(new Set(sorted.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)));
      return;
    }
    if (e.metaKey || e.ctrlKey || (coarse && selected.size)) {
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(f.id)) n.delete(f.id);
        else n.add(f.id);
        return n;
      });
    } else setSelected(new Set([f.id]));
    setAnchor(f.id);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ui.preview || (e.target as HTMLElement).closest("input, textarea, [role=dialog], [role=menu]")) return;
      if (e.key === "Escape") setSelected(new Set());
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        setSelected(new Set(sorted.map((f) => f.id)));
      }
      if (!selectedFiles.length) return;
      if (e.key === "Enter" && selectedFiles.length === 1) act.open(selectedFiles[0], sorted);
      if ((e.key === "Delete" || e.key === "Backspace") && context !== "trash" && selectedFiles.every((f) => f.role !== "viewer")) act.trash(selectedFiles);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sorted, selectedFiles, act, context, ui.preview]);

  const dragProps = (f: DriveFile) => ({
    draggable: context !== "trash" && f.role !== "viewer",
    onDragStart: (e: React.DragEvent) => {
      const ids = filesFor(f).map((x) => x.id);
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer.effectAllowed = "move";
    },
  });
  const dropProps = (f: DriveFile) =>
    f.isFolder && f.role !== "viewer" && context !== "trash"
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            setDropTarget(f.id);
          },
          onDragLeave: () => setDropTarget((t) => (t === f.id ? null : t)),
          onDrop: (e: React.DragEvent) => {
            const raw = e.dataTransfer.getData(DRAG_TYPE);
            setDropTarget(null);
            if (!raw) return;
            e.preventDefault();
            e.stopPropagation();
            const ids: string[] = JSON.parse(raw);
            const moving = items.filter((x) => ids.includes(x.id) && x.id !== f.id);
            if (moving.length) act.moveTo(moving, f.id, f.name);
          },
        }
      : {};

  if (loading) return <BrowserSkeleton grid={ui.view === "grid"} />;
  if (!items.length) return <>{empty}</>;

  const header = (key: SortKey | null, label: string, className?: string) => (
    <th className={clsx("h-12 px-2 text-left text-sm font-medium whitespace-nowrap text-fg", className)}>
      {key ? (
        <button
          className="-mx-2 flex items-center gap-1 rounded-full px-2 py-1 hover:bg-hover"
          onClick={() => setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 }))}
        >
          {label}
          {sort?.key === key && (sort.dir === 1 ? <ArrowUp size={16} /> : <ArrowDown size={16} />)}
        </button>
      ) : (
        label
      )}
    </th>
  );

  const selectionBar = selectedFiles.length > 0 && (
    <div className="mb-2 flex h-12 items-center gap-1 rounded-full bg-surface-2 px-1 text-sm">
      <IconButton label="Clear selection" onClick={() => setSelected(new Set())}>
        <X size={20} />
      </IconButton>
      <span className="mr-2">{selectedFiles.length} selected</span>
      {context === "trash" ? (
        <>
          <IconButton label="Restore" onClick={() => act.restore(selectedFiles)}>
            <RotateCcw size={20} />
          </IconButton>
          <IconButton label="Delete forever" onClick={() => act.deleteForever(selectedFiles)} disabled={!selectedFiles.every((f) => f.owner.isMe)}>
            <Trash2 size={20} />
          </IconButton>
        </>
      ) : (
        <>
          {selectedFiles.length === 1 && (
            <IconButton label="Share" onClick={() => ui.share(selectedFiles[0])}>
              <UserPlus size={20} />
            </IconButton>
          )}
          <IconButton label="Download" onClick={() => act.download(selectedFiles)}>
            <Download size={20} />
          </IconButton>
          <IconButton label="Move" onClick={() => ui.move(selectedFiles)} disabled={selectedFiles.some((f) => f.role === "viewer")}>
            <FolderInput size={20} />
          </IconButton>
          <IconButton label="Move to trash" onClick={() => act.trash(selectedFiles)} disabled={selectedFiles.some((f) => f.role === "viewer")}>
            <Trash2 size={20} />
          </IconButton>
          {selectedFiles.length === 1 && (
            <IconButton label="Copy link" onClick={() => act.copyLink(selectedFiles[0])}>
              <Link size={20} />
            </IconButton>
          )}
          <FileDropdown
            files={selectedFiles}
            list={sorted}
            context={context}
            align="start"
            trigger={
              <IconButton label="More actions">
                <MoreVertical size={20} />
              </IconButton>
            }
          />
        </>
      )}
    </div>
  );

  const moreButton = (f: DriveFile) => (
    <FileDropdown
      files={filesFor(f)}
      list={sorted}
      context={context}
      trigger={
        <IconButton label={`More actions for ${f.name}`} onClick={(e) => e.stopPropagation()} className="size-9">
          <MoreVertical size={20} />
        </IconButton>
      }
    />
  );

  const rowMenu = (f: DriveFile, node: ReactNode) => (
    <FileContextMenu
      key={f.id}
      files={filesFor(f)}
      list={sorted}
      context={context}
      onOpenChange={(open) => {
        if (open && !selected.has(f.id)) setSelected(new Set([f.id]));
      }}
    >
      {node}
    </FileContextMenu>
  );

  if (ui.view === "grid") {
    const folders = visible.filter((f) => f.isFolder);
    const files = visible.filter((f) => !f.isFolder);
    const tileClass = (f: DriveFile) =>
      clsx(
        "cursor-default rounded-xl outline-none select-none",
        selected.has(f.id) ? "bg-selected" : "bg-surface-2 hover:bg-surface-3 hover:shadow-1 active:bg-pressed",
        dropTarget === f.id && "ring-2 ring-primary",
      );
    return (
      <div onClick={() => setSelected(new Set())} className="min-h-full pb-24">
        {selectionBar}
        {folders.length > 0 && (
          <>
            <h3 className="mt-2 mb-3 text-sm font-medium">Folders</h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {folders.map((f) =>
                rowMenu(
                  f,
                  <div
                    tabIndex={0}
                    className={clsx(tileClass(f), "flex h-12 items-center gap-3 pr-1 pl-4")}
                    onClick={(e) => onRowClick(e, f)}
                    onDoubleClick={() => act.open(f, sorted)}
                    {...dragProps(f)}
                    {...dropProps(f)}
                  >
                    <FileIcon file={f} />
                    <span className="flex-1 truncate text-sm font-medium">{f.name}</span>
                    {f.shared && <Users size={16} className="text-fg-2" />}
                    {moreButton(f)}
                  </div>,
                ),
              )}
            </div>
          </>
        )}
        {files.length > 0 && (
          <>
            <h3 className="mt-6 mb-3 text-sm font-medium">Files</h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
              {files.map((f) =>
                rowMenu(
                  f,
                  <div
                    tabIndex={0}
                    className={clsx(tileClass(f), "flex flex-col p-2 pt-1")}
                    onClick={(e) => onRowClick(e, f)}
                    onDoubleClick={() => act.open(f, sorted)}
                    {...dragProps(f)}
                  >
                    <div className="flex h-11 items-center gap-3 pl-2">
                      <FileIcon file={f} />
                      <span className="flex-1 truncate text-sm font-medium" title={f.name}>
                        {f.name}
                      </span>
                      {moreButton(f)}
                    </div>
                    <div className="relative">
                      <Thumb f={f} className="aspect-[4/3] w-full rounded-lg" />
                      {fileKind(f) === "video" && f.hasThumbnail && (
                        <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 text-xs text-white">▶</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 px-1 pt-2 text-xs text-fg-2">
                      <Avatar name={f.owner.name} src={f.owner.avatarUrl} size={20} />
                      <span className="truncate">{columns === "trash" ? `Trashed ${formatDate(f.trashedAt ?? 0)}` : columns === "home" || columns === "recent" ? reason(f) : `Modified ${formatDate(f.updatedAt)}`}</span>
                    </div>
                  </div>,
                ),
              )}
            </div>
          </>
        )}
        {more}
      </div>
    );
  }

  const cols: Record<Columns, { label: string; key: SortKey | null; cell: (f: DriveFile) => ReactNode; className?: string }[]> = {
    folder: [
      { label: "Owner", key: null, cell: (f) => <OwnerCell f={f} />, className: "w-[18%] max-md:hidden" },
      { label: "Last modified", key: "updatedAt", cell: (f) => formatDate(f.updatedAt), className: "w-[18%] max-sm:hidden" },
      { label: "File size", key: "size", cell: (f) => (f.isFolder ? "—" : formatBytes(f.size)), className: "w-[14%] max-lg:hidden" },
    ],
    starred: [
      { label: "Owner", key: null, cell: (f) => <OwnerCell f={f} />, className: "w-[18%] max-md:hidden" },
      { label: "Last modified", key: "updatedAt", cell: (f) => formatDate(f.updatedAt), className: "w-[18%] max-sm:hidden" },
      { label: "Location", key: null, cell: (f) => f.location.name, className: "w-[18%] max-lg:hidden" },
    ],
    home: [
      { label: "Activity", key: null, cell: reason, className: "w-[26%] max-sm:hidden" },
      { label: "Owner", key: null, cell: (f) => <OwnerCell f={f} />, className: "w-[18%] max-md:hidden" },
      { label: "Location", key: null, cell: (f) => f.location.name, className: "w-[18%] max-lg:hidden" },
    ],
    recent: [
      { label: "Last activity", key: null, cell: reason, className: "w-[26%] max-sm:hidden" },
      { label: "Owner", key: null, cell: (f) => <OwnerCell f={f} />, className: "w-[18%] max-md:hidden" },
      { label: "Location", key: null, cell: (f) => f.location.name, className: "w-[18%] max-lg:hidden" },
    ],
    shared: [
      { label: "Shared by", key: null, cell: (f) => <OwnerCell f={f} />, className: "w-[22%] max-md:hidden" },
      { label: "Last modified", key: "updatedAt", cell: (f) => formatDate(f.updatedAt), className: "w-[18%] max-sm:hidden" },
    ],
    search: [
      { label: "Owner", key: null, cell: (f) => <OwnerCell f={f} />, className: "w-[18%] max-md:hidden" },
      { label: "Last modified", key: "updatedAt", cell: (f) => formatDate(f.updatedAt), className: "w-[18%] max-sm:hidden" },
      { label: "Location", key: null, cell: (f) => f.location.name, className: "w-[18%] max-lg:hidden" },
    ],
    trash: [
      { label: "Owner", key: null, cell: (f) => <OwnerCell f={f} />, className: "w-[18%] max-md:hidden" },
      { label: "Date trashed", key: null, cell: (f) => formatDate(f.trashedAt ?? 0), className: "w-[18%] max-sm:hidden" },
      { label: "File size", key: "size", cell: (f) => (f.isFolder ? "—" : formatBytes(f.size)), className: "w-[14%] max-lg:hidden" },
    ],
  };

  return (
    <div onClick={() => setSelected(new Set())} className="min-h-full pb-24">
      {selectionBar}
      <table className="w-full table-fixed border-collapse text-sm">
        <thead className="sticky top-16 z-(--z-sticky) bg-surface">
          <tr className="border-b border-line">
            {header("name", "Name")}
            {cols[columns].map((c) => (
              <th key={c.label} className={clsx("h-12 px-2 text-left text-sm font-medium", c.className)}>
                {c.key ? (
                  <button
                    className="-mx-2 flex items-center gap-1 rounded-full px-2 py-1 hover:bg-hover"
                    onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key!, dir: s.dir === 1 ? -1 : 1 } : { key: c.key!, dir: -1 }))}
                  >
                    {c.label}
                    {sort?.key === c.key && (sort.dir === 1 ? <ArrowUp size={16} /> : <ArrowDown size={16} />)}
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
            <th className="w-12" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {visible.map((f) =>
            rowMenu(
              f,
              <tr
                tabIndex={0}
                aria-selected={selected.has(f.id)}
                className={clsx(
                  "h-12 cursor-default border-b border-line outline-none select-none",
                  selected.has(f.id) ? "bg-selected" : "hover:bg-hover active:bg-pressed",
                  dropTarget === f.id && "outline-2 -outline-offset-2 outline-primary",
                )}
                onClick={(e) => onRowClick(e, f)}
                onDoubleClick={() => act.open(f, sorted)}
                {...dragProps(f)}
                {...dropProps(f)}
              >
                <td className="px-2">
                  <div className="flex min-w-0 items-center gap-4 pl-2">
                    <FileIcon file={f} />
                    <span className="truncate font-medium" title={f.name}>
                      {f.name}
                    </span>
                    {f.shared && <Users size={16} className="shrink-0 text-fg-2" aria-label="Shared" />}
                    {f.starred && <Star size={14} className="shrink-0 fill-current text-fg-2" aria-label="Starred" />}
                  </div>
                </td>
                {cols[columns].map((c) => (
                  <td key={c.label} className={clsx("truncate px-2 text-fg-2", c.className)}>
                    {c.cell(f)}
                  </td>
                ))}
                <td className="pr-1 text-right">{moreButton(f)}</td>
              </tr>,
            ),
          )}
        </tbody>
      </table>
      {more}
    </div>
  );
}
