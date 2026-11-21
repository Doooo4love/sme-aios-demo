import React, { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getApiBaseUrl } from "@/lib/bff/config";
import { translateKey } from "@/lib/i18n/dictionaries";
import { LOCALE_COOKIE_NAME, normalizeLocale } from "@/lib/i18n/types";
import { LoginView } from "@/features/auth/LoginView";

export const dynamic = "force-dynamic";

export default async function RootIndexPage() {
  const cookieStore = await cookies();
  const locale = normalizeLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const hasSessionCookie =
    cookieStore.has("aios_demo_session") ||
    cookieStore.has("__Host-aios_session");

  if (hasSessionCookie) {
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    if (cookieHeader) {
      let authenticated = false;
      try {
        const res = await fetch(`${getApiBaseUrl()}/v1/me`, {
          method: "GET",
          headers: {
            Cookie: cookieHeader,
            Accept: "application/json",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(1500),
        });
        authenticated = res.ok;
      } catch {
        authenticated = false;
      }

      if (authenticated) {
        redirect("/inbox");
      }
    }
  }

  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-[var(--bg-app)] text-[13px] text-[var(--ink-muted)]">
          {translateKey(locale, "login.initializing")}
        </div>
      }
    >
      <LoginView />
    </Suspense>
  );
}
