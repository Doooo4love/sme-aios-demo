import React, { Suspense } from "react";
import { cookies } from "next/headers";
import { translateKey } from "@/lib/i18n/dictionaries";
import { LOCALE_COOKIE_NAME, normalizeLocale } from "@/lib/i18n/types";
import { LoginView } from "@/features/auth/LoginView";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const cookieStore = await cookies();
  const locale = normalizeLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

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
