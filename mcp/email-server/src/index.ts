#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { verifyBearerToken } from "./security.js";
import { createEmailMcpRuntime, createEmailMcpServer } from "./server.js";

const MAX_HTTP_BODY_BYTES = 262_144;
const MAX_ACTIVE_SESSIONS = 256;

interface ActiveHttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActiveAt: number;
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; message: string }> {
  const contentLengthHeader = req.headers["content-length"];
  if (contentLengthHeader) {
    const parsedLen = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
      return { ok: false, status: 413, message: "Request body exceeds limit." };
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      return { ok: false, status: 413, message: "Request body exceeds limit." };
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) {
    return { ok: true, data: undefined };
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return { ok: true, data: undefined };
  }

  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON payload." };
  }
}

async function startStdio(): Promise<void> {
  const runtime = createEmailMcpRuntime();
  const server = createEmailMcpServer(runtime);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    runtime.smtp.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await server.connect(transport);
}

async function startHttp(): Promise<void> {
  const runtime = createEmailMcpRuntime();
  const host = process.env.AIOS_MCP_EMAIL_HOST?.trim() || "127.0.0.1";
  const rawPort = process.env.AIOS_MCP_EMAIL_PORT?.trim();
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : 3105;
  const port =
    Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? parsedPort
      : 3105;
  const expectedToken = process.env.AIOS_MCP_EMAIL_TOKEN?.trim() || null;

  const sessions = new Map<string, ActiveHttpSession>();

  const evictStaleSessions = () => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastActiveAt > 15 * 60_000) {
        sessions.delete(sid);
        void entry.transport.close().catch(() => undefined);
        void entry.server.close().catch(() => undefined);
      }
    }
  };

  const httpServer = createServer(async (req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const pathname = (req.url || "/").split("?")[0] || "/";

    if (pathname === "/healthz" && method === "GET") {
      writeJson(res, 200, {
        status: "ok",
        configured: runtime.smtp.isConfigured(),
        active_sessions: sessions.size,
      });
      return;
    }

    if (pathname !== "/mcp") {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    if (!verifyBearerToken(req.headers.authorization, expectedToken)) {
      writeJson(res, 401, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId =
      typeof sessionIdHeader === "string" ? sessionIdHeader.trim() : undefined;

    if (method === "GET" || method === "DELETE") {
      if (!sessionId) {
        writeJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Missing Mcp-Session-Id header." },
          id: null,
        });
        return;
      }
      const existing = sessions.get(sessionId);
      if (!existing) {
        writeJson(res, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unknown or expired MCP session." },
          id: null,
        });
        return;
      }
      existing.lastActiveAt = Date.now();
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (method !== "POST") {
      writeJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
      return;
    }

    const bodyResult = await readJsonBody(req, MAX_HTTP_BODY_BYTES);
    if (!bodyResult.ok) {
      writeJson(res, bodyResult.status, {
        jsonrpc: "2.0",
        error: { code: -32600, message: bodyResult.message },
        id: null,
      });
      return;
    }

    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        writeJson(res, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unknown or expired MCP session." },
          id: null,
        });
        return;
      }
      existing.lastActiveAt = Date.now();
      await existing.transport.handleRequest(req, res, bodyResult.data);
      return;
    }

    if (!isInitializeRequest(bodyResult.data)) {
      writeJson(res, 400, {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: initialization required before tool calls.",
        },
        id: null,
      });
      return;
    }

    evictStaleSessions();
    if (sessions.size >= MAX_ACTIVE_SESSIONS) {
      writeJson(res, 503, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "MCP session capacity reached." },
        id: null,
      });
      return;
    }

    const mcpServer = createEmailMcpServer(runtime);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      maxRequestBodySize: MAX_HTTP_BODY_BYTES,
      onsessioninitialized: (sid) => {
        sessions.set(sid, {
          server: mcpServer,
          transport,
          lastActiveAt: Date.now(),
        });
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        void mcpServer.close().catch(() => undefined);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
      void mcpServer.close().catch(() => undefined);
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, bodyResult.data);
  });

  const shutdown = async () => {
    for (const [sid, entry] of sessions) {
      sessions.delete(sid);
      await entry.transport.close().catch(() => undefined);
      await entry.server.close().catch(() => undefined);
    }
    runtime.smtp.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      process.stdout.write(
        `theodic-email-mcp listening on http://${host}:${port}/mcp\n`,
      );
      resolve();
    });
  });
}

const useStdio =
  process.argv.includes("--stdio") ||
  process.env.AIOS_MCP_EMAIL_TRANSPORT?.trim().toLowerCase() === "stdio";

if (useStdio) {
  startStdio().catch(() => {
    process.stderr.write("theodic-email-mcp stdio startup failed\n");
    process.exit(1);
  });
} else {
  startHttp().catch(() => {
    process.stderr.write("theodic-email-mcp HTTP startup failed\n");
    process.exit(1);
  });
}
