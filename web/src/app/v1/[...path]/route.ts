import { NextRequest } from "next/server";
import { isAllowedV1Segments, proxyToAios } from "@/lib/bff/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

async function handle(req: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  if (!isAllowedV1Segments(path)) {
    return new Response(
      JSON.stringify({
        detail: {
          code: "RECORD_UNAVAILABLE",
          message: "当前账号无法访问这条记录。",
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

  const normalizedPath = `/v1/${path.map(encodeURIComponent).join("/")}`;
  return proxyToAios(req, normalizedPath);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
