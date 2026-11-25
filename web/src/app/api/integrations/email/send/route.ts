import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  getApiBaseUrl,
  getBrowserOrigin,
  isValidBrowserOrigin,
  makeOriginRejectedResponse,
} from "@/lib/bff/config";
import { resolveTenantContacts, verifyLiveActor } from "@/lib/bff/directory";
import { sanitizeErrorPayload } from "@/lib/bff/sanitize";
import {
  LOCALE_COOKIE_NAME,
  normalizeLocale,
  type Locale,
} from "@/lib/i18n";
import {
  MAX_EMAIL_RECIPIENTS,
  containsSensitiveSecret,
  getEmailConnectorMode,
  hasEmailHeaderInjection,
  isEmailConfigured,
  normalizeAndValidateEmail,
  parseNaturalLanguageEmail,
  sendEmailViaConnector,
} from "@/lib/mcp/email-connector";
import type {
  EmailOutboxReceipt,
  EmailParseResponse,
  EmailSendResponse,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ParseEmailSchema = z.object({
  action: z.literal("parse"),
  utterance: z.string().trim().min(1, "请输入邮件描述").max(1000),
  locale: z.enum(["zh-CN", "zh-HK", "en"]).optional(),
});

const SendEmailSchema = z.object({
  action: z.literal("send"),
  client_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "无效的请求幂等标识"),
  to: z
    .array(z.string().trim().min(3).max(254))
    .min(1, "请至少填写一位收件人")
    .max(MAX_EMAIL_RECIPIENTS, "收件人数量超过上限"),
  cc: z
    .array(z.string().trim().min(3).max(254))
    .max(MAX_EMAIL_RECIPIENTS)
    .optional(),
  subject: z
    .string()
    .trim()
    .min(1, "请填写邮件主题")
    .max(200, "邮件主题不能超过 200 个字符"),
  body: z
    .string()
    .trim()
    .min(1, "请填写邮件正文")
    .max(20_000, "邮件正文不能超过 20000 个字符"),
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function sha256Buf(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

const VALID_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const VALID_TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function buildTraceHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const reqId = req.headers.get("x-request-id")?.trim() ?? "";
  if (VALID_REQUEST_ID_RE.test(reqId)) {
    headers["X-Request-ID"] = reqId;
  }
  const tp = req.headers.get("traceparent")?.trim() ?? "";
  if (VALID_TRACEPARENT_RE.test(tp)) {
    headers.traceparent = tp;
  }
  return headers;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildReserveConflictDetail(
  parsed: unknown,
  locale: Locale,
): { code: string; message: string } {
  const rawDetail = isPlainRecord(parsed) ? parsed.detail : parsed;
  const code =
    isPlainRecord(rawDetail) && typeof rawDetail.code === "string"
      ? rawDetail.code
      : "";
  const rawMsg =
    isPlainRecord(rawDetail) && typeof rawDetail.message === "string"
      ? rawDetail.message
      : typeof rawDetail === "string"
        ? rawDetail
        : "";

  if (
    code === "IDEMPOTENCY_CONFLICT" ||
    rawMsg.includes("different request payload")
  ) {
    return {
      code: "IDEMPOTENCY_CONFLICT",
      message:
        locale === "en"
          ? "This email request ID is already bound to a different message payload."
          : locale === "zh-HK"
            ? "此郵件請求編號已綁定至另一封郵件內容。"
            : "此邮件请求标识已绑定至另一封邮件内容。",
    };
  }
  if (code === "OUTCOME_UNKNOWN" || rawMsg.includes("UNKNOWN")) {
    return {
      code: "OUTCOME_UNKNOWN",
      message:
        locale === "en"
          ? "Previous email dispatch outcome is UNKNOWN; manual verification is required before retry."
          : locale === "zh-HK"
            ? "上次郵件派發結果未知，須人工核實後再重試。"
            : "上次邮件发送结果未知，需人工核实后再重试。",
    };
  }
  return {
    code: "DISPATCH_IN_PROGRESS",
    message:
      locale === "en"
        ? "This email dispatch is already in progress."
        : locale === "zh-HK"
          ? "此郵件發送請求正在處理中，請勿重複提交。"
          : "该邮件发送请求正在处理中，请勿重复提交。",
  };
}

interface OutboxReserveSuccess {
  status: "reserved" | "replay";
  outbox_id: string;
  attempt: number;
  cached_result: unknown;
}

async function reserveExternalOutbox(params: {
  apiBase: string;
  browserOrigin: string;
  cookie: string;
  csrfToken: string;
  traceHeaders: Record<string, string>;
  clientId: string;
  requestSha256: string;
  locale: Locale;
}): Promise<
  | { ok: true; data: OutboxReserveSuccess }
  | { ok: false; response: Response }
> {
  let res: Response;
  try {
    res = await fetch(
      `${params.apiBase}/v1/workbench/external-outbox/reserve`,
      {
        method: "POST",
        headers: {
          Cookie: params.cookie,
          "X-CSRF-Token": params.csrfToken,
          Origin: params.browserOrigin,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...params.traceHeaders,
        },
        body: JSON.stringify({
          action_kind: "email.send",
          client_id: params.clientId,
          request_sha256: params.requestSha256,
          lease_s: 60,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      },
    );
  } catch {
    return {
      ok: false,
      response: jsonResponse(
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message:
              params.locale === "en"
                ? "Outbox reservation service is temporarily unavailable."
                : params.locale === "zh-HK"
                  ? "發件預約服務暫不可用，請稍後重試。"
                  : "发件预留服务暂不可用，请稍后重试。",
          },
        },
        503,
      ),
    };
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (res.status === 409) {
    return {
      ok: false,
      response: jsonResponse(
        { detail: buildReserveConflictDetail(parsed, params.locale) },
        409,
      ),
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      response: jsonResponse(sanitizeErrorPayload(res.status, parsed), res.status),
    };
  }

  if (!isPlainRecord(parsed) || typeof parsed.outbox_id !== "string") {
    return {
      ok: false,
      response: jsonResponse(
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "发件预留响应无效，请稍后重试。",
          },
        },
        503,
      ),
    };
  }

  return {
    ok: true,
    data: {
      status: parsed.status === "replay" ? "replay" : "reserved",
      outbox_id: parsed.outbox_id,
      attempt: typeof parsed.attempt === "number" ? parsed.attempt : 1,
      cached_result: parsed.cached_result ?? null,
    },
  };
}

async function finalizeExternalOutbox(params: {
  apiBase: string;
  browserOrigin: string;
  cookie: string;
  csrfToken: string;
  traceHeaders: Record<string, string>;
  outboxId: string;
  state: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  externalId?: string | null;
  result?: Record<string, unknown> | null;
}): Promise<boolean> {
  try {
    const res = await fetch(
      `${params.apiBase}/v1/workbench/external-outbox/${encodeURIComponent(params.outboxId)}/finalize`,
      {
        method: "POST",
        headers: {
          Cookie: params.cookie,
          "X-CSRF-Token": params.csrfToken,
          Origin: params.browserOrigin,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...params.traceHeaders,
        },
        body: JSON.stringify({
          state: params.state,
          external_id: params.externalId ?? null,
          result: params.result ?? null,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function verifySessionCsrf(
  apiBase: string,
  cookie: string,
  presentedCsrf: string,
  traceHeaders: Record<string, string>,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  let sessionRes: Response;
  try {
    sessionRes = await fetch(`${apiBase}/v1/session`, {
      method: "GET",
      headers: {
        Cookie: cookie,
        Accept: "application/json",
        ...traceHeaders,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return {
      ok: false,
      response: jsonResponse(
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "会话服务暂不可用，请稍后重试。",
          },
        },
        503,
      ),
    };
  }

  if (!sessionRes.ok) {
    const raw = await sessionRes.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }
    return {
      ok: false,
      response: jsonResponse(
        sanitizeErrorPayload(sessionRes.status, parsed),
        sessionRes.status,
      ),
    };
  }

  const sessionData = (await sessionRes.json()) as { csrf_token?: unknown };
  const expectedCsrf =
    typeof sessionData.csrf_token === "string" ? sessionData.csrf_token : "";

  if (
    !expectedCsrf ||
    !timingSafeEqual(sha256Buf(presentedCsrf), sha256Buf(expectedCsrf))
  ) {
    return {
      ok: false,
      response: jsonResponse(
        {
          detail: {
            code: "CSRF_REJECTED",
            message: "安全校验令牌无效，请重试。",
          },
        },
        403,
      ),
    };
  }

  return { ok: true };
}

async function findExistingOutboxReceipt(
  apiBase: string,
  cookie: string,
  clientId: string,
): Promise<EmailOutboxReceipt | null> {
  try {
    const res = await fetch(`${apiBase}/v1/workbench/email-outbox`, {
      method: "GET",
      headers: {
        Cookie: cookie,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as
      | { items?: EmailOutboxReceipt[] }
      | EmailOutboxReceipt[];
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : [];
    return items.find((item) => item.client_id === clientId) ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isValidBrowserOrigin(req)) {
    return makeOriginRejectedResponse();
  }

  const verified = await verifyLiveActor(req);
  if (!verified.ok) {
    return verified.response;
  }

  const { actor, cookie } = verified;
  const cookieLocale: Locale = normalizeLocale(
    req.cookies.get(LOCALE_COOKIE_NAME)?.value,
  );

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse(
      { detail: { code: "INVALID_REQUEST", message: "请求体格式无效。" } },
      422,
    );
  }

  const action =
    typeof rawBody === "object" && rawBody !== null && "action" in rawBody
      ? (rawBody as { action?: unknown }).action
      : null;

  // =========================================================================
  // Phase 1: Natural-Language Email Parsing (Zero Side Effects)
  // =========================================================================
  if (action === "parse") {
    const parsed = ParseEmailSchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse(
        {
          detail: {
            code: "INVALID_REQUEST",
            message:
              parsed.error.issues[0]?.message || "请输入有效的邮件草稿描述。",
          },
        },
        422,
      );
    }

    const effectiveLocale: Locale = parsed.data.locale ?? cookieLocale;
    const directory = await resolveTenantContacts(actor, cookie, {
      includeSelf: false,
      limit: 50,
      locale: effectiveLocale,
    });

    const draft = parseNaturalLanguageEmail(
      parsed.data.utterance,
      directory.items,
      effectiveLocale,
    );

    const responsePayload: EmailParseResponse = {
      phase: "preview",
      draft,
      transport_mode_preview: getEmailConnectorMode(),
      email_configured: isEmailConfigured(),
    };

    return jsonResponse(responsePayload, 200);
  }

  // =========================================================================
  // Phase 2: Explicit Confirmation, Security Checks, Dispatch & Audit Receipt
  // =========================================================================
  if (action === "send") {
    const csrfToken = req.headers.get("x-csrf-token");
    if (!csrfToken || !csrfToken.trim()) {
      return jsonResponse(
        {
          detail: {
            code: "CSRF_REJECTED",
            message: "安全校验令牌缺失，请重试。",
          },
        },
        403,
      );
    }

    const parsed = SendEmailSchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse(
        {
          detail: {
            code: "INVALID_REQUEST",
            message:
              parsed.error.issues[0]?.message || "邮件参数格式不符合要求。",
          },
        },
        422,
      );
    }

    const data = parsed.data;
    if (hasEmailHeaderInjection(data.subject)) {
      return jsonResponse(
        {
          detail: {
            code: "EMAIL_POLICY_VIOLATION",
            message:
              cookieLocale === "en"
                ? "Email subject must not contain CR/LF or control characters."
                : cookieLocale === "zh-HK"
                  ? "電郵主題不可包含換行或控制字元。"
                  : "邮件主题不能包含换行或控制字符。",
          },
        },
        422,
      );
    }

    if (data.body.includes("\x00")) {
      return jsonResponse(
        {
          detail: {
            code: "EMAIL_POLICY_VIOLATION",
            message: "邮件正文包含非法空字节。",
          },
        },
        422,
      );
    }

    const seen = new Set<string>();
    const normalizedTo: string[] = [];
    for (const rawAddr of data.to) {
      const addr = normalizeAndValidateEmail(rawAddr);
      if (!addr) {
        return jsonResponse(
          {
            detail: {
              code: "INVALID_EMAIL",
              message:
                cookieLocale === "en"
                  ? "One or more recipient email addresses are invalid."
                  : cookieLocale === "zh-HK"
                    ? "收件人電郵地址格式不正確或包含非法字元。"
                    : "收件人邮箱格式不正确或包含非法字符。",
            },
          },
          422,
        );
      }
      const lower = addr.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        normalizedTo.push(addr);
      }
    }

    const normalizedCc: string[] = [];
    for (const rawAddr of data.cc ?? []) {
      const addr = normalizeAndValidateEmail(rawAddr);
      if (!addr) {
        return jsonResponse(
          {
            detail: {
              code: "INVALID_EMAIL",
              message:
                cookieLocale === "en"
                  ? "One or more CC email addresses are invalid."
                  : cookieLocale === "zh-HK"
                    ? "副本收件人電郵地址格式不正確或包含非法字元。"
                    : "抄送人邮箱格式不正确或包含非法字符。",
            },
          },
          422,
        );
      }
      const lower = addr.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        normalizedCc.push(addr);
      }
    }

    if (
      normalizedTo.length === 0 ||
      normalizedTo.length + normalizedCc.length > MAX_EMAIL_RECIPIENTS
    ) {
      return jsonResponse(
        {
          detail: {
            code: "EMAIL_POLICY_VIOLATION",
            message:
              cookieLocale === "en"
                ? "Total recipients (To + CC) must be between 1 and 10."
                : cookieLocale === "zh-HK"
                  ? "單封電郵收件人與副本總數須在 1 至 10 人之間。"
                  : "单封邮件收件人与抄送人总数需在 1 至 10 人之间。",
          },
        },
        422,
      );
    }

    const apiBase = getApiBaseUrl();
    const browserOrigin = getBrowserOrigin();
    const traceHeaders = buildTraceHeaders(req);

    // Verify CSRF against FastAPI BEFORE checking secrets/idempotency/sending mail
    const csrfCheck = await verifySessionCsrf(
      apiBase,
      cookie,
      csrfToken.trim(),
      traceHeaders,
    );
    if (!csrfCheck.ok) {
      return csrfCheck.response;
    }

    const cleanSubject = data.subject.trim();
    const cleanBody = data.body
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
    const bodyPreview =
      cleanBody.length > 240 ? `${cleanBody.slice(0, 237)}...` : cleanBody;
    const bodySha256 = createHash("sha256")
      .update(cleanBody, "utf8")
      .digest("hex");

    // Never dispatch external email if content contains potential secrets/passcodes.
    // Still forward to FastAPI /v1/workbench/email-outbox so the security event is logged & admins alerted.
    if (
      containsSensitiveSecret(cleanSubject) ||
      containsSensitiveSecret(cleanBody)
    ) {
      try {
        const guardRes = await fetch(`${apiBase}/v1/workbench/email-outbox`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "X-CSRF-Token": csrfToken.trim(),
            Origin: browserOrigin,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...traceHeaders,
          },
          body: JSON.stringify({
            client_id: data.client_id,
            recipients: normalizedTo,
            cc: normalizedCc,
            subject_line: cleanSubject,
            body: cleanBody,
            body_preview: bodyPreview,
            body_sha256: bodySha256,
            transport_mode: "blocked",
            message_id: "<blocked@theodic.local>",
            delivery_status: "blocked",
            internal_recipient_subjects: [],
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        });
        const guardText = await guardRes.text();
        let guardParsed: unknown = null;
        try {
          guardParsed = guardText ? JSON.parse(guardText) : null;
        } catch {
          guardParsed = guardText;
        }
        if (!guardRes.ok) {
          return jsonResponse(
            sanitizeErrorPayload(guardRes.status, guardParsed),
            guardRes.status,
          );
        }
      } catch {
        // Fall through to deterministic 403 block below
      }
      return jsonResponse(
        {
          detail: {
            code: "EMAIL_POLICY_VIOLATION",
            message:
              cookieLocale === "en"
                ? "Email blocked: potential API key, token, passcode, or internal credential detected."
                : cookieLocale === "zh-HK"
                  ? "郵件已被攔截：偵測到疑似密鑰、令牌或內部憑證。"
                  : "邮件已被拦截：检测到疑似密钥、令牌或内部凭据。",
          },
        },
        403,
      );
    }

    // Reserve-first atomic external outbox BEFORE calling SMTP/MCP!
    const canonicalRequestPayload = JSON.stringify({
      body: cleanBody,
      cc: normalizedCc,
      recipients: normalizedTo,
      subject: cleanSubject,
    });
    const requestSha256 = createHash("sha256")
      .update(canonicalRequestPayload, "utf8")
      .digest("hex");

    const reservation = await reserveExternalOutbox({
      apiBase,
      browserOrigin,
      cookie,
      csrfToken: csrfToken.trim(),
      traceHeaders,
      clientId: data.client_id,
      requestSha256,
      locale: cookieLocale,
    });
    if (!reservation.ok) {
      return reservation.response;
    }

    if (reservation.data.status === "replay") {
      if (
        isPlainRecord(reservation.data.cached_result) &&
        Object.keys(reservation.data.cached_result).length > 0
      ) {
        return jsonResponse(reservation.data.cached_result, 200);
      }
      const fallbackReceipt = await findExistingOutboxReceipt(
        apiBase,
        cookie,
        data.client_id,
      );
      if (fallbackReceipt) {
        const idempotentPayload: EmailSendResponse = {
          phase: "sent",
          receipt: fallbackReceipt,
          transport_mode: fallbackReceipt.transport_mode,
          message_id: fallbackReceipt.message_id,
          delivery_status: fallbackReceipt.delivery_status,
          accepted: [...fallbackReceipt.recipients, ...fallbackReceipt.cc],
          rejected: [],
          warnings: [],
        };
        return jsonResponse(idempotentPayload, 200);
      }
      return jsonResponse(
        { phase: "sent", outbox_id: reservation.data.outbox_id },
        200,
      );
    }

    const outboxId = reservation.data.outbox_id;

    // Resolve tenant colleagues whose emails appear in To/CC for internal notices & SSE push
    let internalRecipientSubjects: string[] = [];
    try {
      const directory = await resolveTenantContacts(actor, cookie, {
        includeSelf: false,
        limit: 50,
        locale: cookieLocale,
      });
      const contactByEmail = new Map(
        directory.items.map((item) => [item.email.toLowerCase(), item]),
      );
      const seenSubjects = new Set<string>();
      for (const addr of [...normalizedTo, ...normalizedCc]) {
        const match = contactByEmail.get(addr.toLowerCase());
        if (
          match &&
          match.subject !== actor.subject &&
          !seenSubjects.has(match.subject)
        ) {
          seenSubjects.add(match.subject);
        }
      }
      internalRecipientSubjects = Array.from(seenSubjects);
    } catch {
      internalRecipientSubjects = [];
    }

    let dispatchResult: Awaited<ReturnType<typeof sendEmailViaConnector>>;
    try {
      dispatchResult = await sendEmailViaConnector(
        {
          to: normalizedTo,
          cc: normalizedCc,
          subject: cleanSubject,
          body: cleanBody,
          senderSubject: actor.subject,
          senderTenant: actor.tenant,
          internalRecipientCount: internalRecipientSubjects.length,
        },
        cookieLocale,
      );
    } catch (err) {
      const isDeterministicPreDispatch =
        isPlainRecord(err) && err.preDispatch === true;
      await finalizeExternalOutbox({
        apiBase,
        browserOrigin,
        cookie,
        csrfToken: csrfToken.trim(),
        traceHeaders,
        outboxId,
        state: isDeterministicPreDispatch ? "FAILED" : "UNKNOWN",
      });
      return jsonResponse(
        {
          detail: {
            code: isDeterministicPreDispatch
              ? "EMAIL_DISPATCH_FAILED"
              : "OUTCOME_UNKNOWN",
            message: isDeterministicPreDispatch
              ? cookieLocale === "en"
                ? "Email dispatch failed before transport."
                : "邮件发送前校验失败，未发出。"
              : cookieLocale === "en"
                ? "Email transport failed with an uncertain outcome; manual verification is required before retry."
                : "邮件传输发生超时或网络异常，发送结果未知，需人工核实后再重试。",
          },
        },
        isDeterministicPreDispatch ? 422 : 503,
      );
    }

    let persistRes: Response;
    try {
      persistRes = await fetch(`${apiBase}/v1/workbench/email-outbox`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": csrfToken.trim(),
          Origin: browserOrigin,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...traceHeaders,
        },
        body: JSON.stringify({
          client_id: data.client_id,
          recipients: normalizedTo,
          cc: normalizedCc,
          subject_line: cleanSubject,
          body: cleanBody,
          body_preview: bodyPreview,
          body_sha256: bodySha256,
          transport_mode: dispatchResult.transport_mode,
          message_id: dispatchResult.message_id,
          delivery_status: dispatchResult.delivery_status,
          internal_recipient_subjects: internalRecipientSubjects,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      await finalizeExternalOutbox({
        apiBase,
        browserOrigin,
        cookie,
        csrfToken: csrfToken.trim(),
        traceHeaders,
        outboxId,
        state: "UNKNOWN",
        externalId: dispatchResult.message_id,
      });
      return jsonResponse(
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "邮件审计留痕服务暂不可用，结果已标记为 UNKNOWN，请核实后重试。",
          },
        },
        503,
      );
    }

    const persistText = await persistRes.text();
    let persistParsed: unknown = null;
    try {
      persistParsed = persistText ? JSON.parse(persistText) : null;
    } catch {
      persistParsed = persistText;
    }

    if (!persistRes.ok) {
      const sentExternally = dispatchResult.transport_mode !== "governed_outbox";
      await finalizeExternalOutbox({
        apiBase,
        browserOrigin,
        cookie,
        csrfToken: csrfToken.trim(),
        traceHeaders,
        outboxId,
        state: persistRes.status >= 500 || sentExternally ? "UNKNOWN" : "FAILED",
        externalId: dispatchResult.message_id,
      });
      return jsonResponse(
        sanitizeErrorPayload(persistRes.status, persistParsed),
        persistRes.status,
      );
    }

    const receipt = persistParsed as EmailOutboxReceipt;
    const responsePayload: EmailSendResponse = {
      phase: "sent",
      receipt,
      transport_mode: receipt.transport_mode ?? dispatchResult.transport_mode,
      message_id: receipt.message_id ?? dispatchResult.message_id,
      delivery_status:
        receipt.delivery_status ?? dispatchResult.delivery_status,
      accepted: dispatchResult.accepted,
      rejected: dispatchResult.rejected,
      warnings: dispatchResult.warnings,
    };

    const finalized = await finalizeExternalOutbox({
      apiBase,
      browserOrigin,
      cookie,
      csrfToken: csrfToken.trim(),
      traceHeaders,
      outboxId,
      state: "SUCCEEDED",
      externalId: responsePayload.message_id,
      result: responsePayload as unknown as Record<string, unknown>,
    });
    if (!finalized) {
      await finalizeExternalOutbox({
        apiBase,
        browserOrigin,
        cookie,
        csrfToken: csrfToken.trim(),
        traceHeaders,
        outboxId,
        state: "UNKNOWN",
        externalId: responsePayload.message_id,
      });
      return jsonResponse(
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "发件回执落库确认失败，已锁定防止重复发送。",
          },
        },
        503,
      );
    }

    return jsonResponse(responsePayload, 201);
  }

  return jsonResponse(
    {
      detail: {
        code: "INVALID_REQUEST",
        message: "不支持的操作类型，请使用 parse 或 send。",
      },
    },
    422,
  );
}
