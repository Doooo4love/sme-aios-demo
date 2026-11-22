import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MAX_EMAIL_RECIPIENTS,
  SlidingWindowRateLimiter,
  hasHeaderInjection,
  normalizeAndValidateEmail,
  normalizeRecipientList,
  sanitizeEmailBody,
  sanitizeTransportError,
} from "./security.js";
import { PooledSmtpService } from "./transport.js";

export interface EmailMcpRuntime {
  smtp: PooledSmtpService;
  rateLimiter: SlidingWindowRateLimiter;
}

export function createEmailMcpRuntime(): EmailMcpRuntime {
  const limitRaw = process.env.AIOS_MCP_EMAIL_RATE_LIMIT_PER_MIN?.trim();
  const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 10;
  const maxPerMinute =
    Number.isFinite(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 120
      ? parsedLimit
      : 10;

  return {
    smtp: new PooledSmtpService(),
    rateLimiter: new SlidingWindowRateLimiter(maxPerMinute, 60_000),
  };
}

function errorToolResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function createEmailMcpServer(runtime: EmailMcpRuntime): McpServer {
  const server = new McpServer({
    name: "theodic-email-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "send_email",
    {
      title: "Send Governed Email",
      description:
        "Validates recipient caps and header safety, applies per-sender rate limits, and dispatches a plain-text email over TLS/STARTTLS SMTP.",
      inputSchema: {
        to: z
          .array(z.string().min(3).max(254))
          .min(1)
          .max(MAX_EMAIL_RECIPIENTS)
          .describe("Primary recipient email addresses (1 to 10)"),
        cc: z
          .array(z.string().min(3).max(254))
          .max(MAX_EMAIL_RECIPIENTS)
          .optional()
          .describe("Optional CC email addresses"),
        subject: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("Email subject line (no CR/LF or control characters)"),
        body: z
          .string()
          .min(1)
          .max(20_000)
          .describe("Plain-text email body"),
        replyTo: z
          .string()
          .min(3)
          .max(254)
          .optional()
          .describe("Optional Reply-To email address"),
        senderKey: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe("Optional sender identifier for sliding-window rate limiting"),
      },
    },
    async (args) => {
      if (hasHeaderInjection(args.subject)) {
        return errorToolResult(
          "Rejected email: subject contains forbidden control or newline characters.",
        );
      }

      const recipients = normalizeRecipientList(args.to, args.cc ?? []);
      if (!recipients.ok) {
        return errorToolResult(`Rejected email: ${recipients.reason}`);
      }

      let safeReplyTo: string | undefined;
      if (args.replyTo !== undefined) {
        const parsedReply = normalizeAndValidateEmail(args.replyTo);
        if (!parsedReply) {
          return errorToolResult(
            "Rejected email: replyTo address is invalid or contains control characters.",
          );
        }
        safeReplyTo = parsedReply;
      }

      const safeBody = sanitizeEmailBody(args.body);
      if (!safeBody) {
        return errorToolResult(
          "Rejected email: body is empty or contains invalid NUL bytes.",
        );
      }

      if (!runtime.smtp.isConfigured()) {
        return errorToolResult(
          "SMTP transport is not configured on the email MCP server.",
        );
      }

      const rate = runtime.rateLimiter.checkAndConsume(
        args.senderKey ?? "default",
      );
      if (!rate.allowed) {
        return errorToolResult(
          `Rate limit exceeded for sender. Retry after ${rate.retryAfterSeconds}s.`,
        );
      }

      try {
        const dispatched = await runtime.smtp.send({
          to: recipients.to,
          cc: recipients.cc,
          subject: args.subject.trim(),
          body: safeBody,
          replyTo: safeReplyTo,
        });

        const payload = {
          messageId: dispatched.messageId,
          accepted: dispatched.accepted,
          rejected: dispatched.rejected,
          timestamp: dispatched.timestamp,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch (err) {
        return errorToolResult(sanitizeTransportError(err));
      }
    },
  );

  server.registerTool(
    "verify_transport",
    {
      title: "Verify SMTP Transport",
      description:
        "Verifies SMTP TLS/STARTTLS readiness without exposing credentials, hosts, or URLs.",
      inputSchema: {},
    },
    async () => {
      if (!runtime.smtp.isConfigured()) {
        const payload = {
          configured: false,
          verified: false,
          tlsMode: "unconfigured",
          timestamp: Math.floor(Date.now() / 1000),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }

      try {
        const status = await runtime.smtp.verify();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(status) }],
          structuredContent: status,
        };
      } catch (err) {
        return errorToolResult(sanitizeTransportError(err));
      }
    },
  );

  server.registerTool(
    "preview_email",
    {
      title: "Preview & Validate Email",
      description:
        "Validates recipients, subject headers, and body safety without dispatching any email.",
      inputSchema: {
        to: z
          .array(z.string().min(3).max(254))
          .min(1)
          .max(MAX_EMAIL_RECIPIENTS),
        cc: z
          .array(z.string().min(3).max(254))
          .max(MAX_EMAIL_RECIPIENTS)
          .optional(),
        subject: z.string().trim().min(1).max(200),
        body: z.string().min(1).max(20_000),
      },
    },
    async (args) => {
      if (hasHeaderInjection(args.subject)) {
        return errorToolResult(
          "Rejected preview: subject contains forbidden control or newline characters.",
        );
      }

      const recipients = normalizeRecipientList(args.to, args.cc ?? []);
      if (!recipients.ok) {
        return errorToolResult(`Rejected preview: ${recipients.reason}`);
      }

      const safeBody = sanitizeEmailBody(args.body);
      if (!safeBody) {
        return errorToolResult(
          "Rejected preview: body is empty or contains invalid NUL bytes.",
        );
      }

      const preview = {
        valid: true,
        smtpConfigured: runtime.smtp.isConfigured(),
        recipientCount: recipients.to.length + recipients.cc.length,
        to: recipients.to,
        cc: recipients.cc,
        subject: args.subject.trim(),
        bodyPreview:
          safeBody.length > 240 ? `${safeBody.slice(0, 237)}...` : safeBody,
        byteLength: Buffer.byteLength(safeBody, "utf8"),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(preview) }],
        structuredContent: preview,
      };
    },
  );

  return server;
}
