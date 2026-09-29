import * as Dialog from "@radix-ui/react-dialog";
import { X, Folder, Image, Film, Music, FileText, Sheet, Presentation, FileArchive, File, FileType2 } from "lucide-react";
import clsx from "clsx";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { fileKind, type Kind } from "../lib/format";
import type { DriveFile } from "../lib/types";

const KIND_ICON: Record<Kind, { Icon: typeof File; color: string }> = {
  folder: { Icon: Folder, color: "var(--text-2)" },
  image: { Icon: Image, color: "#e0633f" },
  video: { Icon: Film, color: "#c2417a" },
  audio: { Icon: Music, color: "#8b5cf6" },
  pdf: { Icon: FileType2, color: "#d64a3b" },
  doc: { Icon: FileText, color: "#2f6fdb" },
  sheet: { Icon: Sheet, color: "#1f8a5b" },
  slides: { Icon: Presentation, color: "#e07b24" },
  archive: { Icon: FileArchive, color: "var(--text-2)" },
  text: { Icon: FileText, color: "var(--text-2)" },
  file: { Icon: File, color: "var(--text-2)" },
};

/** The Family Drive mark, drawn inline so it follows the light/dark theme. */
export function Logo({ className, label }: { className?: string; label?: string }) {
  return (
    <svg viewBox="38 14 224 224" className={className} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path fill="var(--logo-accent)" d="M202 116 212 108C232 118 239 134 239 150 239 176 227 194 205 194H186C198 194 202 188 202 176Z" />
      <path
        fill="none"
        stroke="var(--logo-ink)"
        strokeWidth="19"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M52 131 150 50l62 51c22 8 35 27 35 49 0 29-18 52-44 52H100c-10 0-16-6-16-16V68"
      />
      <path fill="var(--logo-ink)" d="M115 131c0-4 3-6 6-6h17l6 6h26c4 0 6 3 6 6v22c0 4-2 6-6 6h-49c-4 0-6-2-6-6z" />
    </svg>
  );
}

export function FileIcon({ file, size = 20, className }: { file: Pick<DriveFile, "isFolder" | "mime" | "name">; size?: number; className?: string }) {
  const { Icon, color } = KIND_ICON[fileKind(file)];
  return <Icon size={size} color={color} fill={file.isFolder ? color : "none"} fillOpacity={file.isFolder ? 1 : 0} className={clsx("shrink-0", className)} />;
}

export function Avatar({ name, src, size = 24 }: { name: string; src?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      <img src={src} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
    );
  }
  const hue = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{ width: size, height: size, fontSize: size * 0.45, background: `hsl(${hue} 55% 45%)` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function IconButton({ label, className, children, ...rest }: { label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-label={label} title={label} className={clsx("inline-flex size-10 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-hover active:bg-pressed disabled:opacity-40", className)} {...rest}>
      {children}
    </button>
  );
}

export function Button({ variant = "text", className, ...rest }: { variant?: "filled" | "tonal" | "text" | "outlined" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={clsx(
        "inline-flex h-10 items-center justify-center gap-2 rounded-full px-6 text-sm font-medium disabled:opacity-40",
        variant === "filled" && "bg-primary text-on-primary hover:shadow-1 hover:brightness-110",
        variant === "tonal" && "bg-primary-soft text-fg hover:shadow-1",
        variant === "text" && "px-3 text-primary hover:bg-hover",
        variant === "outlined" && "border border-line text-primary hover:bg-hover",
        className,
      )}
      {...rest}
    />
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  children,
  width = 440,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="animate-fade fixed inset-0 z-(--z-overlay) bg-[var(--scrim)] backdrop-blur-[2px]" />
        <Dialog.Content
          className="animate-fade fixed top-1/2 left-1/2 z-(--z-overlay) max-h-[90dvh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-[28px] bg-surface p-6 shadow-3"
          style={{ maxWidth: width }}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Let a field opt in to initial focus (e.g. the rename box) instead of the close button.
            const target = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[data-autofocus]");
            if (target) {
              e.preventDefault();
              target.focus();
              if (target instanceof HTMLInputElement) target.setSelectionRange(0, Number(target.dataset.selectEnd ?? target.value.length));
            }
          }}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <Dialog.Title className="text-2xl font-normal break-all">{title}</Dialog.Title>
            <Dialog.Close className="-mt-1 -mr-2 rounded-full p-2 text-fg-2 hover:bg-hover" aria-label="Close">
              <X size={20} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const inputClass =
  "h-12 w-full rounded border border-line bg-transparent px-3 text-base outline-none focus:border-primary focus:ring-1 focus:ring-primary";

// ---- Toasts ------------------------------------------------------------------------------------

type Toast = { id: number; message: string; action?: { label: string; run: () => void } };
const ToastCtx = createContext<(message: string, action?: Toast["action"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

let seq = 0;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((message: string, action?: Toast["action"]) => {
    const id = ++seq;
    setToasts((t) => [...t.slice(-2), { id, message, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 8000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed bottom-6 left-6 z-(--z-toast) flex flex-col gap-2 max-sm:right-4 max-sm:left-4">
        {toasts.map((t) => (
          <div key={t.id} role="status" className="animate-fade pointer-events-auto flex min-h-12 items-center gap-4 rounded-lg bg-[#303030] px-4 py-2 text-sm text-[#f2f2f2] shadow-3 animate-rise sm:max-w-md">
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button
                className="font-medium text-[#7dd3c0]"
                onClick={() => {
                  t.action!.run();
                  setToasts((x) => x.filter((y) => y.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
            <button aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X size={18} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
