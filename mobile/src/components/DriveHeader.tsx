import { MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMe } from "@/lib/queries";
import { useColors } from "@/lib/theme";
import { Avatar } from "./Avatar";

/** Tab screens' header: a "Search in Drive" pill and the account avatar, like the Drive app. */
export function DriveHeader() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { data: me } = useMe();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8, backgroundColor: c.bg }]}>
      <Pressable onPress={() => router.push("/search")} style={[styles.pill, { backgroundColor: c.surface2 }]} android_ripple={{ color: c.selected }}>
        <MaterialIcons name="search" size={22} color={c.text2} />
        <Text style={[styles.placeholder, { color: c.text2 }]}>Search in Drive</Text>
        <Pressable hitSlop={8} onPress={() => router.push("/account")} accessibilityLabel="Account">
          {me ? <Avatar name={me.name} src={me.avatarUrl} size={32} /> : <MaterialIcons name="account-circle" size={32} color={c.text2} />}
        </Pressable>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingBottom: 8 },
  pill: { height: 52, borderRadius: 26, flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 10, gap: 12, overflow: "hidden" },
  placeholder: { flex: 1, fontSize: 16 },
});
