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
  CalendarDays,
  LogOut,
  PanelRight,
  User,
  Users,
  X,
} from "lucide-react";
import { fetchTasks, isStaleAuthError } from "@/lib/api-client";
import { sortWarehouses } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { Avatar } from "@/components/ui/Avatar";
import {
  LanguageSwitcher,
  PreferencesBar,
  ThemeToggle,
} from "@/components/ui/PreferencesControls";
import { TheodicLogo, TheodicMark } from "@/components/ui/TheodicBrand";
import { DemoPersonaSwitcher } from "@/components/shell/DemoPersonaSwitcher";
import { NoticesPopover } from "@/components/shell/NoticesPopover";
import { WorkbenchDrawerSlot } from "@/components/shell/WorkbenchDrawerSlot";

interface WorkbenchNavTier {
  href: string;
  label: string;
  shortLabel: string;
  match: (pathname: string) => boolean;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  badge?: number;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/inbox";
  const router = useRouter();
  const { t, localizeRole, localizePersona } = useLocale();
  const {
    status,
    actor,
    profile,
    agentProfile,
    avatarVersion,
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
      const next =
        pathname && pathname !== "/"
          ? `?next=${encodeURIComponent(pathname)}`
          : "";
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
      <div className="flex h-dvh w-full items-center justify-center bg-[var(--bg-app)] text-[13px] text-[var(--ink-muted)]">
        <span>
          {status === "loading"
            ? t("shell.verifyingSession")
            : t("shell.redirectingLogin")}
        </span>
      </div>
    );
  }

  const isMessengerRoute =
    pathname === "/inbox" || pathname.startsWith("/inbox/");

  // 4 Capability-Gated Role Tiers for Workbench & Management top bar
  const workbenchTiers: WorkbenchNavTier[] = [
    {
      href: "/work",
      label: t("shell.nav.work"),
      shortLabel: t("shell.nav.workShort"),
      match: (p) =>
        p === "/work" ||
        p.startsWith("/orders/") ||
        p.startsWith("/proposals/"),
      icon: Briefcase,
      badge: assignedCount > 0 ? assignedCount : undefined,
    },
    {
      href: "/calendar",
      label: t("shell.nav.calendar"),
      shortLabel: t("shell.nav.calendarShort"),
      match: (p) => p === "/calendar" || p.startsWith("/calendar/"),
      icon: CalendarDays,
    },
  ];

  if (canManagePeople) {
    workbenchTiers.push({
      href: "/admin/people",
      label: t("shell.nav.people"),
      shortLabel: t("shell.nav.peopleShort"),
      match: (p) => p === "/admin/people" || p.startsWith("/admin/people/"),
      icon: Users,
    });
  }

  if (canAccessAdminOps) {
    workbenchTiers.push({
      href: "/admin",
      label: t("shell.nav.admin"),
      shortLabel: t("shell.nav.adminShort"),
      match: (p) => p === "/admin" || p === "/admin/exceptions",
      icon: Activity,
    });
  }

  const userAvatarSrc = profile?.has_avatar
    ? `/v1/profile/avatar?v=${avatarVersion}`
    : null;
  const localizedActorPersona = localizePersona(actor.subject);
  const userDisplayName =
    profile?.display_name?.trim() ||
    localizedActorPersona.displayName ||
    actor.subject;
  const sortedWarehouses = sortWarehouses(actor.warehouses);
  const agentDisplayName =
    agentProfile?.display_name || t("brand.defaultAgentName");

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  // 1. Messenger Routes (/inbox, /inbox/assistant, /inbox/[roomId])
  if (isMessengerRoute) {
    return (
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-[var(--bg-app)] text-[var(--ink-primary)]">
        {accessChangedBanner && (
          <div
            role="status"
            className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-4 py-2 text-[12.5px] text-[var(--status-amber-ink)]"
          >
            <span>{t("shell.accessChangedBanner")}</span>
            <button
              type="button"
              onClick={dismissAccessChangedBanner}
              aria-label={t("shell.closeAccessBannerAria")}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-[var(--status-amber-border)] cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
          <WorkbenchDrawerSlot />
        </div>
      </div>
    );
  }

  // 2. Workbench & Management Routes — Calm Frosted Porcelain / Obsidian top bar
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[var(--bg-app)] text-[var(--ink-primary)]">
      <header className="aios-topbar-glass sticky top-0 z-30 flex h-[var(--topbar-h)] shrink-0 items-center justify-between gap-2 border-b border-[var(--hairline)] px-4 lg:grid lg:grid-cols-[auto_1fr_auto] xl:grid-cols-[1fr_auto_1fr] lg:items-center lg:px-5 xl:px-6">
        {/* Control 1 (Left): Theodic Brand Anchor + Back to Messenger Pill */}
        <div className="flex min-w-0 items-center gap-2.5 lg:justify-self-start">
          <Link
            href="/inbox/assistant"
            aria-label={t("brand.name")}
            data-testid="shell-brand-link"
            className="hidden sm:inline-flex shrink-0 items-center rounded-sm py-1 opacity-95 hover:opacity-100 transition-opacity duration-[150ms]"
          >
            <TheodicLogo height={18} className="hidden xl:inline-flex" />
            <TheodicMark height={16} className="inline-flex xl:hidden" />
          </Link>
          <span
            aria-hidden="true"
            className="hidden sm:block h-4 w-px shrink-0 bg-[var(--hairline-strong)]"
          />
          <Link
            href="/inbox/assistant"
            data-testid="shell-back-to-inbox"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[var(--bg-surface)] px-2.5 xl:px-3 text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] hover:text-[var(--accent-ink)] transition-all duration-[150ms]"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
            <span className="whitespace-nowrap">{t("shell.backToInbox")}</span>
          </Link>
        </div>

        {/* Control 2 (Center): Capability-Gated Segmented Navigation */}
        <nav
          aria-label={t("shell.mainNavAria")}
          className="hidden lg:flex lg:justify-self-center items-center gap-1 rounded-full bg-[var(--bg-inset)] p-1 ring-1 ring-[var(--hairline)]"
        >
          {workbenchTiers.map((tier) => {
            const active = tier.match(pathname);
            const Icon = tier.icon;
            return (
              <Link
                key={tier.href}
                href={tier.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] xl:px-3.5 xl:text-[13px] font-medium transition-all duration-[150ms]",
                  active
                    ? "bg-[var(--bg-surface)] text-[var(--accent-ink)] shadow-[var(--shadow-subtle)] font-semibold"
                    : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.85} />
                <span className="whitespace-nowrap">{tier.label}</span>
                {tier.badge !== undefined && (
                  <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--accent-solid)] px-1.5 tabular-nums text-[10px] font-semibold text-[var(--accent-fg)]">
                    {tier.badge > 99 ? "99+" : tier.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Right Utility Group: Language/Theme Preferences, Demo Switcher, Notices, Drawer Toggle, Avatar Menu */}
        <div className="flex items-center gap-1.5 shrink-0 lg:justify-self-end">
          <div className="hidden sm:inline-flex">
            <PreferencesBar variant="inline" />
          </div>

          <DemoPersonaSwitcher side="bottom" align="end" />

          <NoticesPopover side="bottom" align="end" />

          <button
            type="button"
            onClick={(e) => toggleDrawer(e.currentTarget)}
            aria-expanded={drawerOpen}
            aria-label={t("shell.toggleDrawerAria")}
            title={t("shell.toggleDrawerTitle")}
            className={[
              "inline-flex h-8 w-8 items-center justify-center rounded-full transition-all duration-[150ms] cursor-pointer",
              drawerOpen
                ? "bg-[var(--accent-wash)] text-[var(--accent-ink)] ring-1 ring-[var(--accent-border)]"
                : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)]",
            ].join(" ")}
          >
            <PanelRight className="h-[17px] w-[17px]" strokeWidth={1.75} />
          </button>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                title={`${userDisplayName} · ${actor.tenant} (${sortedWarehouses.join("/") || t("shell.noWarehouse")})`}
                aria-label={t("shell.accountMenuAria")}
                className="inline-flex items-center rounded-full p-0.5 hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
              >
                <Avatar
                  src={userAvatarSrc}
                  name={userDisplayName}
                  fallbackText={actor.subject}
                  size="sm"
                  kind="user"
                  status="online"
                />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="bottom"
                align="end"
                sideOffset={8}
                className="z-50 w-[256px] rounded-card border border-[var(--hairline-strong)] bg-[var(--bg-surface)] p-1.5 shadow-[var(--shadow-popover)] focus:outline-none"
              >
                <div className="border-b border-[var(--hairline)] px-3 py-2.5">
                  <div className="truncate text-[13.5px] font-semibold text-[var(--ink-primary)]">
                    {userDisplayName}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--ink-muted)]">
                    <span className="font-mono-code">{actor.subject}</span>
                    <span aria-hidden="true">·</span>
                    <span>{localizeRole(actor.role)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[var(--ink-muted)]">
                    <span className="font-mono-code">{actor.tenant}</span>
                    <span aria-hidden="true">·</span>
                    {sortedWarehouses.length > 0 ? (
                      <span className="font-mono-code">
                        {sortedWarehouses.join(", ")}
                      </span>
                    ) : (
                      <span>{t("shell.noWarehouse")}</span>
                    )}
                  </div>
                </div>

                {/* Compact Mobile-Only Preferences Row (< 640px) */}
                <div className="flex sm:hidden items-center justify-between gap-2 border-b border-[var(--hairline)] px-2.5 py-2">
                  <LanguageSwitcher variant="segmented" size="sm" />
                  <ThemeToggle size="sm" />
                </div>

                <DropdownMenu.Item asChild>
                  <Link
                    href="/settings/profile"
                    className="mt-1 flex items-center gap-2.5 rounded-sm px-3 py-2 text-[12.5px] text-[var(--ink-primary)] outline-none hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)]"
                  >
                    <User className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    <span>{t("shell.menu.profile")}</span>
                  </Link>
                </DropdownMenu.Item>

                <DropdownMenu.Item asChild>
                  <Link
                    href="/settings/agent"
                    className="flex items-center gap-2.5 rounded-sm px-3 py-2 text-[12.5px] text-[var(--ink-primary)] outline-none hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)]"
                  >
                    <Bot className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    <span className="truncate">
                      {t("shell.menu.agentProfile", { name: agentDisplayName })}
                    </span>
                  </Link>
                </DropdownMenu.Item>

                <DropdownMenu.Separator className="my-1 h-px bg-[var(--hairline)]" />

                <DropdownMenu.Item
                  onSelect={() => void handleLogout()}
                  className="flex cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2 text-[12.5px] text-[var(--status-crimson)] outline-none hover:bg-[var(--status-crimson-wash)] focus:bg-[var(--status-crimson-wash)]"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>{t("shell.menu.logout")}</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      {/* Live ACCESS_CHANGED Notice Strip */}
      {accessChangedBanner && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-5 py-2 text-[12.5px] text-[var(--status-amber-ink)]"
        >
          <span>{t("shell.accessChangedBanner")}</span>
          <button
            type="button"
            onClick={dismissAccessChangedBanner}
            aria-label={t("shell.closeAccessBannerAria")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-[var(--status-amber-border)] cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Main Content + Right Slide-Over Inspector Drawer */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
        <WorkbenchDrawerSlot />
      </div>

      {/* Mobile Workbench Bottom Navigation (< 1024px) */}
      <nav
        aria-label={t("shell.mobileNavAria")}
        className="aios-topbar-glass flex lg:hidden h-[56px] shrink-0 items-stretch justify-around border-t border-[var(--hairline)] px-2"
      >
        {workbenchTiers.map((tier) => {
          const active = tier.match(pathname);
          const Icon = tier.icon;
          return (
            <Link
              key={tier.href}
              href={tier.href}
              aria-current={active ? "page" : undefined}
              className={[
                "relative flex min-w-[60px] flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium",
                active
                  ? "text-[var(--accent-ink)]"
                  : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
              ].join(" ")}
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
              <span>{tier.shortLabel}</span>
              {tier.badge !== undefined && (
                <span className="absolute right-3 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent-solid)] px-1 tabular-nums text-[9px] font-semibold text-[var(--accent-fg)]">
                  {tier.badge > 99 ? "99+" : tier.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
