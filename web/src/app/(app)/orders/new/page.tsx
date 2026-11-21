export default function NewOrderIntakePage() {
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /orders/new
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          订单进件与 OCR 证据核对
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
          支持图片 OCR 进件、结构化单笔录入与结构化批量导入。
        </p>
      </div>
    </div>
  );
}
