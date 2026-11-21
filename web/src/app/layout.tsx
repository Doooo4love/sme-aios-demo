import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { LocaleProvider } from "@/lib/i18n/context";
import { translateKey } from "@/lib/i18n/dictionaries";
import {
  LOCALE_COOKIE_NAME,
  LOCALE_META,
  normalizeLocale,
} from "@/lib/i18n/types";
import { SessionProvider } from "@/lib/session-context";
import { ThemeProvider, type Theme } from "@/lib/theme-context";
import { WorkbenchProvider } from "@/lib/workbench-context";
import "./globals.css";

const THEME_COOKIE_KEY = "aios_theme";

function normalizeServerTheme(raw: string | null | undefined): Theme {
  return raw?.trim().toLowerCase() === "dark" ? "dark" : "light";
}

export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F6F8" },
    { media: "(prefers-color-scheme: dark)", color: "#0C0E13" },
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const locale = normalizeLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  return {
    title: translateKey(locale, "brand.title"),
    description: translateKey(locale, "brand.description"),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const initialLocale = normalizeLocale(
    cookieStore.get(LOCALE_COOKIE_NAME)?.value,
  );
  const initialTheme = normalizeServerTheme(
    cookieStore.get(THEME_COOKIE_KEY)?.value,
  );

  return (
    <html
      lang={LOCALE_META[initialLocale].htmlLang}
      data-theme={initialTheme}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <ThemeProvider initialTheme={initialTheme}>
          <LocaleProvider initialLocale={initialLocale}>
            <SessionProvider>
              <WorkbenchProvider>{children}</WorkbenchProvider>
            </SessionProvider>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
