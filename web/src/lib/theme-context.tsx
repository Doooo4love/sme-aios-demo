"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readCookieValue, writePreferenceCookie } from "@/lib/i18n/types";

export type Theme = "light" | "dark";

export const DEFAULT_THEME: Theme = "light";
export const THEME_COOKIE_NAME = "aios_theme";

const THEME_META_COLOR: Record<Theme, string> = {
  light: "#F5F6F8",
  dark: "#0C0E13",
};

export function normalizeTheme(raw: string | null | undefined): Theme {
  if (!raw) return DEFAULT_THEME;
  return raw.trim().toLowerCase() === "dark" ? "dark" : "light";
}

function syncThemeColorMeta(theme: Theme): void {
  if (typeof document === "undefined") return;
  const color = THEME_META_COLOR[theme];
  let meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"][data-aios-theme-meta="true"]',
  );
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.dataset.aiosThemeMeta = "true";
    document.head.appendChild(meta);
  }
  if (meta.content !== color) {
    meta.content = color;
  }
}

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  initialTheme = DEFAULT_THEME,
  children,
}: {
  initialTheme?: Theme;
  children: React.ReactNode;
}) {
  const [theme, setThemeState] = useState<Theme>(() =>
    normalizeTheme(initialTheme),
  );
  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;
  const transitionTimerRef = useRef<number | null>(null);

  // Sync with cookie if already persisted on client without clobbering SSR attribute
  useEffect(() => {
    const fromCookie = readCookieValue(THEME_COOKIE_NAME);
    if (fromCookie) {
      const normalized = normalizeTheme(fromCookie);
      setThemeState((prev) => (prev === normalized ? prev : normalized));
    }
  }, []);

  // Ensure documentElement.dataset.theme and mobile status-bar theme-color stay synced
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
    syncThemeColorMeta(theme);
  }, [theme]);

  useEffect(() => {
    return () => {
      if (transitionTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(transitionTimerRef.current);
      }
    };
  }, []);

  const applyTheme = useCallback((next: Theme) => {
    const normalized = normalizeTheme(next);
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      const prefersReduced =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!prefersReduced) {
        root.dataset.themeSwitching = "true";
        if (transitionTimerRef.current !== null) {
          window.clearTimeout(transitionTimerRef.current);
        }
        transitionTimerRef.current = window.setTimeout(() => {
          delete root.dataset.themeSwitching;
          transitionTimerRef.current = null;
        }, 220);
      }

      root.dataset.theme = normalized;
      syncThemeColorMeta(normalized);
    }
    writePreferenceCookie(THEME_COOKIE_NAME, normalized);
    themeRef.current = normalized;
    setThemeState(normalized);
  }, []);

  // Pure event handler — zero side effects inside React setState updater (StrictMode safe)
  const toggleTheme = useCallback(() => {
    const next: Theme = themeRef.current === "dark" ? "light" : "dark";
    applyTheme(next);
  }, [applyTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: applyTheme,
      toggleTheme,
    }),
    [theme, applyTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
