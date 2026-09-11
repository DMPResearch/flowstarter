import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  getTheme as getSharedTheme,
  setTheme as setSharedTheme,
} from "@flowstarter/flow-design-system";

type Theme = "light" | "dark" | "system";
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
};

// `getSharedTheme`/`setSharedTheme` (aliased from the package's `getTheme`/
// `setTheme`, see packages/flow-design-system/src/utils/theme.ts) own the
// SAME cookie + localStorage key flowstarter-main writes: cookie
// `flowstarter_theme` (shared across subdomains, source of truth) with a
// `flowstarter_theme` localStorage fallback for before any app has written
// a cookie. Reusing the package's functions — rather than re-implementing
// cookie domain resolution here — means the editor can't drift from
// flowstarter-main's persistence rules; @flowstarter/flow-design-system is
// already a dependency of this app, so this adds no new package.
const STORAGE_KEY = "flowstarter_theme";
// Pre-migration key this hook used before the editor adopted the shared
// cookie. Read once on first load and migrated into the shared cookie /
// STORAGE_KEY below via `setSharedTheme`; never written to again.
const LEGACY_STORAGE_KEY = "flowstarter-editor:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let didMigrateLegacyStorage = false;

function emitChange() {
  for (const listener of listeners) listener();
}

function getSystemDark(): boolean {
  return window.matchMedia(MEDIA_QUERY).matches;
}

function isTheme(value: string | null | undefined): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

// The package's `getTheme()` reads `document.cookie` with no defensive
// guard. Real browsers always expose it as a string, but some minimal test
// environments (jsdom/happy-dom configs without a full cookie jar) expose
// `document.cookie` as `undefined`, which throws on `.split`. Swallow that
// here rather than letting a theme read crash a render.
function safeGetSharedTheme(): Theme {
  try {
    const theme = getSharedTheme();
    return isTheme(theme) ? theme : "system";
  } catch {
    return "system";
  }
}

function safeSetSharedTheme(theme: Theme): void {
  try {
    setSharedTheme(theme);
  } catch {
    // Best-effort persistence; DOM application below still happens.
  }
}

function hasSharedThemeCookie(): boolean {
  if (typeof document === "undefined" || typeof document.cookie !== "string") return false;
  return document.cookie
    .split(";")
    .some((entry) => entry.trim().startsWith("flowstarter_theme="));
}

// One-time migration from the editor's old, editor-only localStorage key to
// the shared cookie + localStorage key flowstarter-main uses. Runs at most
// once per session (guarded by `didMigrateLegacyStorage`) and only writes
// anything when neither the shared cookie nor the shared storage key already
// carry a value — so it never clobbers a preference set elsewhere.
function migrateLegacyStorage(): void {
  if (didMigrateLegacyStorage) return;
  didMigrateLegacyStorage = true;
  if (typeof localStorage === "undefined") return;
  if (hasSharedThemeCookie() || localStorage.getItem(STORAGE_KEY)) return;

  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!isTheme(legacy)) return;

  safeSetSharedTheme(legacy);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

function getStored(): Theme {
  migrateLegacyStorage();
  return safeGetSharedTheme();
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
}

// Editor-specific DOM application: `.dark` class toggle + transition
// suppression + chrome theme-color sync. Deliberately NOT the package's own
// `applyTheme` — that also sets a `data-theme` attribute, adds a `.light`
// class the editor never reads, and swaps `<link rel="icon">` to
// `/icon-dark.png` / `/icon-light.png`, which don't exist in this app's
// `public/` (the editor ships its own favicon set). Only the persistence
// layer above (`safeGetSharedTheme` / `safeSetSharedTheme`) is shared.
function applyTheme(theme: Theme, suppressTransitions = false) {
  if (typeof document === "undefined") return;
  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  const isDark = theme === "dark" || (theme === "system" && getSystemDark());
  document.documentElement.classList.toggle("dark", isDark);
  syncBrowserChromeTheme();
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

// Apply immediately on module load to prevent flash
applyTheme(getStored());

function getSnapshot(): ThemeSnapshot {
  const theme = getStored();
  const systemDark = theme === "system" ? getSystemDark() : false;

  if (lastSnapshot && lastSnapshot.theme === theme && lastSnapshot.systemDark === systemDark) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark };
  return lastSnapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  // Listen for system preference changes
  const mq = window.matchMedia(MEDIA_QUERY);
  const handleChange = () => {
    if (getStored() === "system") applyTheme("system", true);
    emitChange();
  };
  mq.addEventListener("change", handleChange);

  // Listen for storage changes from other tabs. Cookies don't emit a
  // cross-tab event, so a same-tab toggle in flowstarter-main only takes
  // effect here on the editor's next load — matching the "reload to pick
  // up the other app's preference" contract used product-wide.
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      applyTheme(getStored(), true);
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq.removeEventListener("change", handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const theme = snapshot.theme;

  const resolvedTheme: "light" | "dark" =
    theme === "system" ? (snapshot.systemDark ? "dark" : "light") : theme;

  const setTheme = useCallback((next: Theme) => {
    safeSetSharedTheme(next);
    applyTheme(next, true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, setTheme, resolvedTheme } as const;
}
