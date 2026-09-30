import { useColorScheme } from "react-native";

/** Same palette as the web app (web/styles.css): one teal accent, greys tinted toward it. */
const light = {
  bg: "#f5f7f6",
  surface: "#ffffff",
  surface2: "#edf1ef",
  selected: "#cbe8e0",
  text: "#17221f",
  text2: "#43504c",
  text3: "#6f7c78",
  border: "#dde4e1",
  primary: "#0f766e",
  primarySoft: "#d2ece6",
  onPrimary: "#ffffff",
  logoInk: "#19615e",
  logoAccent: "#9bd9cc",
  danger: "#b42318",
  skeleton: "#e1e8e5",
};

const dark: typeof light = {
  bg: "#161a19",
  surface: "#101312",
  surface2: "#222826",
  selected: "#174c43",
  text: "#e2ebe8",
  text2: "#c0cbc7",
  text3: "#88948f",
  border: "#343c39",
  primary: "#7dd3c0",
  primarySoft: "#1b4a42",
  onPrimary: "#05302a",
  logoInk: "#7dd3c0",
  logoAccent: "#2c6f64",
  danger: "#f97066",
  skeleton: "#2c3330",
};

export type Colors = typeof light;

export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}
