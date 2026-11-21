export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /proposals/{id}
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          提案单据详情
        </h2>
        <p className="mt-1 font-mono-code text-[12.5px] text-[var(--ink-muted)]">
          单据编号：{id}
        </p>
      </div>
    </div>
  );
}
