"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Calendar, ClipboardCheck, Inbox, X } from "lucide-react";
import {
  fetchBrief,
  fetchProposal,
  fetchTasks,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import {
  formatProposalAction,
  formatShortDigest,
  formatUnixTime,
} from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { ExecutionTopologyRibbon } from "@/components/kinetic/ExecutionTopologyRibbon";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { BriefResponse, DrawerTab, Proposal, TaskItem } from "@/lib/types";

const DRAWER_TABS: ReadonlyArray<{ id: DrawerTab; label: string }> = [
  { id: "current", label: "当前对象" },
  { id: "assigned", label: "待我处理" },
  { id: "submitted", label: "已提交" },
];

export function WorkbenchDrawerSlot() {
  const { status, authGeneration, handleAccessChanged } = useSession();
  const {
    drawerOpen,
    activeTab,
    selectedObject,
    customDrawerContent,
    closeDrawer,
    setActiveTab,
    openDrawer,
    setAssignedCount,
  } = useWorkbench();

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<ApiError | null>(null);

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalError, setProposalError] = useState<ApiError | null>(null);

  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<ApiError | null>(null);

  // Move keyboard focus cleanly into the drawer header when opened
  useEffect(() => {
    if (drawerOpen) {
      requestAnimationFrame(() => {
        headingRef.current?.focus({ preventScroll: true });
      });
    }
  }, [drawerOpen]);

  // Reset local drawer inspection state on authGeneration change
  useEffect(() => {
    setTasks([]);
    setTasksError(null);
    setProposal(null);
    setProposalError(null);
    setBrief(null);
    setBriefError(null);
  }, [authGeneration]);

  const loadLaneTasks = useCallback(
    async (lane: "assigned" | "submitted") => {
      if (status !== "authenticated") return;
      setTasksLoading(true);
      setTasksError(null);
      try {
        const res = await fetchTasks(lane, { limit: 25 });
        setTasks(res.items);
        if (lane === "assigned") {
          setAssignedCount(res.items.length);
        }
      } catch (error) {
        if (isStaleAuthError(error)) return;
        if (isApiError(error)) {
          if (error.code === "ACCESS_CHANGED") {
            void handleAccessChanged();
          }
          setTasksError(error);
        }
      } finally {
        setTasksLoading(false);
      }
    },
    [status, setAssignedCount, handleAccessChanged],
  );

  // Load lane data when drawer opens on assigned / submitted tab
  useEffect(() => {
    if (!drawerOpen || status !== "authenticated") return;
    if (activeTab === "assigned" || activeTab === "submitted") {
      void loadLaneTasks(activeTab);
    }
  }, [drawerOpen, activeTab, status, loadLaneTasks]);

  // Built-in default inspection loader when no page customDrawerContent overrides it
  useEffect(() => {
    if (
      !drawerOpen ||
      activeTab !== "current" ||
      customDrawerContent ||
      !selectedObject ||
      status !== "authenticated"
    ) {
      return;
    }

    if (selectedObject.kind === "proposal") {
      setProposalLoading(true);
      setProposalError(null);
      fetchProposal(selectedObject.id)
        .then((data) => setProposal(data))
        .catch((error) => {
          if (isStaleAuthError(error)) return;
          if (isApiError(error)) {
            if (error.code === "ACCESS_CHANGED") {
              setProposal(null);
              void handleAccessChanged();
            }
            setProposalError(error);
          }
        })
        .finally(() => setProposalLoading(false));
      return;
    }

    if (selectedObject.kind === "brief") {
      setBriefLoading(true);
      setBriefError(null);
      const now = new Date();
      const start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
      );
      const end = new Date(start.getTime() + 7 * 86_400_000);
      fetchBrief(start.toISOString(), end.toISOString())
        .then((data) => setBrief(data))
        .catch((error) => {
          if (isStaleAuthError(error)) return;
          if (isApiError(error)) setBriefError(error);
        })
        .finally(() => setBriefLoading(false));
    }
  }, [
    drawerOpen,
    activeTab,
    customDrawerContent,
    selectedObject,
    status,
    handleAccessChanged,
  ]);

  return (
    <>
      {/* Medium-viewport overlay scrim (768px - 1179px) */}
      {drawerOpen && (
        <div
          aria-hidden="true"
          onClick={() => closeDrawer({ restoreFocus: true })}
          className="fixed inset-0 z-30 bg-[var(--scrim)] xl:hidden"
        />
      )}

      <aside
        aria-label="业务核对面板"
        aria-hidden={!drawerOpen}
        className={[
          "aios-drawer-transition flex flex-col bg-[var(--bg-sheet)] border-l border-[var(--hairline)] overflow-hidden",
          // Docked on wide desktop (>= 1280px / xl), slide-over overlay below xl
          "fixed bottom-0 right-0 top-[var(--topbar-h)] z-40 xl:static xl:z-auto xl:top-auto xl:bottom-auto xl:h-full",
          drawerOpen
            ? "w-[min(420px,92vw)] xl:w-[var(--drawer-w)] translate-x-0 opacity-100 shadow-[var(--shadow-popover)] xl:shadow-none"
            : "w-0 translate-x-full xl:translate-x-0 opacity-0 pointer-events-none border-l-0",
        ].join(" ")}
      >
        {/* Drawer Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--hairline)] px-4">
          <div className="min-w-0 flex items-center gap-2">
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="truncate text-[14.5px] font-semibold text-[var(--ink-primary)] focus:outline-none"
            >
              {selectedObject?.title && activeTab === "current"
                ? selectedObject.title
                : "业务工作面板"}
            </h2>
            {selectedObject?.warehouse && activeTab === "current" && (
              <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]">
                {selectedObject.warehouse}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <kbd className="hidden sm:inline-block rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--ink-muted)]">
              ESC
            </kbd>
            <button
              type="button"
              onClick={() => closeDrawer({ restoreFocus: true })}
              aria-label="收起业务面板"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[var(--ink-muted)] hover:bg-[var(--bg-plane)] hover:text-[var(--ink-primary)] cursor-pointer"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* Hairline Segmented Tabs */}
        <div
          role="tablist"
          aria-label="业务面板视图"
          className="flex shrink-0 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-3"
        >
          {DRAWER_TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
                className={[
                  "relative px-3 py-2 text-[12.5px] font-medium transition-colors duration-[120ms] cursor-pointer",
                  "border-b-2 -mb-px",
                  active
                    ? "border-[var(--accent)] text-[var(--ink-primary)]"
                    : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Drawer Body */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {activeTab === "current" && (
            <>
              {customDrawerContent ? (
                customDrawerContent
              ) : !selectedObject ? (
                <div className="flex flex-col items-start gap-3 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-4">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--ink-primary)]">
                    <ClipboardCheck
                      className="h-4 w-4 text-[var(--accent)]"
                      strokeWidth={1.75}
                    />
                    <span>按需核对业务单据与证据</span>
                  </div>
                  <p className="text-[12.5px] text-[var(--ink-muted)] leading-relaxed">
                    在对话卡片、审批队列或日历中点击任意单据，即可在此处展开差异比对、摘要核验或会议草稿，同时保留当前主视图与草稿。
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      openDrawer({
                        kind: "brief",
                        id: "brief-7d",
                        title: "工作简报（未来 7 天）",
                      })
                    }
                    className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-3 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-plane)] cursor-pointer"
                  >
                    <Calendar className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>查看工作简报</span>
                  </button>
                </div>
              ) : selectedObject.kind === "proposal" ? (
                <div className="space-y-3">
                  {proposalLoading && (
                    <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                      正在实时核验提案详情…
                    </div>
                  )}
                  {proposalError && (
                    <AccessNoticeCard error={proposalError} />
                  )}
                  {!proposalLoading && !proposalError && proposal && (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)]">
                          {proposal.id}
                        </span>
                        <StatusBadge status={proposal.state} compact />
                      </div>
                      <ExecutionTopologyRibbon
                        state={proposal.state}
                        checks={proposal.checks}
                        events={proposal.events}
                        variant="vertical-rail"
                      />
                      <dl className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]">
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">动作类型</dt>
                          <dd className="font-medium text-[var(--ink-primary)]">
                            {formatProposalAction(proposal.plan.action)}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">目标对象</dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {proposal.plan.target}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">摘要锁</dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {formatShortDigest(proposal.digest)}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">发起人</dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {proposal.requester}
                          </dd>
                        </div>
                      </dl>
                      <Link
                        href={`/proposals/${encodeURIComponent(proposal.id)}`}
                        className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[4px] bg-[var(--accent)] px-3 text-[13px] font-medium text-white hover:bg-[var(--accent-hover)]"
                      >
                        <span>打开完整单据与审批页</span>
                        <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </Link>
                    </>
                  )}
                </div>
              ) : selectedObject.kind === "brief" ? (
                <div className="space-y-3">
                  {briefLoading && (
                    <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                      正在汇总工作简报…
                    </div>
                  )}
                  {briefError && <AccessNoticeCard error={briefError} />}
                  {!briefLoading && !briefError && brief && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3">
                          <div className="text-[11.5px] text-[var(--ink-muted)]">
                            待我审批
                          </div>
                          <div className="mt-1 font-mono-code text-[20px] font-semibold text-[var(--ink-primary)]">
                            {brief.pending_approvals}
                            {brief.pending_approvals_capped ? "+" : ""}
                          </div>
                        </div>
                        <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3">
                          <div className="text-[11.5px] text-[var(--ink-muted)]">
                            未来 7 天会议
                          </div>
                          <div className="mt-1 font-mono-code text-[20px] font-semibold text-[var(--ink-primary)]">
                            {brief.meetings}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[4px] border border-[var(--hairline)]">
                        <div className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--ink-secondary)]">
                          已提交单据状态分布
                        </div>
                        <div className="divide-y divide-[var(--hairline-subtle)]">
                          {Object.entries(brief.submitted_current_states)
                            .length === 0 ? (
                            <div className="px-3 py-4 text-center text-[12px] text-[var(--ink-muted)]">
                              暂无已提交记录
                            </div>
                          ) : (
                            Object.entries(brief.submitted_current_states).map(
                              ([stateKey, count]) => (
                                <div
                                  key={stateKey}
                                  className="flex items-center justify-between px-3 py-2 text-[12px]"
                                >
                                  <StatusBadge status={stateKey} compact />
                                  <span className="font-mono-code font-semibold text-[var(--ink-primary)]">
                                    {count}
                                  </span>
                                </div>
                              ),
                            )
                          )}
                        </div>
                      </div>

                      <div className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                        快照时间：{formatUnixTime(brief.as_of)}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3.5 text-[12.5px] text-[var(--ink-secondary)]">
                  <div className="font-mono-code text-[11px] text-[var(--ink-muted)] uppercase">
                    {selectedObject.kind} · {selectedObject.id}
                  </div>
                  <div className="mt-1 font-medium text-[var(--ink-primary)]">
                    {selectedObject.title || selectedObject.id}
                  </div>
                </div>
              )}
            </>
          )}

          {(activeTab === "assigned" || activeTab === "submitted") && (
            <div className="space-y-2">
              {tasksLoading && (
                <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                  正在加载队列…
                </div>
              )}
              {tasksError && <AccessNoticeCard error={tasksError} />}
              {!tasksLoading && !tasksError && tasks.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-10 text-center text-[12.5px] text-[var(--ink-muted)]">
                  <Inbox className="h-5 w-5 opacity-60" strokeWidth={1.5} />
                  <span>
                    {activeTab === "assigned"
                      ? "当前没有待您审批的单据"
                      : "暂无已提交的单据"}
                  </span>
                </div>
              )}
              {!tasksLoading && !tasksError && tasks.length > 0 && (
                <div className="divide-y divide-[var(--hairline)] rounded-[4px] border border-[var(--hairline)]">
                  {tasks.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        openDrawer(
                          {
                            kind: "proposal",
                            id: item.id,
                            warehouse: item.warehouse,
                            title: formatProposalAction(item.action),
                          },
                          { tab: "current" },
                        )
                      }
                      className="flex w-full flex-col gap-1.5 px-3 py-2.5 text-left hover:bg-[var(--bg-subtle)] transition-colors duration-[120ms] cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono-code text-[12px] font-semibold text-[var(--ink-primary)] truncate">
                          {item.id}
                        </span>
                        <StatusBadge status={item.state} compact />
                      </div>
                      <div className="flex items-center justify-between text-[11.5px] text-[var(--ink-muted)]">
                        <span>
                          {formatProposalAction(item.action)} ·{" "}
                          <span className="font-mono-code">
                            {item.warehouse}
                          </span>
                        </span>
                        <span className="font-mono-code">
                          {formatUnixTime(item.due)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div className="pt-2">
                <Link
                  href="/work"
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)] hover:underline"
                >
                  <span>前往完整工作台列表</span>
                  <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                </Link>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
