import React, { Suspense } from "react";
import { LoginView } from "@/features/auth/LoginView";

export default function LoginPage() {
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
