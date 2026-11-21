export default async function ChatRoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /inbox/{roomId}
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          员工协作房间
        </h2>
        <p className="mt-1 font-mono-code text-[12.5px] text-[var(--ink-muted)]">
          房间标识：{roomId}
        </p>
      </div>
    </div>
  );
}
