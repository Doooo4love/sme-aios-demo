"use client";

import React, { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { DropdownMenu } from "radix-ui";
import {
  Activity,
  ArrowLeft,
  Bot,
  Briefcase,
  Calendar,
  LogOut,
  MessageSquare,
  PanelRight,
  User,
  Users,
  X,
} from "lucide-react";
import { fetchTasks, isStaleAuthError } from "@/lib/api-client";
import { formatRoleLabel, getTenantMark } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { Avatar } from "@/components/ui/Avatar";
import { DemoPersonaSwitcher } from "@/components/shell/DemoPersonaSwitcher";
import { NoticesPopover } from "@/components/shell/NoticesPopover";
import { WorkbenchDrawerSlot } from "@/components/shell/WorkbenchDrawerSlot";

interface NavItem {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  badge?: number;
}

function resolvePageTitle(pathname: string): {
  title: string;
  mobileBackHref: string | null;
} {
  if (pathname === "/inbox/assistant") {
    return { title: "个人业务助手", mobileBackHref: "/inbox" };
  }
  if (pathname.startsWith("/inbox/")) {
    return { title: "协作房间", mobileBackHref: "/inbox" };
  }
  if (pathname === "/inbox") {
    return { title: "会话", mobileBackHref: null };
  }
  if (pathname === "/work") {
    return { title: "工作台", mobileBackHref: null };
  }
  if (pathname === "/orders/new") {
    return { title: "订单进件", mobileBackHref: "/work" };
  }
  if (pathname.startsWith("/proposals/")) {
    return { title: "提案单据详情", mobileBackHref: "/work" };
  }
  if (pathname === "/calendar") {
    return { title: "日程与会议", mobileBackHref: null };
  }
  if (pathname === "/admin") {
    return { title: "运维监控", mobileBackHref: null };
  }
  if (pathname === "/admin/exceptions") {
    return { title: "异常单据队列", mobileBackHref: "/admin" };
  }
  if (pathname === "/admin/people") {
    return { title: "员工权限与模块授权", mobileBackHref: null };
  }
  if (pathname.startsWith("/admin/people/")) {
    return { title: "员工模块授权编辑", mobileBackHref: "/admin/people" };
  }
  if (pathname === "/settings/profile") {
    return { title: "个人资料", mobileBackHref: "/inbox" };
  }
  if (pathname === "/settings/agent") {
    return { title: "个人 Agent 资料", mobileBackHref: "/inbox" };
  }
  return { title: "企业工作台", mobileBackHref: null };
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/inbox";
  const router = useRouter();
  const {
    status,
    actor,
    profile,
    agentProfile,
    avatarVersion,
    agentAvatarVersion,
    authGeneration,
    accessChangedBanner,
    canAccessAdminOps,
    canManagePeople,
    dismissAccessChangedBanner,
    logout,
  } = useSession();

  const {
    drawerOpen,
    assignedCount,
    toggleDrawer,
    setAssignedCount,
  } = useWorkbench();

  // Redirect unauthenticated users cleanly to /login with relative next target
  useEffect(() => {
    if (status === "unauthenticated") {
      const next = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
      router.replace(`/login${next}`);
    }
  }, [status, pathname, router]);

  // Seed assigned approval badge count once per authenticated session
  useEffect(() => {
    if (status !== "authenticated" || !actor) return;
    if (actor.role !== "manager" && actor.role !== "admin") {
      setAssignedCount(0);
      return;
    }
    let cancelled = false;
    fetchTasks("assigned", { limit: 50 })
      .then((res) => {
        if (!cancelled) setAssignedCount(res.items.length);
      })
      .catch((error) => {
        if (isStaleAuthError(error)) return;
      });
    return () => {
      cancelled = true;
    };
  }, [status, actor, authGeneration, setAssignedCount]);

  if (status === "loading" || status === "unauthenticated" || !actor) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-[var(--bg-canvas)] text-[13px] text-[var(--ink-muted)]">
        <span className="font-mono-code">
          {status === "loading" ? "正在核验企业会话…" : "正在跳转至登录页…"}
        </span>
      </div>
    );
  }

  const navItems: NavItem[] = [
    {
      href: "/inbox",
      label: "会话",
      match: (p) => p === "/inbox" || p.startsWith("/inbox/"),
      icon: MessageSquare,
    },
    {
      href: "/work",
      label: "工作台",
      match: (p) =>
        p === "/work" ||
        p.startsWith("/orders/") ||
        p.startsWith("/proposals/"),
      icon: Briefcase,
      badge: assignedCount > 0 ? assignedCount : undefined,
    },
    {
      href: "/calendar",
      label: "日历",
      match: (p) => p === "/calendar" || p.startsWith("/calendar/"),
      icon: Calendar,
    },
  ];

  if (canAccessAdminOps) {
    navItems.push({
      href: "/admin",
      label: "监控",
      match: (p) => p === "/admin" || p === "/admin/exceptions",
      icon: Activity,
    });
  }

  if (canManagePeople) {
    navItems.push({
      href: "/admin/people",
      label: "员工权限",
      match: (p) => p === "/admin/people" || p.startsWith("/admin/people/"),
      icon: Users,
    });
  }

  const { title: pageTitle, mobileBackHref } = resolvePageTitle(pathname);
  const tenantMark = getTenantMark(actor.tenant);
  const userAvatarSrc = profile?.has_avatar
    ? `/v1/profile/avatar?v=${avatarVersion}`
    : null;
  const agentAvatarSrc = agentProfile?.has_avatar
    ? `/v1/agent-profile/avatar?v=${agentAvatarVersion}`
    : null;
  const userDisplayName = profile?.display_name || actor.subject;
  const agentDisplayName = agentProfile?.display_name || "个人业务助手";

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-[var(--bg-canvas)] text-[var(--ink-primary)]">
      {/* Far-Left Desktop Utility Rail (60px, #ECEAE4, 1px hairline) */}
      <nav
        aria-label="主导航"
        className="hidden lg:flex w-[var(--rail-w)] shrink-0 flex-col items-center justify-between border-r border-[var(--hairline)] bg-[var(--bg-plane)] py-3"
      >
        <div className="flex flex-col items-center gap-3">
          {/* Tenant Monogram Mark */}
          <Link
            href="/inbox"
            title={`租户 ${actor.tenant} · 站点 ${actor.warehouses.join(", ") || "无"}`}
            className="flex h-9 w-9 items-center justify-center rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] font-mono-code text-[12px] font-semibold tracking-[0.04em] text-[var(--ink-primary)] hover:border-[var(--accent-border)]"
          >
            {tenantMark}
          </Link>

          <div className="h-px w-6 bg-[var(--hairline-strong)]" />

          {/* Capability-Gated Primary Destinations */}
          <div className="flex flex-col items-center gap-1.5">
            {navItems.map((item) => {
              const active = item.match(pathname);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.label}
                  aria-current={active ? "page" : undefined}
                  className={[
                    "relative flex h-10 w-10 flex-col items-center justify-center rounded-[4px] border transition-colors duration-[120ms]",
                    active
                      ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)]"
                      : "border-transparent text-[var(--ink-secondary)] hover:bg-[var(--bg-plane-hover)] hover:text-[var(--ink-primary)]",
                  ].join(" ")}
                >
                  <Icon className="h-[18px] w-[18px]" strokeWidth={1.65} />
                  <span className="mt-0.5 text-[9.5px] font-medium leading-none">
                    {item.label.slice(0, 2)}
                  </span>
                  {item.badge !== undefined && (
                    <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-[2px] bg-[var(--accent)] px-1 font-mono-code text-[9px] font-semibold text-white">
                      {item.badge > 99 ? "99+" : item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Bottom Utilities: Notices, Agent Profile, Personal Profile Menu */}
        <div className="flex flex-col items-center gap-2">
          <NoticesPopover side="right" align="end" />

          <Link
            href="/settings/agent"
            title={`Agent 资料：${agentDisplayName}`}
            aria-label={`Agent 资料：${agentDisplayName}`}
            className={[
              "rounded-[4px] p-0.5 border transition-colors duration-[120ms]",
              pathname === "/settings/agent"
                ? "border-[var(--accent)] bg-[var(--accent-wash)]"
                : "border-transparent hover:bg-[var(--bg-plane-hover)]",
            ].join(" ")}
          >
            <Avatar
              src={agentAvatarSrc}
              name={agentDisplayName}
              fallbackText="AG"
              size="sm"
              kind="agent"
            />
          </Link>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                title={`个人资料：${userDisplayName}`}
                aria-label="账号与资料菜单"
                className="rounded-[4px] p-0.5 border border-transparent hover:bg-[var(--bg-plane-hover)] cursor-pointer"
              >
                <Avatar
                  src={userAvatarSrc}
                  name={userDisplayName}
                  fallbackText={actor.subject}
                  size="sm"
                  kind="user"
                />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="right"
                align="end"
                sideOffset={8}
                className="z-50 w-[236px] rounded-[6px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] p-1.5 shadow-[var(--shadow-popover)]"
              >
                <div className="border-b border-[var(--hairline)] px-2.5 py-2">
                  <div className="truncate text-[13px] font-semibold text-[var(--ink-primary)]">
                    {userDisplayName}
                  </div>
                  <div className="mt-0.5 font-mono-code text-[11px] text-[var(--ink-muted)]">
                    {actor.subject} · {formatRoleLabel(actor.role)}
                  </div>
                  <div className="mt-0.5 font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                    {actor.tenant} · {actor.warehouses.join(", ") || "无站点"}
                  </div>
                </div>

                <DropdownMenu.Item asChild>
                  <Link
                    href="/settings/profile"
                    className="mt-1 flex items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-[12.5px] text-[var(--ink-primary)] outline-none hover:bg-[var(--bg-subtle)] focus:bg-[var(--bg-subtle)]"
                  >
                    <User className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    <span>个人资料</span>
                  </Link>
                </DropdownMenu.Item>

                <DropdownMenu.Item asChild>
                  <Link
                    href="/settings/agent"
                    className="flex items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-[12.5px] text-[var(--ink-primary)] outline-none hover:bg-[var(--bg-subtle)] focus:bg-[var(--bg-subtle)]"
                  >
                    <Bot className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    <span>个人 Agent 资料（{agentDisplayName}）</span>
                  </Link>
                </DropdownMenu.Item>

                <DropdownMenu.Separator className="my-1 h-px bg-[var(--hairline)]" />

                <DropdownMenu.Item
                  onSelect={() => void handleLogout()}
                  className="flex cursor-pointer items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-[12.5px] text-[var(--status-crimson)] outline-none hover:bg-[var(--status-crimson-wash)] focus:bg-[var(--status-crimson-wash)]"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>退出登录</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </nav>

      {/* Main Column: Top Utility Bar + Access Banner + Center Pane + Right Drawer */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Compact Top Context Header (48px) */}
        <header className="flex h-[var(--topbar-h)] shrink-0 items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-sheet)] px-3 lg:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {mobileBackHref && (
              <Link
                href={mobileBackHref}
                aria-label="返回上一级"
                className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] border border-[var(--hairline-strong)] text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)] lg:hidden"
              >
                <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
              </Link>
            )}
            <h1 className="truncate text-[14.5px] font-semibold text-[var(--ink-primary)]">
              {pageTitle}
            </h1>
            <span className="hidden sm:inline-block h-3.5 w-px bg-[var(--hairline-strong)]" />
            <span className="hidden sm:inline-flex items-center gap-1.5 font-mono-code text-[11.5px] text-[var(--ink-muted)]">
              <span>{actor.tenant}</span>
              <span>·</span>
              <span>{actor.warehouses.join(", ") || "NO-SITE"}</span>
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <DemoPersonaSwitcher />

            <div className="lg:hidden">
              <NoticesPopover side="bottom" align="end" />
            </div>

            <button
              type="button"
              onClick={(e) => toggleDrawer(e.currentTarget)}
              aria-expanded={drawerOpen}
              aria-label="切换右侧业务面板"
              className={[
                "inline-flex h-8 items-center gap-1.5 rounded-[4px] border px-2.5 text-[12px] font-medium transition-colors duration-[120ms] cursor-pointer",
                drawerOpen
                  ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)]"
                  : "border-[var(--hairline-strong)] bg-[var(--bg-sheet)] text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--ink-primary)]",
              ].join(" ")}
            >
              <PanelRight className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="hidden md:inline">业务面板</span>
              <kbd className="hidden xl:inline-block rounded-[2px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-1 font-mono-code text-[10px] text-[var(--ink-muted)]">
                ⌘.
              </kbd>
            </button>
          </div>
        </header>

        {/* Live ACCESS_CHANGED Notice Strip */}
        {accessChangedBanner && (
          <div
            role="status"
            className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-4 py-2 text-[12.5px] text-[var(--status-amber-ink)]"
          >
            <span>{accessChangedBanner}</span>
            <button
              type="button"
              onClick={dismissAccessChangedBanner}
              aria-label="关闭权限变更提示"
              className="inline-flex h-6 w-6 items-center justify-center rounded-[4px] hover:bg-[rgba(184,110,0,0.12)] cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Active Center Workspace + Collapsible Right Business Workbench Drawer */}
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <main className="min-w-0 flex-1 overflow-auto">{children}</main>
          <WorkbenchDrawerSlot />
        </div>

        {/* Mobile Bottom Navigation (< 1024px) */}
        <nav
          aria-label="移动端主导航"
          className="flex lg:hidden h-[54px] shrink-0 items-stretch justify-around border-t border-[var(--hairline)] bg-[var(--bg-sheet)] px-1"
        >
          {navItems.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "relative flex min-w-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium",
                  active
                    ? "text-[var(--accent)]"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.7} />
                <span>{item.label}</span>
                {item.badge !== undefined && (
                  <span className="absolute right-3 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-[2px] bg-[var(--accent)] px-1 font-mono-code text-[9px] font-semibold text-white">
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                )}
              </Link>
            );
          })}
          <Link
            href="/settings/profile"
            aria-current={pathname.startsWith("/settings/") ? "page" : undefined}
            className={[
              "flex min-w-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium",
              pathname.startsWith("/settings/")
                ? "text-[var(--accent)]"
                : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
            ].join(" ")}
          >
            <Avatar
              src={userAvatarSrc}
              name={userDisplayName}
              fallbackText={actor.subject}
              size="xs"
            />
            <span>我的</span>
          </Link>
        </nav>
      </div>
    </div>
  );
}
