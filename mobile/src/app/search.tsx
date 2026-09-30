import { MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FileList } from "@/components/FileList";
import { useSearch } from "@/lib/queries";
import { useColors } from "@/lib/theme";

/** Same type filters as the web search chips (the worker's TYPE_FILTERS). */
const TYPES = [
  ["image", "Photos"],
  ["video", "Videos"],
  ["pdf", "PDFs"],
  ["document", "Documents"],
  ["spreadsheet", "Spreadsheets"],
  ["folder", "Folders"],
  ["audio", "Audio"],
] as const;

export default function Search() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const search = useSearch(q, type);
  const active = q.length > 0 || type !== "";

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <View style={[styles.bar, { backgroundColor: c.surface2 }]}>
        <Pressable hitSlop={8} onPress={() => router.back()} accessibilityLabel="Back">
          <MaterialIcons name="arrow-back" size={24} color={c.text2} />
        </Pressable>
        <TextInput
          autoFocus
          value={text}
          onChangeText={setText}
          placeholder="Search in Drive"
          placeholderTextColor={c.text3}
          returnKeyType="search"
          style={[styles.input, { color: c.text }]}
        />
        {text ? (
          <Pressable hitSlop={8} onPress={() => setText("")} accessibilityLabel="Clear">
            <MaterialIcons name="close" size={22} color={c.text2} />
          </Pressable>
        ) : null}
      </View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
          {TYPES.map(([value, label]) => {
            const on = type === value;
            return (
              <Pressable
                key={value}
                onPress={() => setType(on ? "" : value)}
                style={[styles.chip, { borderColor: on ? c.selected : c.border, backgroundColor: on ? c.selected : "transparent" }]}
              >
                {on ? <MaterialIcons name="check" size={16} color={c.text} /> : null}
                <Text style={{ color: c.text, fontSize: 14 }}>{label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      {active ? (
        <FileList
          items={search.data}
          loading={search.isFetching && !search.data}
          error={search.error}
          onRefresh={() => search.refetch()}
          empty={{ icon: "search-off", title: "No results", body: "Try a different word or filter." }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 12, height: 52, borderRadius: 26, paddingHorizontal: 16, marginHorizontal: 16, marginTop: 8 },
  input: { flex: 1, fontSize: 16 },
  chips: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, height: 32, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12 },
});
