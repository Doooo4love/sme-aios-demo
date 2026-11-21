import { NextRequest } from "next/server";
import { proxyToAios } from "@/lib/bff/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  return proxyToAios(req, "/healthz", { allowPublicHealth: true });
}
