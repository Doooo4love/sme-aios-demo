"use client";

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { Command } from "cmdk";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckSquare,
  FilePlus2,
  HelpCircle,
  Inbox,
  Lock,
  Mail,
  Package,
  Receipt,
  Scale,
  Sparkles,
  Truck,
  Video,
} from "lucide-react";
import { fetchSlashSkills, isStaleAuthError } from "@/lib/api-client";
import { useLocale, type Locale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import type {
  Actor,
  Capabilities,
  SlashSkillCategory,
  SlashSkillItem,
} from "@/lib/types";

export interface SlashCommandPaletteHandle {
  /** Handles ArrowUp/ArrowDown/Enter/Tab/Escape when palette is open. Returns true if handled. */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export interface SlashCommandPaletteProps {
  composerText: string;
  open: boolean;
  onSelectSkill: (skill: SlashSkillItem) => void;
  onDismiss: () => void;
}

const CATEGORY_ORDER: readonly SlashSkillCategory[] = [
  "workflow",
  "communication",
  "governance",
  "navigation",
];

function getSkillIcon(command: string) {
  switch (command) {
    case "/brief":
      return Sparkles;
    case "/todo":
      return CheckSquare;
    case "/shipment":
      return Package;
    case "/reschedule":
      return Truck;
    case "/order":
      return FilePlus2;
    case "/invoice":
      return Receipt;
    case "/warehouse":
      return BarChart3;
    case "/approve":
      return CheckSquare;
    case "/email":
      return Mail;
    case "/inbox-mail":
      return Inbox;
    case "/meeting":
      return Video;
    case "/assurance":
      return Scale;
    case "/exceptions":
      return AlertTriangle;
    case "/help":
      return HelpCircle;
    default:
      return Activity;
  }
}

function hasAvailableTool(
  capabilities: Capabilities | null,
  toolId: string,
): boolean {
  if (!capabilities) return false;
  return capabilities.tools.some((t) => t.id === toolId && t.available);
}

/**
 * Built-in client fallback catalog when `/v1/workbench/skills` is unavailable.
 * Strictly respects live actor grants & capabilities (never elevates access).
 */
export function buildFallbackSlashSkills(
  actor: Actor | null,
  capabilities: Capabilities | null,
): SlashSkillItem[] {
  const isApprover = actor?.role === "manager" || actor?.role === "admin";
  const hasOps =
    (actor?.role === "manager" || actor?.role === "admin") &&
    Boolean(actor?.grants.includes("operations.manage"));
  const hasAssurance = Boolean(
    actor?.grants.some(
      (g) =>
        g === "assurance.purchase" ||
        g === "assurance.incoming" ||
        g === "assurance.contract",
    ),
  );
  const canApprovalWarehouse = Boolean(
    capabilities &&
      ((capabilities.approval_warehouses["sales_order.create_draft"]?.length ??
        0) > 0 ||
        (capabilities.approval_warehouses["shipment.reschedule"]?.length ?? 0) >
          0),
  );

  return [
    {
      command: "/brief",
      title: "今日工作简报",
      title_en: "Today's Operations Brief",
      description: "汇总待审批提案、退回单据与今日会议安排",
      description_en: "Summarize pending approvals, returned items & today's meetings",
      category: "workflow",
      usage: "/brief",
      requires_args: false,
      allowed: true,
      required_module: null,
      keywords: ["brief", "summary", "today", "简报", "簡報", "工作"],
    },
    {
      command: "/todo",
      title: "未完成事项清单",
      title_en: "Unfinished Work Queue",
      description: "列出当前待办审批、退回单据与未读通知",
      description_en: "List pending approvals, returned drafts & unread notices",
      category: "workflow",
      usage: "/todo",
      requires_args: false,
      allowed: true,
      required_module: null,
      keywords: ["todo", "tasks", "pending", "待办", "待辦", "未完成"],
    },
    {
      command: "/shipment",
      title: "查询运单状态",
      title_en: "Inspect Shipment",
      description: "按运单编号与仓库查询实时排期与版本",
      description_en: "Look up live shipment delivery date and version",
      category: "workflow",
      usage: "/shipment SHP-1001 HK01",
      requires_args: true,
      allowed: hasAvailableTool(capabilities, "shipment.read"),
      required_module: "dispatch",
      keywords: ["shipment", "shp", "track", "运单", "運單", "物流"],
    },
    {
      command: "/reschedule",
      title: "发起运单改期提案",
      title_en: "Propose Shipment Reschedule",
      description: "生成需主管审批的运单交付日变更提案",
      description_en: "Draft a governed shipment reschedule proposal",
      category: "workflow",
      usage: "/reschedule SHP-1001 HK01 2026-12-10",
      requires_args: true,
      allowed: hasAvailableTool(capabilities, "shipment.reschedule"),
      required_module: "dispatch",
      keywords: ["reschedule", "delivery", "改期", "排期", "交付"],
    },
    {
      command: "/order",
      title: "准备销售订单草稿",
      title_en: "Prepare Sales Order Draft",
      description: "根据进件编号生成待审批销售订单草稿提案",
      description_en: "Create an order draft proposal from an intake ID",
      category: "workflow",
      usage: "/order INT-100 HK01",
      requires_args: true,
      allowed: hasAvailableTool(capabilities, "order.draft.prepare"),
      required_module: "orders",
      keywords: ["order", "po", "intake", "订单", "訂單", "草稿"],
    },
    {
      command: "/invoice",
      title: "核对发票明细",
      title_en: "Check Invoice",
      description: "查询授权仓库的发票金额、币种与结算状态",
      description_en: "Inspect invoice amount, currency & payment state",
      category: "workflow",
      usage: "/invoice INV-100 HK01",
      requires_args: true,
      allowed: hasAvailableTool(capabilities, "finance.invoice.read"),
      required_module: "invoice-review",
      keywords: ["invoice", "finance", "inv", "发票", "發票", "财务"],
    },
    {
      command: "/warehouse",
      title: "仓库运营概览",
      title_en: "Warehouse Summary",
      description: "查看指定仓库当前在途未关闭运单汇总",
      description_en: "View open shipment counts for a warehouse",
      category: "workflow",
      usage: "/warehouse HK01",
      requires_args: true,
      allowed: hasAvailableTool(capabilities, "decision.warehouse.summary"),
      required_module: "warehouse-insights",
      keywords: ["warehouse", "summary", "insights", "仓库", "倉庫", "汇总"],
    },
    {
      command: "/approve",
      title: "审批快照预览",
      title_en: "Preview Approval Snapshot",
      description: "读取待审批提案的摘要锁定与差异明细",
      description_en: "Inspect digest lock & diff preview before formal approval",
      category: "workflow",
      usage: "/approve <proposal_id>",
      requires_args: true,
      allowed: isApprover && canApprovalWarehouse,
      required_module: "approvals",
      keywords: ["approve", "proposal", "review", "审批", "審批", "批准"],
    },
    {
      command: "/email",
      title: "起草并发送受控邮件",
      title_en: "Compose Governed Email",
      description: "解析收件人与主题，生成待确认邮件草稿卡片",
      description_en: "Draft a governed email with recipient resolution & review",
      category: "communication",
      usage: "/email manager: HK01 订单审批提醒",
      requires_args: true,
      allowed: true,
      required_module: null,
      keywords: ["email", "mail", "send", "smtp", "邮件", "電郵", "发信"],
    },
    {
      command: "/inbox-mail",
      title: "查看我的收件箱",
      title_en: "Check My Mail Inbox",
      description: "读取当前账号权限范围内的最近邮件摘要",
      description_en: "Read recent inbox message summaries",
      category: "communication",
      usage: "/inbox-mail",
      requires_args: false,
      allowed: hasAvailableTool(capabilities, "mail.inbox.read"),
      required_module: "mail-outbox",
      keywords: ["inbox", "mail", "messages", "收件箱", "邮件", "電郵"],
    },
    {
      command: "/meeting",
      title: "预约 Zoom / 日历会议",
      title_en: "Schedule Zoom / Calendar Meeting",
      description: "解析时间与参会同事，创建站内日历与 Zoom 会议",
      description_en: "Parse time & colleagues to draft a Zoom & calendar invite",
      category: "communication",
      usage: "/meeting 明天下午 3 点和 manager 用 Zoom 开会",
      requires_args: true,
      allowed: true,
      required_module: null,
      keywords: ["meeting", "zoom", "calendar", "会议", "會議", "日历"],
    },
    {
      command: "/assurance",
      title: "打开受控预审模块",
      title_en: "Open Assurance Reviews",
      description: "前往工作台查看采购、来料质量与合同预审",
      description_en: "Navigate to Assurance reviews in Workbench",
      category: "governance",
      usage: "/assurance",
      requires_args: false,
      allowed: hasAssurance,
      required_module: "assurance",
      keywords: ["assurance", "audit", "contract", "quality", "预审", "預審"],
    },
    {
      command: "/exceptions",
      title: "异常单据处置队列",
      title_en: "Exceptions Queue",
      description: "跳转至异常单据与回执核查控制台",
      description_en: "Open the Operations Exceptions & Reconcile queue",
      category: "governance",
      usage: "/exceptions",
      requires_args: false,
      allowed: hasOps,
      required_module: "operations",
      keywords: ["exceptions", "ops", "reconcile", "异常", "異常", "运维"],
    },
    {
      command: "/help",
      title: "助手指令与权限说明",
      title_en: "Commands & Access Help",
      description: "展示当前角色可用的快捷指令与协作能力",
      description_en: "Show available commands and capabilities for your role",
      category: "navigation",
      usage: "/help",
      requires_args: false,
      allowed: true,
      required_module: null,
      keywords: ["help", "commands", "skills", "帮助", "幫助", "指令"],
    },
  ];
}

function getCategoryLabel(
  category: SlashSkillCategory,
  locale: Locale,
): string {
  const map: Record<SlashSkillCategory, Record<Locale, string>> = {
    workflow: {
      "zh-CN": "业务执行",
      "zh-HK": "業務執行",
      en: "Workflow",
    },
    communication: {
      "zh-CN": "沟通与协同",
      "zh-HK": "溝通與協同",
      en: "Communication",
    },
    governance: {
      "zh-CN": "治理与风控",
      "zh-HK": "治理與風控",
      en: "Governance",
    },
    navigation: {
      "zh-CN": "导航与帮助",
      "zh-HK": "導覽與說明",
      en: "Navigation",
    },
  };
  return map[category][locale];
}

export const SlashCommandPalette = forwardRef<
  SlashCommandPaletteHandle,
  SlashCommandPaletteProps
>(function SlashCommandPalette(
  { composerText, open, onSelectSkill, onDismiss },
  ref,
) {
  const { status, actor, capabilities, authGeneration } = useSession();
  const { locale, tx } = useLocale();

  const [remoteSkills, setRemoteSkills] = useState<SlashSkillItem[] | null>(
    null,
  );
  const [lockedNotice, setLockedNotice] = useState<string | null>(null);
  const [selectedCommand, setSelectedCommand] = useState<string>("");

  useEffect(() => {
    setRemoteSkills(null);
    setLockedNotice(null);
    if (status !== "authenticated") return;

    const controller = new AbortController();
    fetchSlashSkills(controller.signal)
      .then((res) => {
        if (!controller.signal.aborted && Array.isArray(res.items) && res.items.length > 0) {
          setRemoteSkills(res.items);
        }
      })
      .catch((err) => {
        if (isStaleAuthError(err)) return;
        // Silently fall back to capability-derived catalog if endpoint unavailable
      });

    return () => {
      controller.abort();
    };
  }, [status, authGeneration, capabilities]);

  const allSkills = useMemo(() => {
    if (remoteSkills && remoteSkills.length > 0) return remoteSkills;
    return buildFallbackSlashSkills(actor, capabilities);
  }, [remoteSkills, actor, capabilities]);

  const query = useMemo(() => {
    if (!composerText.startsWith("/")) return "";
    return composerText.slice(1).trim().toLowerCase();
  }, [composerText]);

  const filteredSkills = useMemo(() => {
    if (!open) return [];
    if (!query) return allSkills;
    return allSkills.filter((skill) => {
      const haystacks = [
        skill.command.toLowerCase(),
        skill.command.slice(1).toLowerCase(),
        skill.title.toLowerCase(),
        skill.title_en.toLowerCase(),
        skill.description.toLowerCase(),
        skill.description_en.toLowerCase(),
        skill.usage.toLowerCase(),
        ...(skill.keywords ?? []).map((k) => k.toLowerCase()),
      ];
      return haystacks.some((h) => h.includes(query));
    });
  }, [allSkills, open, query]);

  const grouped = useMemo(() => {
    const groups: Array<{
      category: SlashSkillCategory;
      items: SlashSkillItem[];
    }> = [];
    for (const cat of CATEGORY_ORDER) {
      const items = filteredSkills.filter((s) => s.category === cat);
      if (items.length > 0) {
        groups.push({ category: cat, items });
      }
    }
    const extra = filteredSkills.filter(
      (s) => !CATEGORY_ORDER.includes(s.category),
    );
    if (extra.length > 0) {
      groups.push({ category: "navigation", items: extra });
    }
    return groups;
  }, [filteredSkills]);

  const flatSelectable = useMemo(
    () => grouped.flatMap((g) => g.items),
    [grouped],
  );

  // Keep active selection aligned with the first allowed (or first visible) skill
  useEffect(() => {
    if (!open) {
      setLockedNotice(null);
      return;
    }
    if (flatSelectable.length === 0) {
      setSelectedCommand("");
      return;
    }
    const stillValid = flatSelectable.some(
      (s) => s.command === selectedCommand,
    );
    if (!stillValid) {
      const firstAllowed =
        flatSelectable.find((s) => s.allowed) ?? flatSelectable[0];
      setSelectedCommand(firstAllowed?.command ?? "");
    }
  }, [open, flatSelectable, selectedCommand]);

  const triggerSkill = useCallback(
    (skill: SlashSkillItem) => {
      if (!skill.allowed) {
        setLockedNotice(
          tx(
            {
              "zh-CN": "当前账号尚未开通「{module}」模块权限，请联系访问权限管理员。",
              "zh-HK": "目前帳號尚未開通「{module}」模組權限，請聯絡存取權限管理員。",
              en: "Module “{module}” is not assigned to your role. Contact your Access Admin.",
            },
            { module: skill.required_module ?? skill.command },
          ),
        );
        return;
      }
      setLockedNotice(null);
      onSelectSkill(skill);
    },
    [onSelectSkill, tx],
  );

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
        if (!open) return false;

        if (e.key === "Escape") {
          e.preventDefault();
          onDismiss();
          return true;
        }

        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          if (flatSelectable.length === 0) return false;
          e.preventDefault();
          const currentIdx = flatSelectable.findIndex(
            (s) => s.command === selectedCommand,
          );
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const nextIdx =
            currentIdx === -1
              ? delta > 0
                ? 0
                : flatSelectable.length - 1
              : (currentIdx + delta + flatSelectable.length) %
                flatSelectable.length;
          const next = flatSelectable[nextIdx];
          if (next) {
            setSelectedCommand(next.command);
            setLockedNotice(null);
          }
          return true;
        }

        if (
          e.key === "Tab" ||
          (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)
        ) {
          if (flatSelectable.length === 0) {
            if (e.key === "Tab") {
              e.preventDefault();
              return true;
            }
            // Allow Enter to submit unknown slash input when palette has no matching command
            return false;
          }
          e.preventDefault();
          const active =
            flatSelectable.find((s) => s.command === selectedCommand) ??
            flatSelectable[0];
          if (active) {
            triggerSkill(active);
          }
          return true;
        }

        return false;
      },
    }),
    [open, flatSelectable, selectedCommand, onDismiss, triggerSkill],
  );

  if (!open) return null;

  return (
    <div
      data-testid="slash-command-palette"
      className="mb-2 overflow-hidden rounded-card border border-[var(--hairline-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-floating)]"
    >
      <Command
        label={tx({
          "zh-CN": "快捷指令技能",
          "zh-HK": "快捷指令技能",
          en: "Slash Commands",
        })}
        shouldFilter={false}
        loop
        value={selectedCommand}
        onValueChange={(val) => {
          setSelectedCommand(val);
          setLockedNotice(null);
        }}
        className="flex flex-col"
      >
        <div className="flex items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles
              className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
              strokeWidth={1.9}
            />
            <span className="aios-micro-label truncate">
              {tx({
                "zh-CN": "快捷指令与业务技能",
                "zh-HK": "快捷指令與業務技能",
                en: "Agent Skills & Slash Commands",
              })}
            </span>
          </div>
          <div className="hidden sm:flex shrink-0 items-center gap-2 text-[11px] text-[var(--ink-muted)]">
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10px]">
                ↑↓
              </kbd>
              <span>{tx({ "zh-CN": "选择", "zh-HK": "選擇", en: "Navigate" })}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10px]">
                Enter / Tab
              </kbd>
              <span>{tx({ "zh-CN": "插入或执行", "zh-HK": "插入或執行", en: "Run / Insert" })}</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10px]">
                Esc
              </kbd>
              <span>{tx({ "zh-CN": "关闭", "zh-HK": "關閉", en: "Dismiss" })}</span>
            </span>
          </div>
        </div>

        {lockedNotice && (
          <div
            role="status"
            className="flex items-center gap-2 border-b border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-3.5 py-2 text-[12px] text-[var(--status-amber-ink)]"
          >
            <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
            <span className="min-w-0 break-words">{lockedNotice}</span>
          </div>
        )}

        <Command.List className="max-h-[280px] overflow-y-auto p-1.5 space-y-1.5">
          {flatSelectable.length === 0 ? (
            <Command.Empty className="px-4 py-6 text-center text-[12.5px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "未匹配到快捷技能，直接按 Enter 可作为普通对话发送给助手。",
                "zh-HK": "未符合快捷技能，直接按 Enter 可作為一般對話傳送給助手。",
                en: "No matching command. Press Enter to send directly to your Agent.",
              })}
            </Command.Empty>
          ) : (
            grouped.map((group) => (
              <Command.Group
                key={group.category}
                heading={getCategoryLabel(group.category, locale)}
                className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.04em] [&_[cmdk-group-heading]]:text-[var(--ink-muted)]"
              >
                {group.items.map((skill) => {
                  const Icon = getSkillIcon(skill.command);
                  const isSelected = selectedCommand === skill.command;
                  const titleText =
                    locale === "en" ? skill.title_en : skill.title;
                  const descText =
                    locale === "en" ? skill.description_en : skill.description;

                  return (
                    <Command.Item
                      key={skill.command}
                      value={skill.command}
                      data-testid={`slash-skill-${skill.command.slice(1)}`}
                      onSelect={() => triggerSkill(skill)}
                      onMouseEnter={() => setSelectedCommand(skill.command)}
                      className={[
                        "flex items-center justify-between gap-3 rounded-sm px-2.5 py-2 text-left transition-colors duration-[120ms] cursor-pointer select-none",
                        isSelected
                          ? "bg-[var(--accent-wash)] text-[var(--ink-primary)] ring-1 ring-inset ring-[var(--accent-border)]"
                          : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]",
                        !skill.allowed ? "opacity-70" : "",
                      ].join(" ")}
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-2.5">
                        <span
                          className={[
                            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border",
                            skill.allowed
                              ? isSelected
                                ? "border-[var(--accent-border)] bg-[var(--bg-surface)] text-[var(--accent-ink)]"
                                : "border-[var(--hairline)] bg-[var(--bg-surface-subtle)] text-[var(--accent)]"
                              : "border-[var(--hairline)] bg-[var(--bg-surface-subtle)] text-[var(--ink-muted)]",
                          ].join(" ")}
                        >
                          {skill.allowed ? (
                            <Icon className="h-3.5 w-3.5" strokeWidth={1.85} />
                          ) : (
                            <Lock className="h-3.5 w-3.5" strokeWidth={1.85} />
                          )}
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono-code text-[12.5px] font-semibold text-[var(--accent-ink)]">
                              {skill.command}
                            </span>
                            <span className="text-[12.5px] font-medium text-[var(--ink-primary)]">
                              {titleText}
                            </span>
                            {!skill.allowed && (
                              <span
                                data-testid={`slash-skill-locked-${skill.command.slice(1)}`}
                                className="inline-flex items-center gap-1 rounded-xs border border-[var(--hairline)] bg-[var(--status-neutral-wash)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--status-neutral)]"
                              >
                                <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                                <span>
                                  {skill.required_module
                                    ? tx(
                                        {
                                          "zh-CN": "需 {mod} 权限",
                                          "zh-HK": "須 {mod} 權限",
                                          en: "Requires {mod}",
                                        },
                                        { mod: skill.required_module },
                                      )
                                    : tx({
                                        "zh-CN": "未授权",
                                        "zh-HK": "未授權",
                                        en: "Locked",
                                      })}
                                </span>
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 truncate text-[11.5px] text-[var(--ink-muted)]">
                            {descText}
                          </p>
                        </div>
                      </div>

                      <div className="hidden md:flex shrink-0 items-center gap-1.5">
                        <code className="max-w-[190px] truncate rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]">
                          {skill.usage}
                        </code>
                      </div>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            ))
          )}
        </Command.List>
      </Command>
    </div>
  );
});
