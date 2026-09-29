export type Theme = "system" | "light" | "dark";

/**
 * Apply a theme by setting data-theme on <html> (styles.css keys off it; "system" follows the OS).
 * The choice is also cached locally so the next page load paints in the right theme before
 * /api/me answers; the database copy on the user is the source of truth.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  // Swap instantly: without this, every element's colour transition would visibly fade between themes.
  root.classList.add("theme-switching");
  if (theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  try {
    localStorage.setItem("theme", theme);
  } catch {
    /* storage unavailable */
  }
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg || "#f5f7f6");
}
