import { NextRequest } from "next/server";
import { z } from "zod";
import {
  DEMO_PERSONA_SET,
  getApiBaseUrl,
  getBrowserOrigin,
  getDemoSecret,
  isDemoAuthEnabled,
  isValidBrowserOrigin,
  makeOriginRejectedResponse,
} from "@/lib/bff/config";
import { copySetCookieHeaders } from "@/lib/bff/proxy";
import { sanitizeErrorPayload } from "@/lib/bff/sanitize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DemoLoginRequestSchema = z
  .object({
    persona: z.string().min(1).max(64).optional(),
    subject: z.string().min(1).max(64).optional(),
  })
  .refine((v) => Boolean(v.persona || v.subject), {
    message: "请选择一个演示身份。",
  });

export async function POST(req: NextRequest): Promise<Response> {
  if (!isDemoAuthEnabled()) {
    return new Response(
      JSON.stringify({
        detail: {
          code: "DEMO_AUTH_DISABLED",
          message: "当前环境未启用本地演示登录。",
        },
      }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  if (!isValidBrowserOrigin(req)) {
    return makeOriginRejectedResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        detail: {
          code: "INVALID_REQUEST",
          message: "请求体格式无效。",
        },
      }),
      {
        status: 422,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const parsed = DemoLoginRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        detail: {
          code: "INVALID_PERSONA",
          message: "请选择有效的演示身份。",
        },
      }),
      {
        status: 422,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const persona = (parsed.data.persona || parsed.data.subject || "").trim();
  if (!DEMO_PERSONA_SET.has(persona)) {
    return new Response(
      JSON.stringify({
        detail: {
          code: "INVALID_PERSONA",
          message: "不支持的演示身份。",
        },
      }),
      {
        status: 422,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const demoSecret = getDemoSecret();
  if (!demoSecret) {
    return new Response(
      JSON.stringify({
        detail: {
          code: "DEMO_AUTH_DISABLED",
          message: "当前环境未配置演示会话密钥。",
        },
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const upstreamHeaders = new Headers({
    Authorization: `Bearer ${demoSecret}.${persona}`,
    Origin: getBrowserOrigin(),
  });
  // Forward existing session cookie so upstream cleans up prior session row on switch
  const existingCookie = req.headers.get("cookie");
  if (existingCookie) {
    upstreamHeaders.set("Cookie", existingCookie);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${getApiBaseUrl()}/v1/session`, {
      method: "POST",
      headers: upstreamHeaders,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return new Response(
      JSON.stringify({
        detail: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "认证服务暂不可用，请稍后重试。",
        },
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": "2",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const outgoingHeaders = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const requestId = upstreamRes.headers.get("x-request-id");
  if (requestId) outgoingHeaders.set("X-Request-ID", requestId);
  const retryAfter = upstreamRes.headers.get("retry-after");
  if (retryAfter) outgoingHeaders.set("Retry-After", retryAfter);
  copySetCookieHeaders(upstreamRes.headers, outgoingHeaders);

  const rawText = await upstreamRes.text();
  let parsedUpstream: unknown = null;
  if (rawText) {
    try {
      parsedUpstream = JSON.parse(rawText);
    } catch {
      parsedUpstream = rawText;
    }
  }

  if (!upstreamRes.ok) {
    return new Response(
      JSON.stringify(sanitizeErrorPayload(upstreamRes.status, parsedUpstream)),
      {
        status: upstreamRes.status,
        headers: outgoingHeaders,
      },
    );
  }

  const okObj =
    typeof parsedUpstream === "object" && parsedUpstream !== null
      ? (parsedUpstream as Record<string, unknown>)
      : {};

  return new Response(
    JSON.stringify({
      csrf_token: typeof okObj.csrf_token === "string" ? okObj.csrf_token : "",
      expires_in:
        typeof okObj.expires_in === "number" ? okObj.expires_in : 900,
    }),
    {
      status: 200,
      headers: outgoingHeaders,
    },
  );
}
