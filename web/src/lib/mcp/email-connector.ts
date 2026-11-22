import { randomUUID } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { callMcpTool, validateMcpEndpointUrl } from "@/lib/mcp/client";
import {
  DEFAULT_LOCALE,
  PERSONA_LOCALIZATIONS,
  type Locale,
} from "@/lib/i18n";
import type {
  CompanyContact,
  DemoPersonaId,
  EmailDeliveryStatus,
  EmailDraftPayload,
  EmailDraftResolvedContact,
  EmailTransportMode,
} from "@/lib/types";

export const MAX_EMAIL_RECIPIENTS = 10;

const HEADER_CONTROL_RE = /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const ENCODED_CRLF_RE = /%0[da]/i;
const EMAIL_CONTROL_RE = /[\r\n\x00-\x1f\x7f]/;
const EMAIL_ADDRESS_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const SENSITIVE_SECRET_RE =
  /(?:\bsk-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b|\bTHEODIC-DEMO-[A-Za-z0-9-]{4,}\b|\bCCMF27-[A-Za-z0-9-]{4,}\b|\b[0-9a-fA-F]{48,}\b|\b(?:DEEPSEEK_API_KEY|AIOS_LLM_API_KEY|AIOS_DEMO_SECRET|AIOS_BROWSER_SESSION_KEY|__Host-aios_session|__Host-aios_gate)\b)/;

function readCleanEnv(key: string): string | null {
  const val = process.env[key]?.trim();
  return val && val.length > 0 ? val : null;
}

export function hasEmailHeaderInjection(value: string): boolean {
  const nfkc = value.normalize("NFKC");
  return HEADER_CONTROL_RE.test(nfkc) || ENCODED_CRLF_RE.test(nfkc);
}

export function normalizeAndValidateEmail(raw: string): string | null {
  const trimmed = raw.normalize("NFKC").trim();
  if (
    !trimmed ||
    trimmed.length > 254 ||
    EMAIL_CONTROL_RE.test(trimmed) ||
    ENCODED_CRLF_RE.test(trimmed) ||
    trimmed.includes("..")
  ) {
    return null;
  }
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0 || atIndex > 64) {
    return null;
  }
  if (!EMAIL_ADDRESS_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function containsSensitiveSecret(text: string): boolean {
  return SENSITIVE_SECRET_RE.test(text.normalize("NFKC"));
}

export interface EmailMcpConfig {
  url: string;
  token: string | null;
  toolName: string;
}

export interface DirectSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  rejectUnauthorized: boolean;
}

export function getEmailMcpConfig(): EmailMcpConfig | null {
  const url = readCleanEnv("AIOS_MCP_EMAIL_URL");
  if (!url || !validateMcpEndpointUrl(url)) return null;
  return {
    url,
    token: readCleanEnv("AIOS_MCP_EMAIL_TOKEN"),
    toolName: readCleanEnv("AIOS_MCP_EMAIL_TOOL") || "send_email",
  };
}

export function getDirectSmtpConfig(): DirectSmtpConfig | null {
  const host = readCleanEnv("AIOS_SMTP_HOST");
  if (!host || hasEmailHeaderInjection(host)) return null;

  const rawPort = readCleanEnv("AIOS_SMTP_PORT");
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : 587;
  const port =
    Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? parsedPort
      : 587;

  const secureEnv = readCleanEnv("AIOS_SMTP_SECURE");
  const secure = secureEnv === "1" || secureEnv === "true" || port === 465;

  const user = readCleanEnv("AIOS_SMTP_USER");
  const pass = readCleanEnv("AIOS_SMTP_PASS");
  const rawFrom = readCleanEnv("AIOS_SMTP_FROM") ?? user;
  const validatedFrom = rawFrom ? normalizeAndValidateEmail(rawFrom) : null;
  if (!validatedFrom) return null;

  return {
    host,
    port,
    secure,
    requireTls: readCleanEnv("AIOS_SMTP_REQUIRE_TLS") !== "0",
    user,
    pass,
    from: validatedFrom,
    rejectUnauthorized: readCleanEnv("AIOS_SMTP_ALLOW_SELF_SIGNED") !== "1",
  };
}

export function getEmailConnectorMode(): EmailTransportMode {
  if (getEmailMcpConfig()) return "live_mcp";
  if (getDirectSmtpConfig()) return "live_smtp";
  return "governed_outbox";
}

export function isEmailConfigured(): boolean {
  return getEmailConnectorMode() !== "governed_outbox";
}

let cachedSmtpTransporter: Transporter | null = null;
let cachedSmtpSignature: string | null = null;

function getPooledSmtpTransporter(cfg: DirectSmtpConfig): Transporter {
  const sig = `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.requireTls}:${cfg.user ?? ""}:${cfg.from}`;
  if (!cachedSmtpTransporter || cachedSmtpSignature !== sig) {
    if (cachedSmtpTransporter) {
      cachedSmtpTransporter.close();
    }
    cachedSmtpTransporter = nodemailer.createTransport({
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: !cfg.secure && cfg.requireTls,
      auth:
        cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
      tls: {
        minVersion: "TLSv1.2",
        rejectUnauthorized: cfg.rejectUnauthorized,
      },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 10_000,
    });
    cachedSmtpSignature = sig;
  }
  return cachedSmtpTransporter;
}

function extractMcpEmailResponse(
  structured: Record<string, unknown> | undefined,
  rawText: string,
  fallbackRecipients: string[],
): { messageId: string | null; accepted: string[]; rejected: string[] } {
  let obj: Record<string, unknown> | null = structured ?? null;
  if (!obj && rawText.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      obj = null;
    }
  }
  if (!obj) {
    return { messageId: null, accepted: fallbackRecipients, rejected: [] };
  }
  const messageId =
    typeof obj.messageId === "string" && obj.messageId.trim()
      ? obj.messageId.trim()
      : typeof obj.message_id === "string" && obj.message_id.trim()
        ? obj.message_id.trim()
        : null;
  const accepted = Array.isArray(obj.accepted)
    ? obj.accepted.filter((v): v is string => typeof v === "string")
    : fallbackRecipients;
  const rejected = Array.isArray(obj.rejected)
    ? obj.rejected.filter((v): v is string => typeof v === "string")
    : [];
  return { messageId, accepted, rejected };
}

function generateRfcMessageId(tenant: string): string {
  const safeTenant =
    tenant
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 32) || "enterprise";
  return `<${randomUUID()}.${Math.floor(Date.now() / 1000)}@${safeTenant}.theodic.local>`;
}

export interface SendEmailConnectorParams {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  replyTo?: string;
  senderSubject: string;
  senderTenant: string;
  internalRecipientCount?: number;
}

export interface SendEmailConnectorResult {
  transport_mode: EmailTransportMode;
  message_id: string;
  delivery_status: EmailDeliveryStatus;
  accepted: string[];
  rejected: string[];
  warnings: string[];
}

export async function sendEmailViaConnector(
  params: SendEmailConnectorParams,
  locale: Locale = DEFAULT_LOCALE,
): Promise<SendEmailConnectorResult> {
  const to = params.to;
  const cc = params.cc ?? [];
  const allRecipients = [...to, ...cc];
  const warnings: string[] = [];

  // Priority 1: Streamable HTTP Email MCP Server
  const mcpCfg = getEmailMcpConfig();
  if (mcpCfg) {
    const res = await callMcpTool(
      { serverUrl: mcpCfg.url, bearerToken: mcpCfg.token, timeoutMs: 10_000 },
      mcpCfg.toolName,
      {
        to,
        cc,
        subject: params.subject,
        body: params.body,
        replyTo: params.replyTo,
        senderKey: `${params.senderTenant}:${params.senderSubject}`,
      },
    );
    if (res.ok) {
      const parsed = extractMcpEmailResponse(
        res.structuredContent,
        res.rawText,
        allRecipients,
      );
      return {
        transport_mode: "live_mcp",
        message_id:
          parsed.messageId || generateRfcMessageId(params.senderTenant),
        delivery_status: "sent",
        accepted: parsed.accepted,
        rejected: parsed.rejected,
        warnings,
      };
    }
    warnings.push(
      locale === "en"
        ? "Email MCP server was unreachable; checking fallback transport."
        : locale === "zh-HK"
          ? "電郵 MCP 伺服器暫時無法連線，已切換備援通道。"
          : "邮件 MCP 服务暂不可达，已尝试备用投递通道。",
    );
  }

  // Priority 2: Direct TLS Nodemailer SMTP Transport
  const smtpCfg = getDirectSmtpConfig();
  if (smtpCfg) {
    try {
      const transporter = getPooledSmtpTransporter(smtpCfg);
      const info = await transporter.sendMail({
        from: smtpCfg.from,
        to,
        cc: cc.length > 0 ? cc : undefined,
        replyTo: params.replyTo,
        subject: params.subject,
        text: params.body,
      });

      const extractAddr = (item: unknown): string => {
        if (typeof item === "string") return item;
        if (
          typeof item === "object" &&
          item !== null &&
          "address" in item &&
          typeof (item as { address?: unknown }).address === "string"
        ) {
          return (item as { address: string }).address;
        }
        return String(item);
      };

      const accepted = Array.isArray(info.accepted)
        ? info.accepted.map(extractAddr)
        : allRecipients;
      const rejected = Array.isArray(info.rejected)
        ? info.rejected.map(extractAddr)
        : [];

      return {
        transport_mode: "live_smtp",
        message_id:
          typeof info.messageId === "string" && info.messageId.trim()
            ? info.messageId.trim()
            : generateRfcMessageId(params.senderTenant),
        delivery_status: "sent",
        accepted,
        rejected,
        warnings,
      };
    } catch {
      warnings.push(
        locale === "en"
          ? "Direct SMTP transport failed; recorded in governed outbox."
          : locale === "zh-HK"
            ? "SMTP 傳輸失敗，已改由受控寄件匣留痕投遞。"
            : "直连 SMTP 投递失败，已转入受控发件箱留痕。",
      );
    }
  }

  // Priority 3: Governed Outbox (RFC Message-ID + backend audit receipt + internal push)
  const internalCount = params.internalRecipientCount ?? 0;
  const allInternal =
    internalCount > 0 && internalCount >= allRecipients.length;

  return {
    transport_mode: "governed_outbox",
    message_id: generateRfcMessageId(params.senderTenant),
    delivery_status: allInternal ? "delivered_internal" : "queued_governed",
    accepted: allRecipients,
    rejected: [],
    warnings,
  };
}

// ============================================================================
// Trilingual Natural-Language Email Parser (zh-CN / zh-HK / EN)
// ============================================================================

const EMAIL_ROLE_KEYWORDS: Array<{ pattern: RegExp; subject: string }> = [
  {
    pattern:
      /(?:^|[\s,，和与與跟给給向@])(权限管理员|權限管理員|access[- ]?admin|iam)\b/i,
    subject: "access-admin",
  },
  {
    pattern:
      /(?:^|[\s,，和与與跟给給向@])(运维管理员|維運管理員|運維管理員|ops[- ]?admin|system\s+admin)/i,
    subject: "admin",
  },
  {
    pattern:
      /(?:^|[\s,，和与與跟给給向@])(二仓主管|二倉主管|hk02\s*主管|hk02\s*manager)/i,
    subject: "other-manager",
  },
  {
    pattern: /(?:^|[\s,，和与與跟给給向@])(主管|经理|經理|审批人|審批人|manager)/i,
    subject: "manager",
  },
  {
    pattern:
      /(?:^|[\s,，和与與跟给給向@])(财务|財務|会计|會計|finance|accounting)/i,
    subject: "finance",
  },
  {
    pattern: /(?:^|[\s,，和与與跟给給向@])(质检|質檢|品控|品質|quality|qa\b)/i,
    subject: "quality",
  },
  {
    pattern: /(?:^|[\s,，和与與跟给給向@])(法务|法務|合规|合規|legal|counsel)/i,
    subject: "legal",
  },
  {
    pattern: /(?:^|[\s,，和与與跟给給向@])(经办|經辦|接单|接單|operator)/i,
    subject: "operator",
  },
  {
    pattern: /(?:^|[\s,，和与與跟给給向@])(高管|经营|經營|executive)/i,
    subject: "executive",
  },
  {
    pattern: /(?:^|[\s,，和与與跟给給向@])(客服|只读|只讀|viewer|support)/i,
    subject: "viewer",
  },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getContactSearchNames(contact: CompanyContact): string[] {
  const set = new Set<string>();
  if (contact.display_name && contact.display_name.trim().length >= 2) {
    set.add(contact.display_name.trim());
  }
  if (
    contact.default_display_name &&
    contact.default_display_name.trim().length >= 2
  ) {
    set.add(contact.default_display_name.trim());
  }
  const localized = PERSONA_LOCALIZATIONS[contact.subject as DemoPersonaId];
  if (localized) {
    for (const loc of ["zh-CN", "zh-HK", "en"] as const) {
      const name = localized[loc].displayName;
      if (name && name.trim().length >= 2) {
        set.add(name.trim());
      }
    }
  }
  return Array.from(set).sort((a, b) => b.length - a.length);
}

function cleanSingleLine(raw: string, maxLen: number): string {
  return raw
    .replace(/[\r\n\x00-\x1f\x7f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLen);
}

function cleanSnippet(raw: string): string {
  return raw
    .replace(/^[\s,，。.:：;；\-—·、的关于關於向给給与與和跟]+/, "")
    .replace(/[\s,，。.:：;；\-—·]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseNaturalLanguageEmail(
  utterance: string,
  contacts: readonly CompanyContact[],
  locale: Locale = DEFAULT_LOCALE,
): EmailDraftPayload {
  let working = utterance
    .trim()
    .replace(/^\/(?:email|mail)\b\s*/i, "");

  const toList: string[] = [];
  const ccList: string[] = [];
  const seenEmails = new Set<string>();
  const resolvedContacts: EmailDraftResolvedContact[] = [];
  const seenSubjects = new Set<string>();
  const warnings: string[] = [];

  const contactByEmail = new Map<string, CompanyContact>();
  const contactBySubject = new Map<string, CompanyContact>();
  for (const contact of contacts) {
    contactByEmail.set(contact.email.toLowerCase(), contact);
    contactBySubject.set(contact.subject.toLowerCase(), contact);
  }

  const addRecipient = (
    emailRaw: string,
    target: "to" | "cc",
    contact?: CompanyContact,
  ) => {
    const valid = normalizeAndValidateEmail(emailRaw);
    if (!valid) return;
    const lower = valid.toLowerCase();
    if (seenEmails.has(lower)) return;
    if (toList.length + ccList.length >= MAX_EMAIL_RECIPIENTS) {
      return;
    }
    seenEmails.add(lower);
    if (target === "cc") {
      ccList.push(valid);
    } else {
      toList.push(valid);
    }
    const matchedContact = contact ?? contactByEmail.get(lower);
    if (matchedContact && !seenSubjects.has(matchedContact.subject)) {
      seenSubjects.add(matchedContact.subject);
      resolvedContacts.push({
        subject: matchedContact.subject,
        display_name: matchedContact.display_name,
        email: matchedContact.email,
      });
    }
  };

  // Detect optional CC section boundaries (e.g. "cc ..." or "抄送 ...")
  const ccMarkerMatch = working.match(
    /(?:^|[\s,，;；])(?:cc|抄送|副本)[：:\s]+([^，。,;\n]+)/i,
  );
  const ccSegment = ccMarkerMatch ? ccMarkerMatch[1] ?? "" : "";

  // 1. Extract explicit email addresses
  const emailMatches = Array.from(
    working.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g),
  );
  for (const m of emailMatches) {
    const email = m[0];
    const idx = m.index ?? 0;
    const prefix = working.slice(Math.max(0, idx - 16), idx).toLowerCase();
    const isCc =
      /(?:cc|抄送|副本)[：:\s]*$/.test(prefix) ||
      (ccSegment.length > 0 && ccSegment.includes(email));
    addRecipient(email, isCc ? "cc" : "to");
    working = working.replace(email, " ");
  }

  // 2. Match explicit colleague display names from current tenant contacts
  for (const contact of contacts) {
    const names = getContactSearchNames(contact);
    for (const name of names) {
      const pattern = /^[A-Za-z0-9 ._-]+$/.test(name)
        ? new RegExp(`\\b${escapeRegex(name)}\\b`, "i")
        : new RegExp(escapeRegex(name));
      const match = working.match(pattern);
      if (match) {
        const isCc = ccSegment.length > 0 && ccSegment.includes(name);
        addRecipient(contact.email, isCc ? "cc" : "to", contact);
        working = working.replace(pattern, " ");
        break;
      }
    }
  }

  // 3. Match role keywords (manager / finance / 主管 / 财务 / etc.) against tenant contacts
  for (const rule of EMAIL_ROLE_KEYWORDS) {
    const match = working.match(rule.pattern);
    if (match) {
      const contact = contactBySubject.get(rule.subject);
      if (contact) {
        const token = match[1] ?? match[0];
        const isCc = ccSegment.length > 0 && ccSegment.includes(token);
        addRecipient(contact.email, isCc ? "cc" : "to", contact);
      }
      working = working.replace(rule.pattern, " ");
    }
  }

  // 4. Extract explicit Subject & Body markers if present
  let explicitSubject = "";
  let explicitBody = "";

  const subjectColonMatch = working.match(
    /(?:主题|主題|标题|標題|subject)\s*[：:=]\s*([^\n]+?)(?=\s*(?:正文|内容|內容|body)[：:=]|$)/i,
  );
  const subjectIsMatch = !subjectColonMatch
    ? working.match(
        /(?:主题|主題|标题|標題)\s*(?:是|为|為)\s*([^\n，,。;；]+)|(?:subject\s+is\s+)([^\n,.;]+)/i,
      )
    : null;

  if (subjectColonMatch && subjectColonMatch[1]) {
    explicitSubject = cleanSingleLine(cleanSnippet(subjectColonMatch[1]), 120);
    working = working.replace(subjectColonMatch[0], " ");
  } else if (subjectIsMatch) {
    const rawSubj = subjectIsMatch[1] || subjectIsMatch[2] || "";
    explicitSubject = cleanSingleLine(cleanSnippet(rawSubj), 120);
    working = working.replace(subjectIsMatch[0], " ");
  }

  const bodyMatch = working.match(/(?:正文|内容|內容|body)\s*[：:=]\s*([\s\S]+)$/i);
  if (bodyMatch && bodyMatch[1]) {
    explicitBody = bodyMatch[1].trim();
    working = working.replace(bodyMatch[0], " ");
  }

  // Strip common command prefixes & dangling recipient connector words
  let intentClean = working
    .replace(
      /^(?:请|請)?(?:帮我|幫我)?(?:起草|草拟|草擬|撰写|撰寫|发送|發送|发一封|發一封|发封|發封|发|發|写一封|寫一封|给|給|向)?\s*(?:邮件|電郵|email|mail)?\s*(?:给|給|向|to)?\s*/i,
      "",
    )
    .replace(
      /^(?:please\s+)?(?:draft|write|send|compose)\s+(?:an?\s+)?(?:email|mail)\s*(?:to\s*)?/i,
      "",
    )
    .replace(/(?:^|[\s,，;；])(?:cc|抄送|副本)[：:\s]*(?=$|[\s,，;；])/gi, " ");

  for (let i = 0; i < 4; i += 1) {
    const next = cleanSnippet(intentClean).replace(
      /^(?:and|or|to|with|about|regarding|re\b|和|与|與|跟|及|以及|并|並|给|給|向|关于|關於|告诉他|告訴他|告诉她|告訴她|告诉|告訴|让他|讓他|请他|請他|说|說|说明|說明|通知|提醒|告知)\s*[：:，,]?\s*/i,
      "",
    );
    if (next === intentClean) break;
    intentClean = next;
  }
  const strippedIntent = cleanSnippet(intentClean);

  // Split topic vs detailed content when separated by colon or "about/关于"
  let inferredSubject = explicitSubject;
  let inferredBodyContent = explicitBody || strippedIntent;

  if (!inferredSubject && inferredBodyContent) {
    const aboutSplit = inferredBodyContent.match(
      /^(.{2,60}?)\s*(?:[：:]|\s+-\s+|\n)\s*([\s\S]+)$/,
    );
    if (aboutSplit && aboutSplit[1] && aboutSplit[2]) {
      inferredSubject = cleanSingleLine(cleanSnippet(aboutSplit[1]), 80);
      inferredBodyContent = cleanSnippet(aboutSplit[2]);
    } else {
      const firstSentence =
        inferredBodyContent.split(/[。！？.!?\n]/)[0] || inferredBodyContent;
      inferredSubject = cleanSingleLine(firstSentence, 64);
    }
  }

  if (!inferredSubject) {
    inferredSubject =
      locale === "en"
        ? "Work Update & Action Needed"
        : locale === "zh-HK"
          ? "工作事項跟進通知"
          : "工作事项跟进通知";
  }

  const recipientGreeting =
    resolvedContacts.length > 0
      ? resolvedContacts.map((c) => c.display_name).join(locale === "en" ? ", " : "、")
      : locale === "en"
        ? "Team"
        : locale === "zh-HK"
          ? "同事"
          : "同事";

  let finalBody = explicitBody;
  if (!finalBody) {
    if (inferredBodyContent) {
      if (locale === "en") {
        finalBody = `Hi ${recipientGreeting},\n\n${inferredBodyContent}\n\nBest regards,\nTheodic Workbench`;
      } else if (locale === "zh-HK") {
        finalBody = `${recipientGreeting} 您好：\n\n${inferredBodyContent}\n\n如有需要進一步確認的細節，請隨時回覆。`;
      } else {
        finalBody = `${recipientGreeting} 您好：\n\n${inferredBodyContent}\n\n如有需要进一步确认的细节，请随时回复。`;
      }
    } else {
      finalBody =
        locale === "en"
          ? `Hi ${recipientGreeting},\n\nPlease review the latest operational update in AIOS Workbench.\n\nBest regards,\nTheodic Workbench`
          : locale === "zh-HK"
            ? `${recipientGreeting} 您好：\n\n請查閱 AIOS 工作台中的最新業務進度並協助確認。`
            : `${recipientGreeting} 您好：\n\n请查阅 AIOS 工作台中的最新业务进展并协助确认。`;
    }
  }

  if (toList.length === 0) {
    warnings.push(
      locale === "en"
        ? "No recipient matched automatically — enter an email address or select a colleague before sending."
        : locale === "zh-HK"
          ? "未能自動辨識收件人，請在傳送前輸入電郵地址或選擇同事。"
          : "未能自动识别收件人，请在发送前填写邮箱地址或选择同事。",
    );
  }

  return {
    to: toList,
    cc: ccList,
    subject: cleanSingleLine(inferredSubject, 200),
    body: finalBody.slice(0, 20_000),
    resolved_contacts: resolvedContacts,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
