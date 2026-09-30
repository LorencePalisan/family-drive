import { MaterialIcons } from "@expo/vector-icons";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { FileList, openItem } from "@/components/FileList";
import { DriveBottom } from "@/components/UploadControls";
import { useHome } from "@/lib/queries";
import { useColors } from "@/lib/theme";

export default function Home() {
  const c = useColors();
  const home = useHome();
  const folders = home.data?.folders ?? [];

  const header = folders.length ? (
    <View>
      <Text style={[styles.section, { color: c.text2 }]}>Suggested folders</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {folders.map((f) => (
          <Pressable key={f.id} onPress={() => openItem(f)} android_ripple={{ color: c.selected }} style={[styles.chip, { backgroundColor: c.surface2 }]}>
            <MaterialIcons name={f.shared ? "folder-shared" : "folder"} size={22} color={c.text2} />
            <Text numberOfLines={1} style={[styles.chipLabel, { color: c.text }]}>
              {f.name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <Text style={[styles.section, { color: c.text2 }]}>Recent files</Text>
    </View>
  ) : undefined;

  return (
    <View style={{ flex: 1 }}>
      <FileList
        items={home.data?.files}
        loading={home.isPending}
        error={home.error}
        refreshing={home.isRefetching}
        onRefresh={() => home.refetch()}
        header={header}
        empty={{ icon: "cloud-upload", title: "Welcome to Family Drive", body: "Tap New to upload photos, videos and files." }}
      />
      <DriveBottom parentId={null} inTabs />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 14, fontWeight: "500", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  chips: { paddingHorizontal: 16, gap: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 10, height: 48, borderRadius: 12, paddingHorizontal: 14, maxWidth: 220, overflow: "hidden" },
  chipLabel: { fontSize: 15, flexShrink: 1 },
});
