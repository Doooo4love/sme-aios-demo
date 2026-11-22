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

async function verifySessionCsrf(
  apiBase: string,
  cookie: string,
  presentedCsrf: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  let sessionRes: Response;
  try {
    sessionRes = await fetch(`${apiBase}/v1/session`, {
      method: "GET",
      headers: {
        Cookie: cookie,
        Accept: "application/json",
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

    // Verify CSRF against FastAPI BEFORE checking secrets/idempotency/sending mail
    const csrfCheck = await verifySessionCsrf(
      apiBase,
      cookie,
      csrfToken.trim(),
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

    // Idempotency guard: avoid duplicate external SMTP send on repeated client_id
    const existingReceipt = (await findExistingOutboxReceipt(
      apiBase,
      cookie,
      data.client_id,
    )) as (EmailOutboxReceipt & { body_sha256?: string }) | null;
    if (existingReceipt) {
      const samePayload =
        existingReceipt.subject_line === cleanSubject &&
        (!existingReceipt.body_sha256 ||
          existingReceipt.body_sha256 === bodySha256) &&
        JSON.stringify(existingReceipt.recipients) ===
          JSON.stringify(normalizedTo) &&
        JSON.stringify(existingReceipt.cc) === JSON.stringify(normalizedCc);
      if (samePayload) {
        const idempotentPayload: EmailSendResponse = {
          phase: "sent",
          receipt: existingReceipt,
          transport_mode: existingReceipt.transport_mode,
          message_id: existingReceipt.message_id,
          delivery_status: existingReceipt.delivery_status,
          accepted: [...existingReceipt.recipients, ...existingReceipt.cc],
          rejected: [],
          warnings: [],
        };
        return jsonResponse(idempotentPayload, 200);
      }
      return jsonResponse(
        {
          detail: {
            code: "CONFLICT",
            message:
              cookieLocale === "en"
                ? "This email request ID is already bound to a different message."
                : cookieLocale === "zh-HK"
                  ? "此郵件請求編號已綁定至另一封郵件內容。"
                  : "此邮件请求标识已绑定至另一封邮件内容。",
          },
        },
        409,
      );
    }

    // Resolve tenant colleagues whose emails appear in To/CC for internal notices & SSE push
    const directory = await resolveTenantContacts(actor, cookie, {
      includeSelf: false,
      limit: 50,
      locale: cookieLocale,
    });
    const contactByEmail = new Map(
      directory.items.map((item) => [item.email.toLowerCase(), item]),
    );
    const internalRecipientSubjects: string[] = [];
    for (const addr of [...normalizedTo, ...normalizedCc]) {
      const match = contactByEmail.get(addr.toLowerCase());
      if (
        match &&
        match.subject !== actor.subject &&
        !internalRecipientSubjects.includes(match.subject)
      ) {
        internalRecipientSubjects.push(match.subject);
      }
    }

    const dispatchResult = await sendEmailViaConnector(
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
      return jsonResponse(
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "邮件审计留痕服务暂不可用，请稍后重试。",
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
