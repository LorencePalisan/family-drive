import { MaterialIcons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useState, type ReactElement } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { formatBytes, formatDate } from "@shared/format";
import type { DriveFile } from "@shared/types";
import { thumbnailSource } from "@/lib/api";
import { useColors } from "@/lib/theme";
import { FileActions } from "./FileActions";
import { FileIcon } from "./FileIcon";

export function openItem(f: DriveFile) {
  if (f.trashedAt) return;
  router.push(f.isFolder ? { pathname: "/folder/[id]", params: { id: f.id } } : { pathname: "/file/[id]", params: { id: f.id } });
}

function subtitle(f: DriveFile) {
  if (f.recent) return `${f.recent.action === "opened" ? "You opened" : f.recent.action === "uploaded" ? "Uploaded" : "Modified"} ${formatDate(f.recent.at)}`;
  const parts = [f.owner.isMe ? null : f.owner.name, f.isFolder ? null : formatBytes(f.size), formatDate(f.updatedAt)];
  return parts.filter(Boolean).join(" · ");
}

export function FileRow({ file, onMore }: { file: DriveFile; onMore: (f: DriveFile) => void }) {
  const c = useColors();
  return (
    <Pressable android_ripple={{ color: c.selected }} onPress={() => openItem(file)} onLongPress={() => onMore(file)} style={styles.row}>
      <View style={[styles.thumb, { backgroundColor: c.surface2 }]}>
        {file.hasThumbnail ? (
          <Image source={thumbnailSource(file)} style={StyleSheet.absoluteFill} contentFit="cover" recyclingKey={file.id} cachePolicy="disk" />
        ) : (
          <FileIcon file={file} />
        )}
      </View>
      <View style={styles.text}>
        <View style={styles.nameLine}>
          <Text numberOfLines={1} style={[styles.name, { color: c.text }]}>
            {file.name}
          </Text>
          {file.starred ? <MaterialIcons name="star" size={14} color={c.text3} /> : null}
          {file.shared ? <MaterialIcons name="people" size={14} color={c.text3} /> : null}
        </View>
        <Text numberOfLines={1} style={[styles.sub, { color: c.text3 }]}>
          {subtitle(file)}
        </Text>
      </View>
      <Pressable hitSlop={8} onPress={() => onMore(file)} style={styles.more}>
        <MaterialIcons name="more-vert" size={22} color={c.text2} />
      </Pressable>
    </Pressable>
  );
}

/** Folders first, then files; pull to refresh; "⋮" opens the action sheet. */
export function FileList({
  items,
  loading,
  error,
  onRefresh,
  refreshing = false,
  empty,
  header,
}: {
  items: DriveFile[] | undefined;
  loading: boolean;
  error?: Error | null;
  onRefresh: () => void;
  refreshing?: boolean;
  empty: { icon: keyof typeof MaterialIcons.glyphMap; title: string; body?: string };
  header?: ReactElement;
}) {
  const c = useColors();
  const [menuFor, setMenuFor] = useState<DriveFile | null>(null);
  const sorted = items && [...items.filter((f) => f.isFolder), ...items.filter((f) => !f.isFolder)];

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <FlatList
        data={sorted ?? []}
        keyExtractor={(f) => f.id}
        renderItem={({ item }) => <FileRow file={item} onMore={setMenuFor} />}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[c.primary]} progressBackgroundColor={c.surface} />}
        contentContainerStyle={{ paddingBottom: 120, flexGrow: 1 }}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ marginTop: 48 }} color={c.primary} />
          ) : error ? (
            <EmptyState icon="cloud-off" title="Couldn't load this" body={error.message} />
          ) : (
            <EmptyState {...empty} />
          )
        }
      />
      <FileActions file={menuFor} onClose={() => setMenuFor(null)} />
    </View>
  );
}

export function EmptyState({ icon, title, body }: { icon: keyof typeof MaterialIcons.glyphMap; title: string; body?: string }) {
  const c = useColors();
  return (
    <View style={styles.empty}>
      <MaterialIcons name={icon} size={56} color={c.text3} />
      <Text style={[styles.emptyTitle, { color: c.text }]}>{title}</Text>
      {body ? <Text style={[styles.emptyBody, { color: c.text3 }]}>{body}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 4, height: 68, gap: 16 },
  thumb: { width: 44, height: 44, borderRadius: 8, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: { fontSize: 16, flexShrink: 1 },
  sub: { fontSize: 13, marginTop: 2 },
  more: { padding: 12 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8, marginTop: 48 },
  emptyTitle: { fontSize: 18, fontWeight: "500", marginTop: 8, textAlign: "center" },
  emptyBody: { fontSize: 14, textAlign: "center" },
});
