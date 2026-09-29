import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useNavigate } from "react-router";
import type { Notification } from "../lib/types";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { Avatar, IconButton } from "./primitives";

function describe(n: Notification) {
  const who = n.actorName ?? "Someone";
  const what = n.fileName ? `"${n.fileName}"` : "an item";
  switch (n.type) {
    case "shared":
      return `${who} shared ${what} with you${n.payload?.role === "editor" ? " (can edit)" : ""}`;
    case "file_added":
      return `${who} added ${what} to "${n.payload?.folderName ?? "your folder"}"`;
    case "invite_accepted":
      return `${who} joined the family drive`;
    case "google_saved":
      return `${who} saved changes to ${what} from Google`;
  }
}

export function NotificationsMenu() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<{ items: Notification[]; unread: number }>("/notifications"),
    refetchInterval: 2 * 60_000,
    refetchOnWindowFocus: true,
  });
  const unread = q.data?.unread ?? 0;

  return (
    <DropdownMenu.Root
      modal={false}
      onOpenChange={(open) => {
        if (!open && unread) api("/notifications/read", { body: {} }).then(() => qc.invalidateQueries({ queryKey: ["notifications"] }));
      }}
    >
      <DropdownMenu.Trigger asChild>
        <IconButton label={unread ? `Notifications (${unread} unread)` : "Notifications"} className="relative">
          <Bell size={22} />
          {unread > 0 && (
            <span className="absolute top-1.5 right-1.5 flex min-w-4 items-center justify-center rounded-full bg-[#d0342c] px-1 text-[10px] leading-4 font-medium text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={8} className="menu w-[min(380px,calc(100vw-16px))] py-2">
          <div className="px-4 pb-2 text-base font-medium">Notifications</div>
          {!q.data?.items.length && <div className="px-4 py-6 text-center text-sm text-fg-2">You're all caught up</div>}
          <div className="scrollbar-thin max-h-[60vh] overflow-auto">
            {q.data?.items.map((n) => (
              <DropdownMenu.Item
                key={n.id}
                className="flex cursor-pointer gap-3 px-4 py-3 outline-none data-[highlighted]:bg-hover"
                onSelect={() => {
                  if (n.fileId) navigate(n.isFolder ? `/folders/${n.fileId}` : `/file/${n.fileId}`);
                  else if (n.type === "invite_accepted") navigate("/family");
                }}
              >
                <Avatar name={n.actorName ?? "?"} src={n.actorAvatar} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{describe(n)}</p>
                  {n.payload?.message && <p className="mt-1 truncate rounded bg-surface-3 px-2 py-1 text-xs text-fg-2">“{n.payload.message}”</p>}
                  <p className="mt-1 text-xs text-fg-2">{timeAgo(n.createdAt)}</p>
                </div>
                {!n.readAt && <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
              </DropdownMenu.Item>
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
