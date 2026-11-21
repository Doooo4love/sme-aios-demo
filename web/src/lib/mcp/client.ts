export interface McpToolContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  ok: boolean;
  isError: boolean;
  errorCode?: "MCP_INVALID_URL" | "MCP_TIMEOUT" | "MCP_UNAVAILABLE" | "MCP_TOOL_ERROR";
  content: McpToolContentPart[];
  structuredContent?: Record<string, unknown>;
  rawText: string;
}

export interface McpClientConfig {
  serverUrl: string;
  bearerToken?: string | null;
  timeoutMs?: number;
}

const MAX_MCP_RESPONSE_BYTES = 262_144; // 256 KiB cap
const DEFAULT_TIMEOUT_MS = 8000;
const MCP_PROTOCOL_VERSION = "2025-06-18";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * SSRF & scheme guard for configured MCP Streamable HTTP endpoints:
 * - Allows https:// for remote MCP endpoints.
 * - Allows http:// ONLY for loopback sidecars (127.0.0.1, localhost, ::1).
 * - Rejects embedded URL credentials, non-http(s) schemes, and cloud metadata IPs.
 */
export function validateMcpEndpointUrl(rawUrl: string): URL | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 512) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "169.254.169.254" ||
    host.startsWith("169.254.") ||
    host === "metadata.google.internal" ||
    host.startsWith("fd") ||
    host.startsWith("[fd") ||
    host === "0.0.0.0"
  ) {
    return null;
  }

  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(host)) {
    return parsed;
  }
  return null;
}

async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    return text.slice(0, maxBytes);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const decoder = new TextDecoder("utf-8", { fatal: false });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
        }
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}

function parseJsonRpcFromSse(sseText: string, expectedId: number): Record<string, unknown> | null {
  const lines = sseText.split(/\r?\n/);
  let dataLines: string[] = [];
  let lastValid: Record<string, unknown> | null = null;

  const flush = (): Record<string, unknown> | null => {
    if (dataLines.length === 0) return null;
    const joined = dataLines.join("\n").trim();
    dataLines = [];
    if (!joined || joined === "[DONE]") return null;
    try {
      const parsed = JSON.parse(joined) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        lastValid = obj;
        if (obj.id === expectedId) return obj;
      }
    } catch {
      // Ignore malformed SSE data chunks
    }
    return null;
  };

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line.trim() === "") {
      const matched = flush();
      if (matched) return matched;
    }
  }
  const trailing = flush();
  return trailing ?? lastValid;
}

async function parseJsonRpcResponse(
  res: Response,
  expectedId: number,
): Promise<Record<string, unknown> | null> {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const text = await readBoundedText(res, MAX_MCP_RESPONSE_BYTES);
  if (!text.trim()) return null;

  if (contentType.includes("text/event-stream")) {
    return parseJsonRpcFromSse(text, expectedId);
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (Array.isArray(parsed)) {
      const found = parsed.find(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          (item as Record<string, unknown>).id === expectedId,
      );
      return (found as Record<string, unknown>) ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Standards-compliant JSON-RPC 2.0 Streamable-HTTP MCP client.
 * Supports stateful (Mcp-Session-Id) and stateless Streamable HTTP MCP servers,
 * parsing both application/json and text/event-stream responses.
 * Never echoes serverUrl or bearerToken back into returned errors.
 */
export async function callMcpTool(
  config: McpClientConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const validatedUrl = validateMcpEndpointUrl(config.serverUrl);
  if (!validatedUrl) {
    return {
      ok: false,
      isError: true,
      errorCode: "MCP_INVALID_URL",
      content: [],
      rawText: "",
    };
  }

  const timeoutMs = Math.max(1000, Math.min(20_000, config.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const endpoint = validatedUrl.toString();

  const buildHeaders = (sessionId?: string | null): Headers => {
    const headers = new Headers({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
    if (config.bearerToken && config.bearerToken.trim()) {
      headers.set("Authorization", `Bearer ${config.bearerToken.trim()}`);
    }
    if (sessionId) {
      headers.set("Mcp-Session-Id", sessionId);
    }
    return headers;
  };

  let sessionId: string | null = null;

  try {
    // Step 1: JSON-RPC initialize handshake (best-effort; stateless servers may ignore or return session ID)
    const initRes = await fetch(endpoint, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "aios-bff", version: "2.0.0" },
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });

    sessionId = initRes.headers.get("mcp-session-id");

    if (initRes.ok) {
      // Drain init body cleanly and send notifications/initialized
      await initRes.arrayBuffer().catch(() => undefined);
      await fetch(endpoint, {
        method: "POST",
        headers: buildHeaders(sessionId),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(3000, timeoutMs)),
      }).catch(() => undefined);
    }

    // Step 2: Invoke tools/call
    const callRes = await fetch(endpoint, {
      method: "POST",
      headers: buildHeaders(sessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!callRes.ok) {
      return {
        ok: false,
        isError: true,
        errorCode: "MCP_UNAVAILABLE",
        content: [],
        rawText: "",
      };
    }

    const rpc = await parseJsonRpcResponse(callRes, 2);
    if (!rpc || "error" in rpc) {
      return {
        ok: false,
        isError: true,
        errorCode: "MCP_TOOL_ERROR",
        content: [],
        rawText: "",
      };
    }

    const resultObj =
      typeof rpc.result === "object" && rpc.result !== null
        ? (rpc.result as Record<string, unknown>)
        : {};
    const isToolError = Boolean(resultObj.isError);
    const content: McpToolContentPart[] = Array.isArray(resultObj.content)
      ? resultObj.content.filter(
          (item): item is McpToolContentPart =>
            typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).type === "string",
        )
      : [];
    const structuredContent =
      typeof resultObj.structuredContent === "object" &&
      resultObj.structuredContent !== null &&
      !Array.isArray(resultObj.structuredContent)
        ? (resultObj.structuredContent as Record<string, unknown>)
        : undefined;
    const rawText = content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");

    return {
      ok: !isToolError,
      isError: isToolError,
      errorCode: isToolError ? "MCP_TOOL_ERROR" : undefined,
      content,
      structuredContent,
      rawText,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      isError: true,
      errorCode: isTimeout ? "MCP_TIMEOUT" : "MCP_UNAVAILABLE",
      content: [],
      rawText: "",
    };
  } finally {
    // Best-effort session teardown so sidecar MCP servers don't leak sessions
    if (sessionId) {
      fetch(endpoint, {
        method: "DELETE",
        headers: buildHeaders(sessionId),
        cache: "no-store",
        signal: AbortSignal.timeout(1000),
      }).catch(() => undefined);
    }
  }
}
