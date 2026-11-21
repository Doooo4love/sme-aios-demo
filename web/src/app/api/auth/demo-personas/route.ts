import {
  DEMO_PERSONAS,
  isDemoAuthEnabled,
  isOidcLoginEnabled,
} from "@/lib/bff/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const enabled = isDemoAuthEnabled();
  const oidcLoginEnabled = isOidcLoginEnabled();

  return new Response(
    JSON.stringify({
      enabled,
      oidc_login_enabled: oidcLoginEnabled,
      personas: enabled ? DEMO_PERSONAS : [],
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}
