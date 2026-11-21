import React, { Suspense } from "react";
import { cookies } from "next/headers";
import {
  LOCALE_COOKIE_NAME,
  normalizeLocale,
  translateInline,
} from "@/lib/i18n";
import { OrderIntakeWorkspace } from "@/features/orders/OrderIntakeWorkspace";

export default async function NewOrderIntakePage() {
  const cookieStore = await cookies();
  const locale = normalizeLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const loadingText = translateInline(locale, {
    "zh-CN": "正在加载订单进件工作台…",
    "zh-HK": "正在載入訂單進件工作台…",
    en: "Loading order intake workspace…",
  });

  return (
    <Suspense
      fallback={
        <div className="p-6 text-center text-[12.5px] text-[var(--ink-muted)]">
          {loadingText}
        </div>
      }
    >
      <OrderIntakeWorkspace />
    </Suspense>
  );
}
