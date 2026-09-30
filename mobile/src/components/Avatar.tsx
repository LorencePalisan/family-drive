import { Image } from "expo-image";
import { useState } from "react";
import { Text, View } from "react-native";

export function Avatar({ name, src, size = 32 }: { name: string; src?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return <Image source={{ uri: src }} onError={() => setBroken(true)} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  }
  const hue = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `hsl(${hue}, 45%, 45%)`, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#fff", fontSize: size * 0.45, fontWeight: "600" }}>{name.charAt(0).toUpperCase()}</Text>
    </View>
  );
}
