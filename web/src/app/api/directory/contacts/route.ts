import { NextRequest } from "next/server";
import { resolveTenantContacts, verifyLiveActor } from "@/lib/bff/directory";
import { stripForbiddenKeys } from "@/lib/bff/sanitize";
import { LOCALE_COOKIE_NAME, normalizeLocale } from "@/lib/i18n/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const verified = await verifyLiveActor(req);
  if (!verified.ok) {
    return verified.response;
  }

  const locale = normalizeLocale(req.cookies.get(LOCALE_COOKIE_NAME)?.value);
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") || "").trim().slice(0, 80);
  const subject = (sp.get("subject") || "").trim().slice(0, 80) || undefined;
  const includeSelf = sp.get("include_self") === "1";
  const warehouse = (sp.get("warehouse") || "").trim().slice(0, 24) || undefined;
  const rawLimit = Number.parseInt(sp.get("limit") || "30", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(50, rawLimit))
    : 30;

  const result = await resolveTenantContacts(verified.actor, verified.cookie, {
    q: q || undefined,
    subject,
    includeSelf,
    warehouse,
    limit,
    locale,
  });

  return new Response(JSON.stringify(stripForbiddenKeys(result)), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
