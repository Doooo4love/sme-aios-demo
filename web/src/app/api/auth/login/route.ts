import { NextRequest } from "next/server";
import { z } from "zod";
import {
  getDemoLoginPassword,
  isDemoAuthEnabled,
  isOidcLoginEnabled,
  isValidBrowserOrigin,
  makeOriginRejectedResponse,
} from "@/lib/bff/config";
import {
  clearLoginFailures,
  exchangeDemoSession,
  getRateLimitClientKey,
  isLoginRateLimited,
  recordLoginFailure,
  verifyPasswordConstantTime,
} from "@/lib/bff/demo-auth";
import { resolveEnterpriseAccountAlias } from "@/lib/bff/directory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EnterpriseLoginSchema = z
  .object({
    username: z.string().trim().min(1, "请输入企业账号或邮箱").max(128),
    password: z.string().min(1, "请输入登录密码").max(128),
  })
  .strict();

function jsonResponse(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  // 1. Strict Origin boundary first
  if (!isValidBrowserOrigin(req)) {
    return makeOriginRejectedResponse();
  }

  // 2. Mode check: password login only active when controlled demo auth is enabled
  if (!isDemoAuthEnabled()) {
    if (isOidcLoginEnabled()) {
      return jsonResponse(
        {
          detail: {
            code: "PASSWORD_LOGIN_UNAVAILABLE",
            message: "当前环境已启用企业单点登录，请使用企业 OIDC 登录。",
          },
        },
        403,
      );
    }
    return jsonResponse(
      {
        detail: {
          code: "DEMO_AUTH_DISABLED",
          message: "当前环境未启用本地账号密码登录。",
        },
      },
      404,
    );
  }

  // 3. Parse & strict Zod validation
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse(
      {
        detail: {
          code: "INVALID_REQUEST",
          message: "请输入有效的企业账号与密码。",
        },
      },
      422,
    );
  }

  const parsed = EnterpriseLoginSchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonResponse(
      {
        detail: {
          code: "INVALID_REQUEST",
          message: "请输入有效的企业账号与密码。",
        },
      },
      422,
    );
  }

  const normalizedUsername = parsed.data.username.trim().toLowerCase();
  const rateLimitKey = getRateLimitClientKey(req, normalizedUsername);

  // 4. Sliding-window brute-force guard
  if (isLoginRateLimited(rateLimitKey)) {
    return jsonResponse(
      {
        detail: {
          code: "LOGIN_RATE_LIMITED",
          message: "登录失败次数过多，请 1 分钟后再试。",
        },
      },
      429,
      { "Retry-After": "60" },
    );
  }

  const expectedPassword = getDemoLoginPassword();
  if (!expectedPassword) {
    return jsonResponse(
      {
        detail: {
          code: "DEMO_AUTH_DISABLED",
          message: "当前环境未启用本地账号密码登录。",
        },
      },
      404,
    );
  }

  // 5. Constant-time password & account check (anti-enumeration)
  const subject = resolveEnterpriseAccountAlias(parsed.data.username);
  const passwordOk = verifyPasswordConstantTime(parsed.data.password, expectedPassword);

  if (!subject || !passwordOk) {
    recordLoginFailure(rateLimitKey);
    return jsonResponse(
      {
        detail: {
          code: "INVALID_CREDENTIALS",
          message: "账号或密码不正确，请核对后重试。",
        },
      },
      401,
    );
  }

  // 6. Clear failure bucket & exchange for real FastAPI HttpOnly session cookie + CSRF token
  clearLoginFailures(rateLimitKey);
  return exchangeDemoSession(req, subject);
}
