"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  OctagonAlert,
  PanelRight,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  generateClientId,
  getAuthGeneration,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { formatShortDigest, formatUnixTime } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type {
  AssuranceCaseDetail,
  AssuranceCaseSummary,
  AssuranceKind,
  AssuranceReview,
  AssuranceTrack,
} from "@/lib/types";
import {
  createAssuranceReview,
  fetchAssuranceCaseDetail,
  fetchAssuranceCaseReviews,
  fetchAssuranceCases,
  fetchAssuranceReview,
  submitAssuranceDecision,
} from "@/features/workbench/api";
import {
  ASSURANCE_FIELD_LABELS,
  ASSURANCE_INSTRUCTIONS,
  ASSURANCE_KIND_META,
  ASSURANCE_TRACK_GRANTS,
  ASSURANCE_TRACK_LABELS,
} from "@/features/workbench/types";

function isAssuranceUnavailableError(err: ApiError): boolean {
  return (
    err.status === 404 ||
    err.status === 503 ||
    err.code === "ASSURANCE_UNCONFIGURED" ||
    err.code === "ASSURANCE_LIST_UNAVAILABLE" ||
    err.code === "UPSTREAM_UNAVAILABLE"
  );
}

function formatFieldValue(val: string | number | boolean): string {
  if (typeof val === "boolean") return val ? "是 (true)" : "否 (false)";
  return String(val);
}

// ============================================================================
// Reusable Case Inspector (used in /work split view AND Right Business Drawer)
// ============================================================================

export interface AssuranceCaseInspectorProps {
  reference: string;
  compact?: boolean;
}

export function AssuranceCaseInspector({
  reference,
  compact = false,
}: AssuranceCaseInspectorProps) {
  const { actor, authGeneration, handleAccessChanged } = useSession();

  const [detail, setDetail] = useState<AssuranceCaseDetail | null>(null);
  const [reviews, setReviews] = useState<AssuranceReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const [clientId, setClientId] = useState(() => generateClientId("rev"));
  const [instruction, setInstruction] = useState<string>("");
  const [creatingReview, setCreatingReview] = useState(false);
  const [createError, setCreateError] = useState<ApiError | null>(null);

  const [refreshingReviewId, setRefreshingReviewId] = useState<string | null>(
    null,
  );
  const [pendingDecision, setPendingDecision] = useState<{
    review: AssuranceReview;
    track: AssuranceTrack;
    action: "approve" | "reject";
  } | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<ApiError | null>(null);
  const [decisionNotice, setDecisionNotice] = useState<string | null>(null);

  const loadCaseAndReviews = useCallback(async () => {
    const startGen = getAuthGeneration();
    setLoading(true);
    setError(null);
    try {
      const [caseData, reviewPage] = await Promise.all([
        fetchAssuranceCaseDetail(reference),
        fetchAssuranceCaseReviews(reference, { limit: 20 }),
      ]);
      if (startGen !== getAuthGeneration()) return;
      setDetail(caseData);
      setReviews(reviewPage.items);
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setDetail(null);
          setReviews([]);
          void handleAccessChanged();
        }
        setError(err);
      }
    } finally {
      if (startGen === getAuthGeneration()) setLoading(false);
    }
  }, [reference, handleAccessChanged]);

  useEffect(() => {
    setDetail(null);
    setReviews([]);
    setCreateError(null);
    setDecisionError(null);
    setDecisionNotice(null);
    setPendingDecision(null);
    setClientId(generateClientId("rev"));
    void loadCaseAndReviews();
  }, [loadCaseAndReviews, authGeneration]);

  const handleStartReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    const trimmedClientId = clientId.trim() || generateClientId("rev");
    setCreatingReview(true);
    setCreateError(null);
    setDecisionNotice(null);
    try {
      const created = await createAssuranceReview(
        detail.id,
        trimmedClientId,
        instruction,
      );
      setReviews((prev) => [
        created,
        ...prev.filter((item) => item.id !== created.id),
      ]);
      setClientId(generateClientId("rev"));
      setDecisionNotice(`已创建预审记录 ${created.id}（状态：${created.state}）。`);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setDetail(null);
          void handleAccessChanged();
        }
        setCreateError(err);
      }
    } finally {
      setCreatingReview(false);
    }
  };

  const handleRefreshReview = async (reviewId: string) => {
    setRefreshingReviewId(reviewId);
    setDecisionError(null);
    try {
      const [latestReview, latestCase] = await Promise.all([
        fetchAssuranceReview(reviewId),
        fetchAssuranceCaseDetail(reference),
      ]);
      setDetail(latestCase);
      setReviews((prev) =>
        prev.map((r) => (r.id === latestReview.id ? latestReview : r)),
      );
      setDecisionNotice("已同步最新案件字段与预审快照状态。");
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setDetail(null);
          void handleAccessChanged();
        }
        setDecisionError(err);
      }
    } finally {
      setRefreshingReviewId(null);
    }
  };

  const executeTrackDecision = async () => {
    if (!pendingDecision) return;
    setDeciding(true);
    setDecisionError(null);
    setDecisionNotice(null);
    try {
      const updated = await submitAssuranceDecision(pendingDecision.review.id, {
        track: pendingDecision.track,
        action: pendingDecision.action,
        snapshot: pendingDecision.review.snapshot,
      });
      setReviews((prev) =>
        prev.map((r) => (r.id === updated.id ? updated : r)),
      );
      setPendingDecision(null);
      setDecisionNotice(
        `已完成 ${ASSURANCE_TRACK_LABELS[pendingDecision.track]} 独立决策（当前预审状态：${updated.state}）。`,
      );
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setDetail(null);
          setPendingDecision(null);
          void handleAccessChanged();
          return;
        }
        if (err.status === 409) {
          void handleRefreshReview(pendingDecision.review.id);
        }
        setDecisionError(err);
      }
      setPendingDecision(null);
    } finally {
      setDeciding(false);
    }
  };

  if (loading && !detail) {
    return (
      <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
        正在按当前岗位权限加载受控预审案件 {reference}…
      </div>
    );
  }

  if (error && !detail) {
    if (error.status === 503 || error.code === "ASSURANCE_UNCONFIGURED") {
      return (
        <div
          data-testid="assurance-unavailable-notice"
          className="rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] p-3.5 text-[12.5px] text-[var(--status-amber-ink)]"
        >
          受控治理预审未在当前后端进程启用。
        </div>
      );
    }
    return <AccessNoticeCard error={error} />;
  }

  if (!detail) return null;

  return (
    <div className="space-y-3" data-testid={`assurance-detail-${detail.id}`}>
      {/* Case Header & Role-Scoped Fields Projection */}
      <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-3.5 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)]">
              {detail.id}
            </span>
            <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-1.5 py-0.5 font-mono-code text-[10.5px]">
              {detail.site}
            </span>
            <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
              {detail.revision} · {detail.policy}
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            onClick={() => void loadCaseAndReviews()}
          >
            <RefreshCw className="h-3 w-3" />
            <span>刷新</span>
          </Button>
        </div>

        <div className="p-3 space-y-2">
          <div className="text-[11.5px] text-[var(--ink-muted)]">
            按岗位投影字段（仅展示服务端对当前账号开放的字段）：
          </div>
          <dl
            className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]"
            data-testid="assurance-case-fields"
          >
            {Object.entries(detail.fields).map(([fieldKey, val]) => {
              const isSensitiveProjected =
                fieldKey === "supplier_bank" ||
                fieldKey === "inspector_contact" ||
                fieldKey === "counterparty_contact";
              return (
                <div
                  key={fieldKey}
                  data-testid={`assurance-field-${fieldKey}`}
                  className={[
                    "flex items-center justify-between gap-3 px-3 py-1.5",
                    isSensitiveProjected ? "bg-[var(--accent-wash)]/55" : "",
                  ].join(" ")}
                >
                  <dt className="text-[var(--ink-secondary)]">
                    {ASSURANCE_FIELD_LABELS[fieldKey] ?? fieldKey}
                  </dt>
                  <dd className="font-mono-code font-medium text-[var(--ink-primary)] text-right break-all">
                    {formatFieldValue(val)}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      </div>

      {/* Start Controlled Review Form */}
      <form
        onSubmit={handleStartReview}
        data-testid="assurance-start-review-form"
        className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-3.5 space-y-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
            发起受控治理预审
          </span>
          <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
            POST /v1/assurance/cases/{detail.id}/reviews
          </span>
        </div>

        <div
          className={
            compact
              ? "space-y-2"
              : "grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto] items-end"
          }
        >
          <label className="block space-y-1">
            <span className="text-[11.5px] text-[var(--ink-muted)]">
              幂等标识 (client_id)
            </span>
            <input
              type="text"
              required
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              data-testid="assurance-client-id-input"
              className="h-8 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 font-mono-code text-[12px]"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11.5px] text-[var(--ink-muted)]">
              受控预审指令 (instruction)
            </span>
            <select
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              data-testid="assurance-instruction-select"
              className="h-8 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 text-[12px]"
            >
              {ASSURANCE_INSTRUCTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={creatingReview}
            data-testid="assurance-start-review-btn"
            className="h-8"
          >
            <Play className="h-3.5 w-3.5" />
            <span>发起预审</span>
          </Button>
        </div>

        {createError && <AccessNoticeCard error={createError} />}
      </form>

      {decisionNotice && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-[4px] border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-3 py-2 text-[12px] text-[var(--status-emerald)]"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>{decisionNotice}</span>
        </div>
      )}

      {decisionError && <AccessNoticeCard error={decisionError} />}

      {/* Existing Reviews & Multi-Track Decision Matrix */}
      <div className="space-y-3" data-testid="assurance-reviews-list">
        {reviews.length === 0 ? (
          <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-6 text-center text-[12px] text-[var(--ink-muted)]">
            该案件尚未生成预审记录，点击上方「发起预审」生成规则路由与多轨决策快照。
          </div>
        ) : (
          reviews.map((review) => {
            const isStaleOrExpired = review.stale || review.expired;
            const isHeld = review.state === "HELD";
            const isRequester = actor?.subject === review.requester;
            const decidedOtherTrack = Boolean(
              actor &&
                Object.values(review.decisions).some(
                  (d) => d && d.actor === actor.subject,
                ),
            );

            return (
              <div
                key={review.id}
                data-testid={`assurance-review-${review.id}`}
                className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-3.5 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono-code text-[12px] font-semibold text-[var(--ink-primary)]">
                      {formatShortDigest(review.id, 10, 6)}
                    </span>
                    <StatusBadge status={review.state} compact />
                    {review.stale && (
                      <StatusBadge
                        status="expired"
                        label="快照已陈旧 (stale)"
                        compact
                      />
                    )}
                    {review.expired && (
                      <StatusBadge
                        status="expired"
                        label="预审已过期"
                        compact
                      />
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={refreshingReviewId === review.id}
                    onClick={() => void handleRefreshReview(review.id)}
                    data-testid="assurance-refresh-review-btn"
                    className="h-6 px-2 text-[11.5px]"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>刷新快照</span>
                  </Button>
                </div>

                <div className="p-3.5 space-y-3 text-[12px]">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono-code text-[11px] text-[var(--ink-muted)]">
                    <span>发起人：{review.requester}</span>
                    <span>快照：{formatShortDigest(review.snapshot)}</span>
                    <span>run_id：{formatShortDigest(review.run_id, 8, 4)}</span>
                    {review.expires_at && (
                      <span>到期：{formatUnixTime(review.expires_at)}</span>
                    )}
                  </div>

                  {/* Stale / Expired Hard Lock Notice */}
                  {isStaleOrExpired && (
                    <div
                      role="alert"
                      data-testid="assurance-stale-expired-banner"
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-3 py-2 text-[12px] text-[var(--status-amber-ink)]"
                    >
                      <div className="flex items-center gap-1.5">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>
                          {review.stale
                            ? "源数据快照已变化（stale），已禁止基于旧快照提交决策，请刷新并重新发起预审。"
                            : "当前预审已过有效期（expired），已禁止提交决策，请刷新或重新发起预审。"}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleRefreshReview(review.id)}
                      >
                        <RefreshCw className="h-3 w-3" />
                        <span>刷新</span>
                      </Button>
                    </div>
                  )}

                  {/* HELD Hard Hold Notice */}
                  {isHeld && (
                    <div
                      role="alert"
                      data-testid="assurance-held-banner"
                      className="flex items-start gap-2 rounded-[4px] border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3 py-2 text-[12px] text-[var(--status-crimson)]"
                    >
                      <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        硬性留置（HELD）：规则命中致命异常，禁止在留置状态下通过，仅可驳回或待源单据修正后重审。
                      </span>
                    </div>
                  )}

                  {/* Findings */}
                  {(review.rule_findings.length > 0 ||
                    review.model_findings.length > 0) && (
                    <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 space-y-1">
                      <div className="text-[11px] font-medium text-[var(--ink-muted)]">
                        规则与预审发现项：
                      </div>
                      <div className="flex flex-wrap gap-1.5 font-mono-code text-[11px]">
                        {review.rule_findings.map((f) => (
                          <span
                            key={`rule-${f}`}
                            className="rounded-[2px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-1.5 py-0.5 text-[var(--status-amber-ink)]"
                          >
                            {f}
                          </span>
                        ))}
                        {review.model_findings.map((f) => (
                          <span
                            key={`model-${f}`}
                            className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-1.5 py-0.5 text-[var(--ink-secondary)]"
                          >
                            {f}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Independent Multi-Track Decision Table */}
                  <div className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)]">
                    {review.tracks.map((track) => {
                      const decision = review.decisions[track];
                      const requiredGrant = ASSURANCE_TRACK_GRANTS[track];
                      const hasGrant = Boolean(
                        actor?.grants.includes(requiredGrant),
                      );
                      const isTerminal =
                        review.state === "APPROVED" ||
                        review.state === "REJECTED";
                      const canDecide =
                        !decision &&
                        !isTerminal &&
                        !isStaleOrExpired &&
                        hasGrant &&
                        !isRequester &&
                        !decidedOtherTrack;

                      return (
                        <div
                          key={track}
                          data-testid={`assurance-track-${track}`}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                        >
                          <div className="space-y-0.5">
                            <div className="font-medium text-[var(--ink-primary)]">
                              {ASSURANCE_TRACK_LABELS[track]}
                            </div>
                            <div className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                              {decision
                                ? `${decision.actor} 已执行 ${decision.action}`
                                : isRequester
                                  ? "发起人不可审批本人预审"
                                  : decidedOtherTrack
                                    ? "同人仅可表决一条轨道（独立双人要求）"
                                    : hasGrant
                                      ? "具备该轨决策权限"
                                      : `需要权限 ${requiredGrant}`}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            {decision ? (
                              <StatusBadge
                                status={
                                  decision.action === "approve"
                                    ? "APPROVED"
                                    : "REJECTED"
                                }
                                label={
                                  decision.action === "approve"
                                    ? "该轨已通过"
                                    : "该轨已驳回"
                                }
                                compact
                              />
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="primary"
                                  disabled={!canDecide || isHeld}
                                  onClick={() =>
                                    setPendingDecision({
                                      review,
                                      track,
                                      action: "approve",
                                    })
                                  }
                                  data-testid={`assurance-approve-${track}`}
                                >
                                  <ShieldCheck className="h-3.5 w-3.5" />
                                  <span>通过</span>
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  disabled={!canDecide}
                                  onClick={() =>
                                    setPendingDecision({
                                      review,
                                      track,
                                      action: "reject",
                                    })
                                  }
                                  data-testid={`assurance-reject-${track}`}
                                >
                                  <XCircle className="h-3.5 w-3.5" />
                                  <span>驳回</span>
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Track Decision ConfirmDialog */}
      <ConfirmDialog
        open={pendingDecision !== null}
        onOpenChange={(open) => !open && setPendingDecision(null)}
        title={
          pendingDecision?.action === "approve"
            ? `确认通过 ${pendingDecision ? ASSURANCE_TRACK_LABELS[pendingDecision.track] : ""}`
            : `确认驳回 ${pendingDecision ? ASSURANCE_TRACK_LABELS[pendingDecision.track] : ""}`
        }
        description="决策将绑定当前源数据快照（snapshot），并写入不可篡改审计链。"
        metadata={
          pendingDecision
            ? [
                { label: "案件编号", value: detail.id, mono: true },
                {
                  label: "决策轨道",
                  value: ASSURANCE_TRACK_LABELS[pendingDecision.track],
                },
                {
                  label: "快照摘要",
                  value: formatShortDigest(pendingDecision.review.snapshot),
                  mono: true,
                },
              ]
            : []
        }
        destructive={pendingDecision?.action === "reject"}
        confirmLabel={
          pendingDecision?.action === "approve" ? "确认通过该轨" : "确认驳回该轨"
        }
        loading={deciding}
        onConfirm={executeTrackDecision}
      />
    </div>
  );
}

// ============================================================================
// Main Assurance Tab Panel (/work)
// ============================================================================

export interface AssurancePanelProps {
  /** Restrict to specific kinds (e.g. Finance module showing contract cases only) */
  fixedKinds?: AssuranceKind[];
}

export function AssurancePanel({ fixedKinds }: AssurancePanelProps) {
  const { actor, authGeneration, handleAccessChanged } = useSession();
  const { openDrawer } = useWorkbench();

  const grantedKinds = useMemo(() => {
    if (!actor) return [] as AssuranceKind[];
    const pool: AssuranceKind[] = fixedKinds ?? [
      "purchase",
      "incoming_quality",
      "contract",
    ];
    return pool.filter((k) =>
      actor.grants.includes(ASSURANCE_KIND_META[k].grant),
    );
  }, [actor, fixedKinds]);

  const [activeKind, setActiveKind] = useState<AssuranceKind>(
    grantedKinds[0] ?? "purchase",
  );
  const [cases, setCases] = useState<AssuranceCaseSummary[]>([]);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);

  useEffect(() => {
    if (grantedKinds.length > 0 && !grantedKinds.includes(activeKind)) {
      setActiveKind(grantedKinds[0]!);
    }
  }, [grantedKinds, activeKind]);

  const loadCases = useCallback(
    async (kind: AssuranceKind) => {
      const startGen = getAuthGeneration();
      setLoading(true);
      setError(null);
      setUnavailable(false);
      try {
        const page = await fetchAssuranceCases(kind, { limit: 30 });
        if (startGen !== getAuthGeneration()) return;
        setCases(page.items);
        setNextAfter(page.next);
        setSelectedRef((prev) =>
          prev && page.items.some((i) => i.id === prev)
            ? prev
            : (page.items[0]?.id ?? null),
        );
      } catch (err) {
        if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            setCases([]);
            void handleAccessChanged();
            return;
          }
          if (isAssuranceUnavailableError(err)) {
            setUnavailable(true);
            setCases([]);
            setSelectedRef(null);
            return;
          }
          setError(err);
        }
      } finally {
        if (startGen === getAuthGeneration()) setLoading(false);
      }
    },
    [handleAccessChanged],
  );

  useEffect(() => {
    setCases([]);
    setNextAfter(null);
    setSelectedRef(null);
    if (grantedKinds.includes(activeKind)) {
      void loadCases(activeKind);
    } else {
      setLoading(false);
    }
  }, [activeKind, grantedKinds, loadCases, authGeneration]);

  const handleLoadMore = async () => {
    if (!nextAfter) return;
    const startGen = getAuthGeneration();
    setLoadingMore(true);
    try {
      const page = await fetchAssuranceCases(activeKind, {
        limit: 30,
        after: nextAfter,
      });
      if (startGen !== getAuthGeneration()) return;
      setCases((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.items.filter((c) => !seen.has(c.id))];
      });
      setNextAfter(page.next);
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      if (isApiError(err)) setError(err);
    } finally {
      if (startGen === getAuthGeneration()) setLoadingMore(false);
    }
  };

  if (grantedKinds.length === 0) {
    return (
      <AccessNoticeCard
        variant="ACCESS_RESTRICTED"
        title="未开通受控治理预审权限"
        message="当前账号不具备采购、来料质检或合同法务预审权限。"
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="workbench-assurance-module">
      {/* Kind Selector Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] px-4 py-2.5">
        <div
          role="tablist"
          aria-label="预审案件类别"
          className="flex flex-wrap items-center gap-1.5"
        >
          {grantedKinds.map((kind) => {
            const active = activeKind === kind;
            return (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`assurance-kind-${kind}`}
                onClick={() => setActiveKind(kind)}
                className={[
                  "h-8 rounded-[4px] border px-3 text-[12.5px] font-medium transition-colors duration-[120ms] cursor-pointer",
                  active
                    ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)]"
                    : "border-transparent text-[var(--ink-secondary)] hover:bg-[var(--bg-plane)]",
                ].join(" ")}
              >
                {ASSURANCE_KIND_META[kind].label}
              </button>
            );
          })}
        </div>

        <Button
          size="sm"
          variant="secondary"
          loading={loading}
          onClick={() => void loadCases(activeKind)}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>刷新案件</span>
        </Button>
      </div>

      {/* Graceful Unavailable Banner when Assurance is disabled on backend (404 / 503) */}
      {unavailable && (
        <div className="space-y-3" data-testid="assurance-unavailable-notice">
          <div
            role="status"
            className="flex items-start gap-3 rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] p-4 text-[13px] text-[var(--status-amber-ink)]"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            <div className="space-y-1">
              <div className="font-semibold text-[var(--ink-primary)]">
                受控治理预审未在当前后端进程启用
              </div>
              <p className="text-[12.5px] leading-relaxed">
                当前后端进程未配置 Assurance 密钥或工作区连接器（`/v1/assurance/*` 返回 503/404）。如需体验真实多轨审批，请在启动脚本中启用 `AIOS_ASSURANCE_DEMO_KEY_FILE` 或配置双端口 `AIOS_ASSURANCE_API_BASE_URL`。
              </p>
            </div>
          </div>

          {/* Clearly Tagged Synthetic Preview Card */}
          <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-secondary)]">
                  ASSURANCE PREVIEW · 受控多轨预审结构示意
                </span>
                <SourceTag source="synthetic" />
              </div>
              <span className="text-[11.5px] text-[var(--ink-muted)]">
                仅示意界面结构，非实时后端数据
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3 text-[12px]">
              <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3 space-y-1">
                <div className="font-mono-code font-semibold text-[var(--ink-primary)]">
                  PO-100 · 采购预审 (HK01)
                </div>
                <p className="text-[var(--ink-muted)]">
                  财务角色可见受限字段 supplier_bank；路由至 procurement + finance 独立双轨决策。
                </p>
              </div>
              <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3 space-y-1">
                <div className="font-mono-code font-semibold text-[var(--ink-primary)]">
                  QA-200 · 来料质检 (HK01)
                </div>
                <p className="text-[var(--ink-muted)]">
                  质检角色可见 inspector_contact；命中 CRITICAL_DEFECT 时自动进入硬性留置 (HELD)。
                </p>
              </div>
              <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3 space-y-1">
                <div className="font-mono-code font-semibold text-[var(--ink-primary)]">
                  CT-300 · 合同法务 (HK01)
                </div>
                <p className="text-[var(--ink-muted)]">
                  法务角色可见 counterparty_contact；非标模板与自动续约触发 legal + procurement 双轨。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && <AccessNoticeCard error={error} />}

      {/* Live Master-Detail Assurance Cases */}
      {!unavailable && !error && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.4fr)]">
          {/* Case List */}
          <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-3.5 py-2">
              <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-secondary)]">
                CASES · 案件列表 ({cases.length})
              </span>
              <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                {ASSURANCE_KIND_META[activeKind].shortLabel}
              </span>
            </div>

            {loading && cases.length === 0 ? (
              <div className="py-10 text-center text-[12px] text-[var(--ink-muted)]">
                正在加载案件列表…
              </div>
            ) : cases.length === 0 ? (
              <div className="py-10 text-center text-[12px] text-[var(--ink-muted)]">
                当前分类与仓库范围内暂无预审案件
              </div>
            ) : (
              <div className="divide-y divide-[var(--hairline-subtle)]">
                {cases.map((item) => {
                  const selected = selectedRef === item.id;
                  return (
                    <div
                      key={item.id}
                      data-testid={`assurance-case-row-${item.id}`}
                      className={[
                        "flex items-center justify-between gap-2 px-3.5 py-2.5 transition-colors duration-[120ms]",
                        selected
                          ? "bg-[var(--accent-wash)]"
                          : "hover:bg-[var(--bg-subtle)]",
                      ].join(" ")}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedRef(item.id)}
                        className="min-w-0 flex-1 text-left cursor-pointer"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)]">
                            {item.id}
                          </span>
                          <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-1.5 py-0.5 font-mono-code text-[10.5px]">
                            {item.site}
                          </span>
                        </div>
                        <div className="mt-0.5 font-mono-code text-[11px] text-[var(--ink-muted)]">
                          {item.revision}
                          {item.submitted_at
                            ? ` · ${formatUnixTime(item.submitted_at)}`
                            : ""}
                        </div>
                      </button>

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) =>
                          openDrawer(
                            {
                              kind: "assurance",
                              id: item.id,
                              warehouse: item.site,
                              title: `预审案件 · ${item.id}`,
                            },
                            { tab: "current", trigger: e.currentTarget },
                          )
                        }
                        title="在右侧业务面板打开"
                      >
                        <PanelRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {nextAfter && (
              <div className="border-t border-[var(--hairline)] p-2.5 text-center">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={loadingMore}
                  onClick={() => void handleLoadMore()}
                >
                  加载更多案件
                </Button>
              </div>
            )}
          </div>

          {/* Case Detail & Multi-Track Review Workspace */}
          <div className="min-w-0">
            {selectedRef ? (
              <AssuranceCaseInspector reference={selectedRef} />
            ) : (
              <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                请从左侧选择一条案件以按需加载字段投影与预审决策。
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
