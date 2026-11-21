import React, { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getApiBaseUrl } from "@/lib/bff/config";
import { LoginView } from "@/features/auth/LoginView";

export const dynamic = "force-dynamic";

export default async function RootIndexPage() {
  const cookieStore = await cookies();
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
        <div className="flex h-dvh items-center justify-center bg-[var(--bg-app)] font-mono-code text-[13px] text-[var(--ink-muted)]">
          正在初始化登录视图…
        </div>
      }
    >
      <LoginView />
    </Suspense>
  );
}
