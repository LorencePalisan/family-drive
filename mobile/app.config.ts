import type { ExpoConfig } from "expo/config";

/**
 * Android-first for now. iOS needs its own OAuth client: set IOS_GOOGLE_URL_SCHEME (the reversed iOS client ID)
 * to enable the Google sign-in config plugin for iOS builds.
 */
const iosGoogleUrlScheme = process.env.IOS_GOOGLE_URL_SCHEME;

const config: ExpoConfig = {
  name: "Family Drive",
  slug: "family-drive",
  scheme: "familydrive",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  experiments: { typedRoutes: true },
  extra: { eas: { projectId: "4211fada-b883-46a0-89a6-3ca54e4613d0" } },
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.lorencepalisan.familydrive",
  },
  android: {
    package: "com.lorencepalisan.familydrive",
    adaptiveIcon: {
      backgroundColor: "#FFFFFF",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
    permissions: [
      // Without this Android strips GPS EXIF from photos handed to the app (silent data loss for backups).
      "android.permission.ACCESS_MEDIA_LOCATION",
    ],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-image",
    "expo-video",
    "expo-sharing",
    [
      "expo-image-picker",
      {
        photosPermission: "Family Drive uploads the photos and videos you choose to your family's drive.",
        cameraPermission: "Family Drive lets you take a photo and upload it straight to the drive.",
        microphonePermission: false,
      },
    ],
    ...(iosGoogleUrlScheme ? [["react-native-nitro-google-signin", { iosUrlScheme: iosGoogleUrlScheme }] as [string, unknown]] : []),
  ],
};

export default config;
