import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useMatch, useNavigate, useSearchParams } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, ChevronRight, Clock, Cloud, FileUp, FolderPlus, FolderUp, HardDrive, Home, LogOut, Menu, Monitor, Moon, Plus, Search, Star, Sun, SunMoon, Trash2, Users, X, UsersRound, Link2Off } from "lucide-react";
import { api } from "../lib/api";
import { applyTheme, type Theme } from "../lib/theme";
import type { Me } from "../lib/types";
import { formatBytes } from "../lib/format";
import { enqueue, filesFromDrop, onUploadFinished, uploadWithPaths } from "../lib/upload";
import { Avatar, IconButton, Logo, useToast } from "./primitives";
import { useDriveUI } from "./DriveUI";
import { DetailsPanel } from "./DetailsPanel";
import { UploadTray } from "./UploadTray";
import { NotificationsMenu } from "./Notifications";
import { useMe } from "./useMe";
import { LegalLinks } from "../pages/legal";

const GOOGLE_ERRORS: Record<string, string> = {
  account_mismatch: "Use the same Google account you sign in to Family Drive with.",
  not_granted: "Google Drive access wasn't granted, so the file couldn't be opened.",
};

function useUploadTarget() {
  const folder = useMatch("/folders/:id");
  return folder?.params.id ?? null;
}

function NewMenu({ onPicked }: { onPicked?: () => void }) {
  const ui = useDriveUI();
  const target = useUploadTarget();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          enqueue([...(e.target.files ?? [])].map((file) => ({ file, parentId: target })));
          e.target.value = "";
          onPicked?.();
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        {...{ webkitdirectory: "" }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          uploadWithPaths(files.map((file) => ({ file, path: file.webkitRelativePath || file.name })), target);
          e.target.value = "";
          onPicked?.();
        }}
      />
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button className="mb-4 ml-2 flex h-14 items-center gap-3 rounded-2xl bg-surface pr-5 pl-4 text-sm font-medium shadow-2 hover:bg-surface-2 hover:shadow-3">
            <Plus size={24} /> New
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
            <DropdownMenu.Item className="menu-item" onSelect={() => ui.newFolder(target)}>
              <FolderPlus /> New folder
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-sep" />
            <DropdownMenu.Item className="menu-item" onSelect={() => fileInput.current?.click()}>
              <FileUp /> File upload
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => folderInput.current?.click()}>
              <FolderUp /> Folder upload
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const me = useMe().data;
  const link = (to: string, Icon: typeof Home, label: string) => (
    <NavLink
      to={to}
      end={to === "/"}
      onClick={onNavigate}
      className={({ isActive }) =>
        clsx("flex h-8 items-center gap-4 rounded-full pr-4 pl-4 text-sm", isActive ? "bg-selected font-medium" : "hover:bg-hover active:bg-pressed")
      }
    >
      <Icon size={20} className="shrink-0" />
      {label}
    </NavLink>
  );
  const pct = me ? Math.min(100, (me.storageUsed / me.storageQuota) * 100) : 0;
  return (
    <nav className="flex h-full flex-col gap-0.5 pr-4 pb-4" aria-label="Drive">
      <NewMenu onPicked={onNavigate} />
      {link("/", Home, "Home")}
      {link("/drive", HardDrive, "My Files")}
      <div className="h-3" />
      {link("/shared", Users, "Shared with me")}
      {link("/recent", Clock, "Recent")}
      {link("/starred", Star, "Starred")}
      <div className="h-3" />
      {link("/trash", Trash2, "Trash")}
      {me?.role === "owner" && link("/family", UsersRound, "Manage family")}
      <div className="flex h-8 items-center gap-4 pl-4 text-sm">
        <Cloud size={20} /> Storage
      </div>
      {me && (
        <div className="pr-2 pl-4">
          <div className="my-2 h-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className={clsx("h-full rounded-full transition-[width] duration-500", pct >= 95 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-primary")}
              style={{ width: `${Math.max(pct, 1)}%` }}
            />
          </div>
          <p className="tabular text-sm text-fg-2">
            {formatBytes(me.storageUsed)} of {formatBytes(me.storageQuota)} used
          </p>
          {pct >= 80 && (
            <p className={clsx("mt-1 text-xs", pct >= 95 ? "text-danger" : "text-warning")}>
              {pct >= 95 ? "Storage almost full. Empty trash or remove large files." : "Storage is getting full."}
            </p>
          )}
        </div>
      )}
      <LegalLinks className="mt-auto pt-6 pl-4 text-xs text-fg-3" />
    </nav>
  );
}

const THEME_OPTIONS = [
  { value: "system", label: "Use device default", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

function AccountMenu() {
  const me = useMe().data;
  const qc = useQueryClient();
  const toast = useToast();
  if (!me) return <span className="size-8" />;
  const setTheme = async (theme: Theme) => {
    const previous = me.theme;
    applyTheme(theme);
    qc.setQueryData<Me>(["me"], (m) => (m ? { ...m, theme } : m));
    try {
      await api("/me", { method: "PATCH", body: { theme } });
    } catch (err) {
      applyTheme(previous);
      qc.setQueryData<Me>(["me"], (m) => (m ? { ...m, theme: previous } : m));
      toast((err as Error).message);
    }
  };
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button aria-label={`Account: ${me.name}`} className="ml-1 rounded-full p-1 hover:bg-hover">
          <Avatar name={me.name} src={me.avatarUrl} size={32} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="menu w-72 pt-4">
          <div className="flex flex-col items-center gap-2 px-4 pb-4 text-center">
            <Avatar name={me.name} src={me.avatarUrl} size={64} />
            <div className="text-lg">Hi, {me.name.split(" ")[0]}!</div>
            <div className="text-sm text-fg-2">{me.email}</div>
          </div>
          <DropdownMenu.Separator className="menu-sep" />
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="menu-item">
              <SunMoon />
              <span className="flex-1">Appearance</span>
              <ChevronRight />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="menu" sideOffset={2}>
                <DropdownMenu.RadioGroup value={me.theme} onValueChange={(v) => setTheme(v as Theme)}>
                  {THEME_OPTIONS.map(({ value, label, Icon }) => (
                    <DropdownMenu.RadioItem key={value} value={value} className="menu-item">
                      <Icon />
                      <span className="flex-1">{label}</span>
                      <DropdownMenu.ItemIndicator>
                        <Check />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          {me.googleDriveConnected && (
            <DropdownMenu.Item
              className="menu-item"
              onSelect={async () => {
                await api("/google", { method: "DELETE" });
                qc.invalidateQueries({ queryKey: ["me"] });
                toast("Disconnected Google Drive");
              }}
            >
              <Link2Off /> Disconnect Google Drive
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            className="menu-item"
            onSelect={async () => {
              await api("/auth/logout", { method: "POST" });
              location.href = "/login";
            }}
          >
            <LogOut /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SearchBar() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const onSearch = useMatch("/search");
  const [q, setQ] = useState(onSearch ? (params.get("q") ?? "") : "");
  useEffect(() => {
    if (!onSearch) setQ("");
  }, [onSearch]);
  return (
    <form
      role="search"
      className="flex h-12 max-w-[720px] flex-1 items-center gap-1 rounded-full bg-surface-3 px-1 hover:bg-surface-2 focus-within:bg-surface focus-within:shadow-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}${params.get("type") ? `&type=${params.get("type")}` : ""}`);
      }}
    >
      <IconButton label="Search" type="submit">
        <Search size={20} />
      </IconButton>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files and folders" aria-label="Search files and folders" className="h-full min-w-0 flex-1 bg-transparent text-base outline-none" />
      {q && (
        <IconButton label="Clear search" onClick={() => setQ("")}>
          <X size={20} />
        </IconButton>
      )}
    </form>
  );
}

export function AppShell() {
  const ui = useDriveUI();
  const qc = useQueryClient();
  const toast = useToast();
  const target = useUploadTarget();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [drawer, setDrawer] = useState(false);
  const [dragging, setDragging] = useState(false);
  const me = useMe();

  // Coalesce refreshes during bulk uploads: one refetch per few seconds instead of one per finished file.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    onUploadFinished(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        qc.invalidateQueries({ queryKey: ["drive"] });
        qc.invalidateQueries({ queryKey: ["me"] });
      }, 3000);
    });
    return () => clearTimeout(timer);
  }, [qc]);

  useEffect(() => {
    const err = params.get("google_error");
    if (err) {
      toast(GOOGLE_ERRORS[err] ?? "Couldn't open the file in Google");
      params.delete("google_error");
      setParams(params, { replace: true });
    }
  }, [params, setParams, toast]);

  useEffect(() => setDrawer(false), [location.pathname]);

  // The account's saved theme wins over the locally cached one (e.g. changed on another device).
  const savedTheme = me.data?.theme;
  useEffect(() => {
    if (savedTheme) applyTheme(savedTheme);
  }, [savedTheme]);

  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget || !(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={async (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setDragging(false);
        const items = await filesFromDrop(e.dataTransfer);
        if (items.some((i) => i.path.includes("/"))) uploadWithPaths(items, target);
        else enqueue(items.map((i) => ({ file: i.file, parentId: target })));
      }}
    >
      <a href="#content" className="skip-link">
        Skip to files
      </a>
      <header className="flex h-16 shrink-0 items-center gap-2 px-2 sm:px-4">
        <IconButton label="Main menu" className="lg:hidden" onClick={() => setDrawer(true)}>
          <Menu size={22} />
        </IconButton>
        <NavLink to="/" className="flex shrink-0 items-center gap-2 pr-4 max-sm:hidden lg:w-[232px]">
          <Logo className="size-9" />
          <span className="text-[22px] text-fg-2">{me.data?.appName ?? "Drive"}</span>
        </NavLink>
        <SearchBar />
        <div className="ml-auto flex items-center">
          <NotificationsMenu />
          <AccountMenu />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4 pr-2 pb-2 sm:pr-4 sm:pb-4">
        <aside className="w-[256px] shrink-0 overflow-auto pl-2 max-lg:hidden">
          <Sidebar />
        </aside>
        {drawer && (
          <div className="fixed inset-0 z-(--z-overlay) lg:hidden" onClick={() => setDrawer(false)}>
            <div className="absolute inset-0 bg-[var(--scrim)]" />
            <div className="animate-fade absolute inset-y-0 left-0 w-[280px] overflow-auto bg-bg pt-4 pl-2" onClick={(e) => e.stopPropagation()}>
              <Sidebar onNavigate={() => setDrawer(false)} />
            </div>
          </div>
        )}
        <main id="content" tabIndex={-1} className="relative min-w-0 flex-1 overflow-hidden rounded-2xl bg-surface outline-none max-sm:ml-2">
          <div className="scrollbar-thin h-full overflow-auto px-4 sm:px-5">
            <Outlet />
          </div>
          {dragging && (
            <div className="pointer-events-none absolute inset-0 flex items-end justify-center rounded-2xl border-2 border-primary bg-primary/10 p-8">
              <div className="animate-rise rounded-full bg-primary px-6 py-3 text-sm text-on-primary shadow-3">Drop files to upload them {target ? "to this folder" : "to My Files"}</div>
            </div>
          )}
        </main>
        {ui.detailsId && <DetailsPanel id={ui.detailsId} />}
      </div>
      <UploadTray />
    </div>
  );
}
