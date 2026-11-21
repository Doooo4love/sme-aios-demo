const FORBIDDEN_KEY_SET: ReadonlySet<string> = new Set([
  "planner",
  "reasoning",
  "chain_of_thought",
  "thought",
  "raw_tokens",
  "prompt",
  "system_prompt",
  "tool_args",
  "internal_args",
  "model_name",
  "llm_model",
  "provider",
  "usage",
  "token_usage",
  "api_key",
  "secret",
  "traceback",
  "stack",
]);

const SAFE_5XX_CODES: ReadonlySet<string> = new Set([
  "STORAGE_UNAVAILABLE",
  "DIRECTORY_UNAVAILABLE",
  "AVATAR_BUSY",
  "ASSURANCE_OVERLOADED",
  "ASSURANCE_LIST_UNAVAILABLE",
  "ASSURANCE_SOURCE_UNAVAILABLE",
  "ASSURANCE_LIST_INVALID",
  "MODEL_UNAVAILABLE",
  "MODEL_OUTPUT_BLOCKED",
  "OIDC_EXCHANGE_FAILED",
  "UPSTREAM_UNAVAILABLE",
]);

const RECORD_UNAVAILABLE_DETAIL = {
  code: "RECORD_UNAVAILABLE",
  message: "当前账号无法访问这条记录。",
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripForbiddenKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripForbiddenKeys(item)) as unknown as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY_SET.has(key.toLowerCase())) {
      continue;
    }
    cleaned[key] = stripForbiddenKeys(entry);
  }
  return cleaned as T;
}

export function sanitizeCapabilitiesPayload(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return {
      tools: [],
      order_read_warehouses: [],
      approval_warehouses: {
        "sales_order.create_draft": [],
        "shipment.reschedule": [],
      },
      chat_available: false,
    };
  }

  const rawTools = Array.isArray(payload.tools) ? payload.tools : [];
  const tools = rawTools
    .filter(isPlainObject)
    .map((tool) => ({
      id: typeof tool.id === "string" ? tool.id : "",
      mode: tool.mode === "proposal" ? "proposal" : "read",
      available: Boolean(tool.available),
      source: typeof tool.source === "string" ? tool.source : "unconfigured",
      warehouses: Array.isArray(tool.warehouses)
        ? tool.warehouses.filter((w): w is string => typeof w === "string")
        : [],
    }))
    .filter((tool) => tool.id.length > 0);

  const rawApprovals = isPlainObject(payload.approval_warehouses)
    ? payload.approval_warehouses
    : {};

  return {
    tools,
    order_read_warehouses: Array.isArray(payload.order_read_warehouses)
      ? payload.order_read_warehouses.filter(
          (w): w is string => typeof w === "string",
        )
      : [],
    approval_warehouses: {
      "sales_order.create_draft": Array.isArray(
        rawApprovals["sales_order.create_draft"],
      )
        ? rawApprovals["sales_order.create_draft"].filter(
            (w): w is string => typeof w === "string",
          )
        : [],
      "shipment.reschedule": Array.isArray(rawApprovals["shipment.reschedule"])
        ? rawApprovals["shipment.reschedule"].filter(
            (w): w is string => typeof w === "string",
          )
        : [],
    },
    chat_available: Boolean(payload.chat_available),
  };
}

function sanitizeBatchApprovalPayload(payload: unknown): unknown {
  const cleaned = stripForbiddenKeys(payload);
  if (!isPlainObject(cleaned) || !Array.isArray(cleaned.items)) {
    return cleaned;
  }
  return {
    items: cleaned.items.map((item) => {
      if (!isPlainObject(item)) return item;
      if (item.status === 404) {
        return {
          proposal_id: item.proposal_id,
          status: 404,
          detail: { ...RECORD_UNAVAILABLE_DETAIL },
        };
      }
      return item;
    }),
  };
}

export function sanitizeSuccessPayload(pathname: string, payload: unknown): unknown {
  if (pathname === "/v1/workbench/capabilities") {
    return sanitizeCapabilitiesPayload(payload);
  }
  if (pathname === "/v1/proposals/approve-batch") {
    return sanitizeBatchApprovalPayload(payload);
  }
  return stripForbiddenKeys(payload);
}

function sanitizeValidationMsg(rawMsg: unknown): string {
  if (typeof rawMsg !== "string") return "输入格式不符合要求";
  // Strip any echoed internal/long user input snippets that Pydantic occasionally appends
  const trimmed = rawMsg.trim().slice(0, 180);
  if (
    /127\.0\.0\.1|localhost:\d+|traceback|\/Users\/|\/var\/|\/opt\//i.test(
      trimmed,
    )
  ) {
    return "输入格式不符合要求";
  }
  return trimmed || "输入格式不符合要求";
}

export function sanitizeErrorPayload(
  status: number,
  rawPayload: unknown,
): Record<string, unknown> {
  // Uniform 404 non-existence masking — never reveal whether record exists
  if (status === 404) {
    return {
      detail: { ...RECORD_UNAVAILABLE_DETAIL },
    };
  }

  const cleaned = stripForbiddenKeys(rawPayload);
  const rawDetail = isPlainObject(cleaned) ? cleaned.detail : cleaned;

  // FastAPI 422 validation errors: strip echoed `input`, `ctx`, `url`
  if (status === 422 && Array.isArray(rawDetail)) {
    const safeItems = rawDetail.map((issue) => {
      if (!isPlainObject(issue)) {
        return { loc: [], msg: "输入格式不符合要求" };
      }
      const loc = Array.isArray(issue.loc)
        ? issue.loc.filter(
            (part): part is string | number =>
              typeof part === "string" || typeof part === "number",
          )
        : [];
      const item: Record<string, unknown> = {
        loc,
        msg: sanitizeValidationMsg(issue.msg),
      };
      if (typeof issue.type === "string" && issue.type.length <= 64) {
        item.type = issue.type;
      }
      return item;
    });
    return { detail: safeItems };
  }

  // 5xx errors: never leak tracebacks, internal URLs, file paths, or SQL/Python internals
  if (status >= 500) {
    if (isPlainObject(rawDetail)) {
      const code =
        typeof rawDetail.code === "string" && SAFE_5XX_CODES.has(rawDetail.code)
          ? rawDetail.code
          : "UPSTREAM_UNAVAILABLE";
      const safeDetail: Record<string, unknown> = {
        code,
        message: "服务暂不可用，请稍后重试。",
      };
      if (typeof rawDetail.run_id === "string" && rawDetail.run_id.length <= 128) {
        safeDetail.run_id = rawDetail.run_id;
      }
      return { detail: safeDetail };
    }
    if (typeof rawDetail === "string") {
      const knownMessages: Record<string, { code: string; message: string }> = {
        "Database unavailable": {
          code: "STORAGE_UNAVAILABLE",
          message: "数据库暂不可用，请稍后重试。",
        },
        "Local OCR unavailable": {
          code: "OCR_UNAVAILABLE",
          message: "本地 OCR 服务暂不可用，请稍后重试。",
        },
        "Employee chat is unavailable": {
          code: "CHAT_UNAVAILABLE",
          message: "员工协作房间当前未启用。",
        },
        "Assurance connectors are unconfigured": {
          code: "ASSURANCE_UNCONFIGURED",
          message: "受控预审连接器当前未配置。",
        },
        "Planner unavailable": {
          code: "PLANNER_UNAVAILABLE",
          message: "规划服务暂不可用，请稍后重试。",
        },
        "Connector unavailable": {
          code: "CONNECTOR_UNAVAILABLE",
          message: "业务连接器暂不可用，请稍后重试。",
        },
      };
      const mapped = knownMessages[rawDetail];
      if (mapped) {
        return { detail: mapped };
      }
    }
    return {
      detail: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "上游服务暂不可用，请稍后重试。",
      },
    };
  }

  // 4xx structured or string details (after forbidden-key stripping)
  if (isPlainObject(rawDetail)) {
    return { detail: rawDetail };
  }
  if (typeof rawDetail === "string") {
    return { detail: rawDetail };
  }

  return {
    detail: {
      code: status === 401 ? "UNAUTHORIZED" : "REQUEST_FAILED",
      message: status === 401 ? "会话已失效，请重新登录。" : "请求未能完成。",
    },
  };
}
