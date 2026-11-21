export default function AdminPeopleDirectoryPage() {
  return (
    <div className="p-6">
      <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
        <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          ROUTE · /admin/people
        </p>
        <h2 className="mt-1 text-[16px] font-semibold text-[var(--ink-primary)]">
          员工权限与模块授权目录
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
          按租户与仓库边界管理员工显式模块授权与有效期。
        </p>
      </div>
    </div>
  );
}
