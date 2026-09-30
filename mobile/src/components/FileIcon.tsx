import { MaterialIcons } from "@expo/vector-icons";
import { fileKind, type Kind } from "@shared/format";
import type { DriveFile } from "@shared/types";
import { useColors } from "@/lib/theme";

/** Same colors as the web app's file icons; null means the theme's secondary text color. */
const ICONS: Record<Kind, { name: keyof typeof MaterialIcons.glyphMap; color: string | null }> = {
  folder: { name: "folder", color: null },
  image: { name: "image", color: "#e0633f" },
  video: { name: "movie", color: "#c2417a" },
  audio: { name: "audiotrack", color: "#8b5cf6" },
  pdf: { name: "picture-as-pdf", color: "#d64a3b" },
  doc: { name: "description", color: "#2f6fdb" },
  sheet: { name: "grid-on", color: "#1f8a5b" },
  slides: { name: "slideshow", color: "#e07b24" },
  archive: { name: "folder-zip", color: null },
  text: { name: "article", color: null },
  file: { name: "insert-drive-file", color: null },
};

export function FileIcon({ file, size = 24 }: { file: Pick<DriveFile, "isFolder" | "mime" | "name">; size?: number }) {
  const c = useColors();
  const { name, color } = ICONS[fileKind(file)];
  return <MaterialIcons name={name} size={size} color={color ?? c.text2} />;
}
