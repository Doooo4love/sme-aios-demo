import React, { Suspense } from "react";
import { OrderIntakeWorkspace } from "@/features/orders/OrderIntakeWorkspace";

export default function NewOrderIntakePage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 text-center font-mono-code text-[12.5px] text-[var(--ink-muted)]">
          正在加载订单进件工作台…
        </div>
      }
    >
      <OrderIntakeWorkspace />
    </Suspense>
  );
}
