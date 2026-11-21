import { NextRequest } from "next/server";
import { verifyLiveActor } from "@/lib/bff/directory";
import { getMcpConnectorsStatus } from "@/lib/mcp/connectors";
import type { McpStatusResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const verified = await verifyLiveActor(req);
  if (!verified.ok) {
    return verified.response;
  }

  const payload: McpStatusResponse = {
    tenant: verified.actor.tenant,
    ics_export_url: "/api/calendar/ics",
    connectors: getMcpConnectorsStatus(),
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
