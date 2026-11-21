"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  OctagonAlert,
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
import { formatShortDigest } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
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
  ASSURANCE_KIND_GRANTS,
  ASSURANCE_TRACK_GRANTS,
  getAssuranceFieldLabel,
  getAssuranceInstructions,
  getAssuranceKindMeta,
  getAssuranceTrackLabels,
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

// ============================================================================
// Reusable Case Inspector (used in /work split view AND Right Business Drawer)
// ============================================================================

export interface AssuranceCaseInspectorProps {
  reference: string;
  compact?: boolean;
  /** Hide the inspector's own refresh button when a parent toolbar already provides a unified refresh trigger. */
  hideRefresh?: boolean;
  /** Monotonically increasing signal from parent refresh trigger to reload the selected case in place. */
  refreshSignal?: number;
}

export function AssuranceCaseInspector({
  reference,
  compact = false,
  hideRefresh = false,
  refreshSignal = 0,
}: AssuranceCaseInspectorProps) {
  const { locale, t, tx, formatDateTime, formatCurrency } = useLocale();
  const { actor, authGeneration, handleAccessChanged } = useSession();

  const kindMeta = useMemo(() => getAssuranceKindMeta(locale), [locale]);
  const trackLabels = useMemo(() => getAssuranceTrackLabels(locale), [locale]);
  const instructions = useMemo(
    () => getAssuranceInstructions(locale),
    [locale],
  );

  const formatFieldValue = useCallback(
    (
      fieldKey: string,
      val: string | number | boolean,
      allFields: Record<string, string | number | boolean>,
    ): string => {
      if (typeof val === "boolean") {
        return val ? t("common.yes") : t("common.no");
      }
      if (fieldKey === "amount_minor" && typeof val === "number") {
        const currencyRaw = allFields.currency;
        const currency =
          typeof currencyRaw === "string" && currencyRaw.trim()
            ? currencyRaw.trim().toUpperCase()
            : "HKD";
        return formatCurrency(val, currency, { fromMinorUnits: true });
      }
      return String(val);
    },
    [t, formatCurrency],
  );

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

  const lastRefreshSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal !== lastRefreshSignalRef.current) {
      lastRefreshSignalRef.current = refreshSignal;
      void loadCaseAndReviews();
    }
  }, [refreshSignal, loadCaseAndReviews]);

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
      setDecisionNotice(
        tx(
          {
            "zh-CN": "已创建预审记录 {id}。",
            "zh-HK": "已建立預審紀錄 {id}。",
            en: "Created assurance review {id}.",
          },
          { id: formatShortDigest(created.id, 8, 4) },
        ),
      );
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
      setDecisionNotice(
        tx({
          "zh-CN": "已同步最新案件字段与预审快照状态。",
          "zh-HK": "已同步最新案件欄位與預審快照狀態。",
          en: "Synced latest case fields and review snapshot.",
        }),
      );
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
        tx(
          {
            "zh-CN": "已完成 {track} 独立决策。",
            "zh-HK": "已完成 {track} 獨立決策。",
            en: "Recorded independent decision on {track}.",
          },
          { track: trackLabels[pendingDecision.track] },
        ),
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
      <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] py-10 text-center text-[13px] text-[var(--ink-muted)]">
        {tx(
          {
            "zh-CN": "正在按当前岗位权限加载受控预审案件 {ref}…",
            "zh-HK": "正在按目前職位權限載入受控預審案件 {ref}…",
            en: "Loading role-scoped assurance case {ref}…",
          },
          { ref: reference },
        )}
      </div>
    );
  }

  if (error && !detail) {
    if (error.status === 503 || error.code === "ASSURANCE_UNCONFIGURED") {
      return (
        <div
          data-testid="assurance-unavailable-notice"
          className="rounded-tile bg-[var(--status-amber-wash)] p-4 text-[13px] text-[var(--status-amber-ink)]"
        >
          {tx({
            "zh-CN": "受控治理预审未在当前后端进程启用。",
            "zh-HK": "受控治理預審未於目前後端程序啟用。",
            en: "Governed assurance is not enabled on this backend instance.",
          })}
        </div>
      );
    }
    return <AccessNoticeCard error={error} />;
  }

  if (!detail) return null;

  return (
    <div className="space-y-4" data-testid={`assurance-detail-${detail.id}`}>
      {/* Case Header & Role-Scoped Fields Projection */}
      <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] px-4.5 py-3.5">
          <div
            className="flex flex-wrap items-center gap-2 min-w-0"
            title={tx(
              {
                "zh-CN": "版本 {rev} · 规则集 {policy}",
                "zh-HK": "版本 {rev} · 規則集 {policy}",
                en: "Revision {rev} · Policy {policy}",
              },
              { rev: detail.revision, policy: detail.policy },
            )}
          >
            <span className="font-mono-code text-[14.5px] font-semibold text-[var(--ink-primary)]">
              {detail.id}
            </span>
            <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)]">
              {detail.site}
            </span>
            <span className="text-[12px] text-[var(--ink-muted)]">
              {kindMeta[detail.kind]?.label ?? detail.kind}
            </span>
          </div>
          {!hideRefresh && (
            <Button
              size="sm"
              pill
              variant="secondary"
              loading={loading}
              onClick={() => void loadCaseAndReviews()}
            >
              <RefreshCw className="h-3 w-3" />
              <span>{t("common.refresh")}</span>
            </Button>
          )}
        </div>

        <div className="p-4 space-y-2.5">
          <div className="text-[12px] text-[var(--ink-muted)]">
            {tx({
              "zh-CN": "按岗位投影字段（仅展示服务端对当前账号开放的字段）",
              "zh-HK": "按職位投影欄位（僅顯示伺服器端對目前帳號開放的欄位）",
              en: "Role-projected fields (strictly limited to attributes authorized for your role)",
            })}
          </div>
          <dl
            className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] text-[12.5px] overflow-hidden"
            data-testid="assurance-case-fields"
          >
            {Object.entries(detail.fields).map(([fieldKey, val]) => {
              const isSensitiveProjected =
                fieldKey === "supplier_bank" ||
                fieldKey === "inspector_contact" ||
                fieldKey === "counterparty_contact";
              const isBoolean = typeof val === "boolean";
              const formattedValue = formatFieldValue(
                fieldKey,
                val,
                detail.fields,
              );
              return (
                <div
                  key={fieldKey}
                  data-testid={`assurance-field-${fieldKey}`}
                  className={[
                    "flex items-center justify-between gap-3 px-3.5 py-2.5",
                    isSensitiveProjected ? "bg-[var(--accent-wash)]/70" : "",
                  ].join(" ")}
                >
                  <dt className="flex items-center gap-2 text-[var(--ink-secondary)]">
                    <span>{getAssuranceFieldLabel(fieldKey, locale)}</span>
                    {isSensitiveProjected && (
                      <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent-ink)] shadow-[var(--shadow-subtle)]">
                        {tx({
                          "zh-CN": "岗位可见",
                          "zh-HK": "職位可見",
                          en: "Role-Scoped",
                        })}
                      </span>
                    )}
                  </dt>
                  <dd
                    className={[
                      "text-right break-all",
                      isBoolean
                        ? "font-medium text-[var(--ink-primary)]"
                        : fieldKey === "amount_minor"
                          ? "font-mono-code tabular-nums font-semibold text-[var(--ink-primary)]"
                          : "font-mono-code tabular-nums font-medium text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    {formattedValue}
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
        className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-4.5 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
            {tx({
              "zh-CN": "发起受控治理预审",
              "zh-HK": "發起受控治理預審",
              en: "Start Governed Review",
            })}
          </span>
          <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 text-[11px] text-[var(--ink-muted)]">
            {tx({
              "zh-CN": "案件 ",
              "zh-HK": "案件 ",
              en: "Case ",
            })}
            <span className="font-mono-code text-[var(--ink-secondary)]">
              {detail.id}
            </span>
          </span>
        </div>

        <div
          className={
            compact
              ? "space-y-2.5"
              : "grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] items-end"
          }
        >
          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
              {tx({
                "zh-CN": "幂等标识",
                "zh-HK": "冪等識別碼",
                en: "Client ID (Idempotency)",
              })}
            </span>
            <input
              type="text"
              required
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              data-testid="assurance-client-id-input"
              className="h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12px] text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
              {tx({
                "zh-CN": "受控预审指令",
                "zh-HK": "受控預審指令",
                en: "Review Instruction",
              })}
            </span>
            <select
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              data-testid="assurance-instruction-select"
              className="h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 text-[12.5px] text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
            >
              {instructions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <Button
            type="submit"
            size="md"
            variant="primary"
            loading={creatingReview}
            data-testid="assurance-start-review-btn"
          >
            <Play className="h-3.5 w-3.5" />
            <span>
              {tx({
                "zh-CN": "发起预审",
                "zh-HK": "發起預審",
                en: "Start Review",
              })}
            </span>
          </Button>
        </div>

        {createError && <AccessNoticeCard error={createError} />}
      </form>

      {decisionNotice && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-tile bg-[var(--status-emerald-wash)] px-4 py-3 text-[12.5px] font-medium text-[var(--status-emerald)]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{decisionNotice}</span>
        </div>
      )}

      {decisionError && <AccessNoticeCard error={decisionError} />}

      {/* Existing Reviews & Multi-Track Decision Matrix */}
      <div className="space-y-3.5" data-testid="assurance-reviews-list">
        {reviews.length === 0 ? (
          <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] px-4 py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
            {tx({
              "zh-CN":
                "该案件尚未生成预审记录，点击上方「发起预审」生成规则路由与多轨决策快照。",
              "zh-HK":
                "該案件尚未產生預審紀錄，點擊上方「發起預審」產生規則路由與多軌決策快照。",
              en: "No assurance reviews yet. Click Start Review above to generate rule routing and track snapshots.",
            })}
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
                className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] px-4.5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      title={review.id}
                      className="font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)]"
                    >
                      {formatShortDigest(review.id, 8, 4)}
                    </span>
                    <StatusBadge status={review.state} compact />
                    {review.stale && (
                      <StatusBadge
                        status="expired"
                        label={tx({
                          "zh-CN": "快照已陈旧",
                          "zh-HK": "快照已陳舊",
                          en: "Stale Snapshot",
                        })}
                        compact
                      />
                    )}
                    {review.expired && (
                      <StatusBadge
                        status="expired"
                        label={tx({
                          "zh-CN": "预审已过期",
                          "zh-HK": "預審已過期",
                          en: "Expired",
                        })}
                        compact
                      />
                    )}
                  </div>
                  <Button
                    size="sm"
                    pill
                    variant="secondary"
                    loading={refreshingReviewId === review.id}
                    onClick={() => void handleRefreshReview(review.id)}
                    data-testid="assurance-refresh-review-btn"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>
                      {tx({
                        "zh-CN": "刷新快照",
                        "zh-HK": "重新整理快照",
                        en: "Refresh Snapshot",
                      })}
                    </span>
                  </Button>
                </div>

                <div className="p-4 space-y-3.5 text-[12.5px]">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--ink-muted)]">
                    <span>
                      {tx({
                        "zh-CN": "发起人：",
                        "zh-HK": "發起人：",
                        en: "Requester: ",
                      })}
                      <span className="font-mono-code text-[var(--ink-secondary)]">
                        {review.requester}
                      </span>
                    </span>
                    <span>
                      {tx({
                        "zh-CN": "快照：",
                        "zh-HK": "快照：",
                        en: "Snapshot: ",
                      })}
                      <span className="font-mono-code text-[var(--ink-secondary)]">
                        {formatShortDigest(review.snapshot)}
                      </span>
                    </span>
                    <span>
                      {tx({
                        "zh-CN": "运行号：",
                        "zh-HK": "執行號：",
                        en: "Run: ",
                      })}
                      <span className="font-mono-code text-[var(--ink-secondary)]">
                        {formatShortDigest(review.run_id, 8, 4)}
                      </span>
                    </span>
                    {review.expires_at && (
                      <span className="tabular-nums">
                        {tx({
                          "zh-CN": "到期：",
                          "zh-HK": "到期：",
                          en: "Expires: ",
                        })}
                        <span className="font-mono-code text-[var(--ink-secondary)]">
                          {formatDateTime(review.expires_at)}
                        </span>
                      </span>
                    )}
                  </div>

                  {/* Stale / Expired Hard Lock Notice */}
                  {isStaleOrExpired && (
                    <div
                      role="alert"
                      data-testid="assurance-stale-expired-banner"
                      className="flex flex-wrap items-center justify-between gap-2.5 rounded-tile bg-[var(--status-amber-wash)] px-3.5 py-3 text-[12.5px] text-[var(--status-amber-ink)]"
                    >
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>
                          {review.stale
                            ? tx({
                                "zh-CN":
                                  "源数据快照已变化，已禁止基于旧快照提交决策，请刷新并重新发起预审。",
                                "zh-HK":
                                  "源資料快照已變化，已禁止基於舊快照提交決策，請重新整理並重新發起預審。",
                                en: "Source snapshot changed. Decisions on stale snapshots are blocked — refresh and start a new review.",
                              })
                            : tx({
                                "zh-CN":
                                  "当前预审已过有效期，已禁止提交决策，请刷新或重新发起预审。",
                                "zh-HK":
                                  "目前預審已過有效期，已禁止提交決策，請重新整理或重新發起預審。",
                                en: "This review has expired. Decisions are blocked — refresh or start a new review.",
                              })}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        pill
                        variant="secondary"
                        onClick={() => void handleRefreshReview(review.id)}
                      >
                        <RefreshCw className="h-3 w-3" />
                        <span>{t("common.refresh")}</span>
                      </Button>
                    </div>
                  )}

                  {/* HELD Hard Hold Notice */}
                  {isHeld && (
                    <div
                      role="alert"
                      data-testid="assurance-held-banner"
                      className="flex items-start gap-2.5 rounded-tile bg-[var(--status-crimson-wash)] px-3.5 py-3 text-[12.5px] text-[var(--status-crimson)]"
                    >
                      <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        {tx({
                          "zh-CN":
                            "硬性留置：规则命中致命异常，禁止在留置状态下通过，仅可驳回或待源单据修正后重审。",
                          "zh-HK":
                            "強制留置：規則命中重大異常，禁止於留置狀態下通過，僅可駁回或待源單據修正後重審。",
                          en: "Hard hold: a critical rule finding blocks approval. Reject or correct the source record before re-reviewing.",
                        })}
                      </span>
                    </div>
                  )}

                  {/* Findings */}
                  {(review.rule_findings.length > 0 ||
                    review.model_findings.length > 0) && (
                    <div className="rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-3 space-y-2">
                      <div className="text-[11.5px] font-medium text-[var(--ink-muted)]">
                        {tx({
                          "zh-CN": "规则与预审发现项",
                          "zh-HK": "規則與預審發現項",
                          en: "Rule & Review Findings",
                        })}
                      </div>
                      <div className="flex flex-wrap gap-1.5 font-mono-code text-[11px]">
                        {review.rule_findings.map((f) => (
                          <span
                            key={`rule-${f}`}
                            className="rounded-full bg-[var(--status-amber-wash)] px-2.5 py-0.5 font-medium text-[var(--status-amber-ink)]"
                          >
                            {f}
                          </span>
                        ))}
                        {review.model_findings.map((f) => (
                          <span
                            key={`model-${f}`}
                            className="rounded-full bg-[var(--bg-surface)] px-2.5 py-0.5 text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]"
                          >
                            {f}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Independent Multi-Track Decision Matrix */}
                  <div className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] overflow-hidden">
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
                          className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-3"
                        >
                          <div className="space-y-0.5">
                            <div className="font-semibold text-[var(--ink-primary)]">
                              {trackLabels[track]}
                            </div>
                            <div className="text-[11.5px] text-[var(--ink-muted)]">
                              {decision
                                ? decision.action === "approve"
                                  ? tx(
                                      {
                                        "zh-CN": "{actor} 已通过",
                                        "zh-HK": "{actor} 已通過",
                                        en: "Approved by {actor}",
                                      },
                                      { actor: decision.actor },
                                    )
                                  : tx(
                                      {
                                        "zh-CN": "{actor} 已驳回",
                                        "zh-HK": "{actor} 已駁回",
                                        en: "Rejected by {actor}",
                                      },
                                      { actor: decision.actor },
                                    )
                                : isRequester
                                  ? tx({
                                      "zh-CN": "发起人不可审批本人预审",
                                      "zh-HK": "發起人不可審批本人預審",
                                      en: "Requester cannot decide own review",
                                    })
                                  : decidedOtherTrack
                                    ? tx({
                                        "zh-CN":
                                          "同人仅可表决一条轨道（独立双人要求）",
                                        "zh-HK":
                                          "同人僅可表決一條軌道（獨立雙人要求）",
                                        en: "One track per person (dual-control separation)",
                                      })
                                    : hasGrant
                                      ? tx({
                                          "zh-CN": "具备该轨决策权限",
                                          "zh-HK": "具備該軌決策權限",
                                          en: "Authorized to decide this track",
                                        })
                                      : tx(
                                          {
                                            "zh-CN": "需要权限 {grant}",
                                            "zh-HK": "需要權限 {grant}",
                                            en: "Requires grant {grant}",
                                          },
                                          { grant: requiredGrant },
                                        )}
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
                                    ? tx({
                                        "zh-CN": "该轨已通过",
                                        "zh-HK": "該軌已通過",
                                        en: "Track Approved",
                                      })
                                    : tx({
                                        "zh-CN": "该轨已驳回",
                                        "zh-HK": "該軌已駁回",
                                        en: "Track Rejected",
                                      })
                                }
                                compact
                              />
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  pill
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
                                  <span>
                                    {tx({
                                      "zh-CN": "通过",
                                      "zh-HK": "通過",
                                      en: "Approve",
                                    })}
                                  </span>
                                </Button>
                                <Button
                                  size="sm"
                                  pill
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
                                  <span>
                                    {tx({
                                      "zh-CN": "驳回",
                                      "zh-HK": "駁回",
                                      en: "Reject",
                                    })}
                                  </span>
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
            ? tx(
                {
                  "zh-CN": "确认通过 {track}",
                  "zh-HK": "確認通過 {track}",
                  en: "Approve {track}",
                },
                {
                  track: pendingDecision
                    ? trackLabels[pendingDecision.track]
                    : "",
                },
              )
            : tx(
                {
                  "zh-CN": "确认驳回 {track}",
                  "zh-HK": "確認駁回 {track}",
                  en: "Reject {track}",
                },
                {
                  track: pendingDecision
                    ? trackLabels[pendingDecision.track]
                    : "",
                },
              )
        }
        description={tx({
          "zh-CN": "决策将绑定当前源数据快照，并写入不可篡改审计链。",
          "zh-HK": "決策將綁定目前源資料快照，並寫入不可竄改稽核鏈。",
          en: "Your decision will be bound to the current snapshot and recorded in the tamper-evident audit chain.",
        })}
        metadata={
          pendingDecision
            ? [
                {
                  label: tx({
                    "zh-CN": "案件编号",
                    "zh-HK": "案件編號",
                    en: "Case ID",
                  }),
                  value: detail.id,
                  mono: true,
                },
                {
                  label: tx({
                    "zh-CN": "决策轨道",
                    "zh-HK": "決策軌道",
                    en: "Decision Track",
                  }),
                  value: trackLabels[pendingDecision.track],
                },
                {
                  label: tx({
                    "zh-CN": "快照摘要",
                    "zh-HK": "快照摘要",
                    en: "Snapshot Digest",
                  }),
                  value: formatShortDigest(pendingDecision.review.snapshot),
                  mono: true,
                },
              ]
            : []
        }
        destructive={pendingDecision?.action === "reject"}
        confirmLabel={
          pendingDecision?.action === "approve"
            ? tx({
                "zh-CN": "确认通过该轨",
                "zh-HK": "確認通過該軌",
                en: "Confirm Approval",
              })
            : tx({
                "zh-CN": "确认驳回该轨",
                "zh-HK": "確認駁回該軌",
                en: "Confirm Rejection",
              })
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
  const { locale, tx, formatDateTime } = useLocale();
  const { actor, authGeneration, handleAccessChanged } = useSession();

  const kindMeta = useMemo(() => getAssuranceKindMeta(locale), [locale]);

  const grantedKinds = useMemo(() => {
    if (!actor) return [] as AssuranceKind[];
    const pool: AssuranceKind[] = fixedKinds ?? [
      "purchase",
      "incoming_quality",
      "contract",
    ];
    return pool.filter((k) => actor.grants.includes(ASSURANCE_KIND_GRANTS[k]));
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
  const [refreshTick, setRefreshTick] = useState(0);

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
      <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5">
        <AccessNoticeCard
          variant="ACCESS_RESTRICTED"
          title={tx({
            "zh-CN": "未开通受控治理预审权限",
            "zh-HK": "未開通受控治理預審權限",
            en: "Assurance Access Not Granted",
          })}
          message={tx({
            "zh-CN": "当前账号不具备采购、来料质检或合同法务预审权限。",
            "zh-HK": "目前帳號不具備採購、來料質檢或合約法務預審權限。",
            en: "Your account does not hold purchase, incoming quality, or contract assurance grants.",
          })}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="workbench-assurance-module">
      {/* Kind Selector Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] px-5 py-3.5">
        <div
          role="tablist"
          aria-label={tx({
            "zh-CN": "预审案件类别",
            "zh-HK": "預審案件類別",
            en: "Assurance case categories",
          })}
          className="inline-flex flex-wrap items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] p-1"
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
                  "h-8 rounded-full px-3.5 text-[12.5px] transition-all duration-[165ms] cursor-pointer",
                  active
                    ? "bg-[var(--bg-surface)] text-[var(--accent-ink)] font-semibold shadow-[var(--shadow-subtle)]"
                    : "text-[var(--ink-secondary)] font-medium hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                {kindMeta[kind].label}
              </button>
            );
          })}
        </div>

        <Button
          size="sm"
          pill
          variant="secondary"
          loading={loading}
          onClick={() => {
            void loadCases(activeKind);
            setRefreshTick((n) => n + 1);
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>
            {tx({
              "zh-CN": "刷新案件",
              "zh-HK": "重新整理案件",
              en: "Refresh Cases",
            })}
          </span>
        </Button>
      </div>

      {/* Graceful Unavailable Banner when Assurance is disabled on backend (404 / 503) */}
      {unavailable && (
        <div className="space-y-4" data-testid="assurance-unavailable-notice">
          <div
            role="status"
            className="flex items-start gap-3 rounded-card bg-[var(--status-amber-wash)] p-5 text-[13px] text-[var(--status-amber-ink)]"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[var(--status-amber)] shadow-[var(--shadow-subtle)]">
              <ShieldAlert className="h-4 w-4" strokeWidth={1.85} />
            </span>
            <div className="space-y-1">
              <div className="font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "受控治理预审未在当前后端进程启用",
                  "zh-HK": "受控治理預審未於目前後端程序啟用",
                  en: "Governed Assurance Disabled on Backend",
                })}
              </div>
              <p className="text-[12.5px] leading-relaxed text-[var(--ink-secondary)]">
                {tx({
                  "zh-CN":
                    "当前后端进程未配置受控预审连接器（预审接口返回 503/404）。如需体验真实多轨审批，请在启动脚本中启用受控预审配置。",
                  "zh-HK":
                    "目前後端程序未設定受控預審連接器（預審介面回傳 503/404）。如需體驗真實多軌審批，請於啟動指令碼中啟用受控預審設定。",
                  en: "The assurance connector is not configured on this backend (returned 503/404). Enable assurance in the launch configuration for live multi-track reviews.",
                })}
              </p>
            </div>
          </div>

          {/* Clearly Tagged Synthetic Preview Card */}
          <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <h3 className="text-[14px] font-semibold text-[var(--ink-primary)]">
                  {tx({
                    "zh-CN": "受控多轨预审结构示意",
                    "zh-HK": "受控多軌預審結構示意",
                    en: "Multi-Track Assurance Preview",
                  })}
                </h3>
                <SourceTag source="synthetic" />
              </div>
              <span className="text-[12px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "仅示意界面结构，非实时后端数据",
                  "zh-HK": "僅示意介面結構，非即時後端資料",
                  en: "Illustrative layout only — not live backend data",
                })}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3.5 p-5 sm:grid-cols-3 text-[12.5px]">
              <div className="rounded-tile bg-[var(--bg-surface-tint)] p-4 space-y-1.5">
                <div className="font-semibold text-[var(--ink-primary)]">
                  <span className="font-mono-code">PO-100</span>
                  {" · "}
                  {tx({
                    "zh-CN": "采购预审",
                    "zh-HK": "採購預審",
                    en: "Purchase Review",
                  })}{" "}
                  <span className="font-mono-code font-normal text-[var(--ink-muted)]">
                    (HK01)
                  </span>
                </div>
                <p className="text-[var(--ink-muted)] leading-relaxed">
                  {tx({
                    "zh-CN":
                      "财务角色可见受限字段供应商收款账户；路由至采购轨与财务轨独立双轨决策。",
                    "zh-HK":
                      "財務角色可見受限欄位供應商收款帳戶；路由至採購軌與財務軌獨立雙軌決策。",
                    en: "Finance role sees restricted supplier banking details; routed to independent Procurement + Finance tracks.",
                  })}
                </p>
              </div>
              <div className="rounded-tile bg-[var(--bg-surface-tint)] p-4 space-y-1.5">
                <div className="font-semibold text-[var(--ink-primary)]">
                  <span className="font-mono-code">QA-200</span>
                  {" · "}
                  {tx({
                    "zh-CN": "来料质检",
                    "zh-HK": "來料質檢",
                    en: "Incoming Quality",
                  })}{" "}
                  <span className="font-mono-code font-normal text-[var(--ink-muted)]">
                    (HK01)
                  </span>
                </div>
                <p className="text-[var(--ink-muted)] leading-relaxed">
                  {tx({
                    "zh-CN":
                      "质检角色可见质检员联系方式；命中致命缺陷时自动进入硬性留置状态。",
                    "zh-HK":
                      "質檢角色可見質檢員聯絡方式；命中重大缺陷時自動進入強制留置狀態。",
                    en: "Quality role sees inspector contact details; critical defects automatically trigger a hard HELD state.",
                  })}
                </p>
              </div>
              <div className="rounded-tile bg-[var(--bg-surface-tint)] p-4 space-y-1.5">
                <div className="font-semibold text-[var(--ink-primary)]">
                  <span className="font-mono-code">CT-300</span>
                  {" · "}
                  {tx({
                    "zh-CN": "合同法务",
                    "zh-HK": "合約法務",
                    en: "Contract Review",
                  })}{" "}
                  <span className="font-mono-code font-normal text-[var(--ink-muted)]">
                    (HK01)
                  </span>
                </div>
                <p className="text-[var(--ink-muted)] leading-relaxed">
                  {tx({
                    "zh-CN":
                      "法务角色可见对方签约法务联系；非标模板与自动续约触发法务与采购双轨。",
                    "zh-HK":
                      "法務角色可見對方簽約法務聯絡；非標範本與自動續約觸發法務與採購雙軌。",
                    en: "Legal role sees counterparty counsel details; non-standard terms & auto-renewal route to Legal + Procurement.",
                  })}
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
          <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden self-start">
            <div className="flex items-center justify-between border-b border-[var(--hairline)] px-4.5 py-3.5">
              <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "预审案件列表",
                  "zh-HK": "預審案件清單",
                  en: "Assurance Cases",
                })}
                <span className="ml-1.5 tabular-nums text-[12px] font-normal text-[var(--ink-muted)]">
                  ({cases.length})
                </span>
              </span>
              <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--ink-secondary)]">
                {kindMeta[activeKind].shortLabel}
              </span>
            </div>

            {loading && cases.length === 0 ? (
              <div className="py-12 text-center text-[12.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "正在加载案件列表…",
                  "zh-HK": "正在載入案件清單…",
                  en: "Loading cases…",
                })}
              </div>
            ) : cases.length === 0 ? (
              <div className="py-12 text-center text-[12.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "当前分类与仓库范围内暂无预审案件",
                  "zh-HK": "目前分類與倉庫範圍內暫無預審案件",
                  en: "No cases found in this category and warehouse scope",
                })}
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {cases.map((item) => {
                  const selected = selectedRef === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`assurance-case-row-${item.id}`}
                      aria-current={selected ? "true" : undefined}
                      onClick={() => setSelectedRef(item.id)}
                      className={[
                        "w-full rounded-sm px-3 py-2.5 text-left transition-all duration-[150ms] cursor-pointer",
                        selected
                          ? "bg-[var(--accent-wash)] ring-1 ring-[var(--accent-border)]"
                          : "hover:bg-[var(--bg-surface-tint)]",
                      ].join(" ")}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={[
                            "font-mono-code text-[13px] font-semibold",
                            selected
                              ? "text-[var(--accent-ink)]"
                              : "text-[var(--ink-primary)]",
                          ].join(" ")}
                        >
                          {item.id}
                        </span>
                        <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
                          {item.site}
                        </span>
                      </div>
                      <div className="mt-0.5 font-mono-code tabular-nums text-[11px] text-[var(--ink-muted)]">
                        {item.submitted_at
                          ? formatDateTime(item.submitted_at)
                          : item.revision}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {nextAfter && (
              <div className="border-t border-[var(--hairline-subtle)] p-3 text-center">
                <Button
                  size="sm"
                  pill
                  variant="secondary"
                  loading={loadingMore}
                  onClick={() => void handleLoadMore()}
                >
                  {tx({
                    "zh-CN": "加载更多案件",
                    "zh-HK": "載入更多案件",
                    en: "Load More Cases",
                  })}
                </Button>
              </div>
            )}
          </div>

          {/* Case Detail & Multi-Track Review Workspace */}
          <div className="min-w-0">
            {selectedRef ? (
              <AssuranceCaseInspector
                reference={selectedRef}
                hideRefresh
                refreshSignal={refreshTick}
              />
            ) : (
              <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-10 text-center text-[13px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "请从左侧选择一条案件以按需加载字段投影与预审决策。",
                  "zh-HK": "請從左側選擇一筆案件以按需載入欄位投影與預審決策。",
                  en: "Select a case on the left to load role-projected fields and multi-track reviews.",
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
