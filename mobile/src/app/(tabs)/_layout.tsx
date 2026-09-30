import { MaterialIcons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import type { ColorValue } from "react-native";
import { DriveHeader } from "@/components/DriveHeader";
import { useColors } from "@/lib/theme";

function icon(name: keyof typeof MaterialIcons.glyphMap) {
  return function TabIcon({ color, size }: { color: ColorValue; size: number }) {
    return <MaterialIcons name={name} color={color} size={size} />;
  };
}

export default function TabsLayout() {
  const c = useColors();
  return (
    <Tabs
      screenOptions={{
        header: () => <DriveHeader />,
        sceneStyle: { backgroundColor: c.bg },
        tabBarStyle: { backgroundColor: c.surface2, borderTopWidth: 0 },
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.text2,
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: icon("home") }} />
      <Tabs.Screen name="starred" options={{ title: "Starred", tabBarIcon: icon("star-outline") }} />
      <Tabs.Screen name="shared" options={{ title: "Shared", tabBarIcon: icon("people-outline") }} />
      <Tabs.Screen name="files" options={{ title: "Files", tabBarIcon: icon("folder-open") }} />
    </Tabs>
  );
}
