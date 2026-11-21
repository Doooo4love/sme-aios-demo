import { NextRequest } from "next/server";
import { z } from "zod";
import {
  DEMO_PERSONA_SET,
  isDemoAuthEnabled,
  isValidBrowserOrigin,
  makeOriginRejectedResponse,
} from "@/lib/bff/config";
import { exchangeDemoSession } from "@/lib/bff/demo-auth";
import type { DemoPersonaId } from "@/lib/types";

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

  return exchangeDemoSession(req, persona as DemoPersonaId);
}
