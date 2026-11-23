"""Pure-stdlib MCP stdio JSON-RPC server for WorkspaceSandbox, DocumentTools, and CuaPolicyEngine."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import json
import threading
import time
from typing import Any, Callable, TextIO

if __package__ in (None, ""):
    _THIS_DIR = Path(__file__).resolve().parent
    if str(_THIS_DIR) not in sys.path:
        sys.path.insert(0, str(_THIS_DIR))
    from cua_guard import (
        ActionTier,
        ConfirmationRequiredError,
        CuaPolicyEngine,
        CuaPolicyViolation,
        WindowTarget,
        inspect_untrusted_screen_text,
        redact_screen_text_detailed,
    )
    from document_tools import (
        build_docx_draft,
        build_pptx_draft,
        build_xlsx_draft,
        inspect_capabilities,
        parse_document,
        render_libreoffice_preview,
    )
    from sandbox import SandboxViolationError, WorkspaceSandbox
else:
    from .cua_guard import (
        ActionTier,
        ConfirmationRequiredError,
        CuaPolicyEngine,
        CuaPolicyViolation,
        WindowTarget,
        inspect_untrusted_screen_text,
        redact_screen_text_detailed,
    )
    from .document_tools import (
        build_docx_draft,
        build_pptx_draft,
        build_xlsx_draft,
        inspect_capabilities,
        parse_document,
        render_libreoffice_preview,
    )
    from .sandbox import SandboxViolationError, WorkspaceSandbox

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "theodic-workspace-mcp", "version": "1.0.0"}


class EmergencyStopError(RuntimeError):
    """Raised when the local emergency-stop kill switch aborts a tool step."""

    def __init__(self, reason: str, sequence: int) -> None:
        super().__init__(f"Emergency stop engaged ({reason}, seq={sequence}).")
        self.reason = reason
        self.sequence = sequence


class EmergencyStopController:
    """Thread-safe kill switch checked before and after every MCP/CUA step."""

    def __init__(self, *, kill_switch_file: str | Path | None = None) -> None:
        self._lock = threading.Lock()
        self._stopped = False
        self._reason: str | None = None
        self._sequence = 0
        self._last_triggered_at: float | None = None
        self._kill_switch_file = Path(kill_switch_file) if kill_switch_file else None

    def trigger(self, reason: str = "user_emergency_stop") -> dict[str, Any]:
        with self._lock:
            self._stopped = True
            self._reason = reason.strip() or "user_emergency_stop"
            self._sequence += 1
            self._last_triggered_at = time.time()
            return {
                "stopped": True,
                "reason": self._reason,
                "sequence": self._sequence,
                "triggered_at": self._last_triggered_at,
            }

    def reset(self) -> dict[str, Any]:
        with self._lock:
            self._stopped = False
            self._reason = None
            return {"stopped": False, "sequence": self._sequence}

    def is_stopped(self) -> bool:
        with self._lock:
            if self._stopped:
                return True
            if self._kill_switch_file and self._kill_switch_file.exists():
                self._stopped = True
                self._reason = "kill_switch_file"
                self._sequence += 1
                self._last_triggered_at = time.time()
                return True
            return False

    def status(self) -> dict[str, Any]:
        stopped = self.is_stopped()
        with self._lock:
            return {
                "stopped": stopped,
                "reason": self._reason,
                "sequence": self._sequence,
                "last_triggered_at": self._last_triggered_at,
            }

    def assert_not_stopped(self, phase: str) -> None:
        if self.is_stopped():
            with self._lock:
                raise EmergencyStopError(
                    f"{self._reason or 'emergency_stop'} ({phase})",
                    self._sequence,
                )


def _tool_definitions() -> list[dict[str, Any]]:
    return [
        {
            "name": "workspace_capabilities",
            "description": "Inspect available stdlib and optional OSS document/CUA engines plus emergency-stop state.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        {
            "name": "workspace_list_files",
            "description": "List non-sensitive files inside the sandboxed workspace directory.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subdir": {"type": "string", "default": "."},
                    "max_entries": {"type": "integer", "minimum": 1, "maximum": 500, "default": 200},
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "workspace_parse_document",
            "description": "Parse a document inside the workspace sandbox (.txt, .md, .csv, .json, .docx, .pptx, .xlsx, or .pdf with docling/markitdown).",
            "inputSchema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
        },
        {
            "name": "workspace_build_docx_draft",
            "description": "Generate a Word (.docx) draft inside the workspace sandbox (YELLOW tier).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "output_path": {"type": "string"},
                    "title": {"type": "string"},
                    "paragraphs": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["output_path", "title", "paragraphs"],
                "additionalProperties": False,
            },
        },
        {
            "name": "workspace_build_pptx_draft",
            "description": "Generate a PowerPoint (.pptx) draft inside the workspace sandbox (YELLOW tier).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "output_path": {"type": "string"},
                    "title": {"type": "string"},
                    "slides": {"type": "array", "items": {"type": "object"}},
                },
                "required": ["output_path", "title", "slides"],
                "additionalProperties": False,
            },
        },
        {
            "name": "workspace_build_xlsx_draft",
            "description": "Generate an Excel (.xlsx) draft inside the workspace sandbox (YELLOW tier).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "output_path": {"type": "string"},
                    "sheet_name": {"type": "string"},
                    "headers": {"type": "array", "items": {"type": "string"}},
                    "rows": {"type": "array", "items": {"type": "array"}},
                },
                "required": ["output_path", "sheet_name", "headers", "rows"],
                "additionalProperties": False,
            },
        },
        {
            "name": "workspace_render_preview",
            "description": "Render headless LibreOffice PNG previews inside the workspace sandbox for visual overlap QA.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "input_path": {"type": "string"},
                    "output_dir": {"type": "string", "default": "previews"},
                },
                "required": ["input_path"],
                "additionalProperties": False,
            },
        },
        {
            "name": "cua_inspect_window",
            "description": "Inspect captured text from an allowlisted single window after PII redaction and prompt-injection neutralization.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app_id": {"type": "string"},
                    "title": {"type": "string"},
                    "pid": {"type": "integer", "minimum": 1},
                    "captured_text": {"type": "string"},
                    "full_screen_capture": {"type": "boolean", "default": False},
                },
                "required": ["app_id", "title", "pid", "captured_text"],
                "additionalProperties": False,
            },
        },
        {
            "name": "cua_request_confirmation",
            "description": "Create or approve a human-in-the-loop confirmation challenge for a RED-tier action.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "app_id": {"type": "string"},
                    "title": {"type": "string"},
                    "pid": {"type": "integer", "minimum": 1},
                    "summary": {"type": "string"},
                    "challenge_id": {"type": "string"},
                    "approve": {"type": "boolean"},
                    "approver": {"type": "string"},
                },
                "required": ["action", "app_id", "title", "pid"],
                "additionalProperties": False,
            },
        },
        {
            "name": "cua_execute_action",
            "description": "Authorize and execute a controlled single-window CUA step (GREEN read-only, YELLOW local draft, RED requires confirm_token).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "app_id": {"type": "string"},
                    "title": {"type": "string"},
                    "pid": {"type": "integer", "minimum": 1},
                    "target_label": {"type": "string", "default": ""},
                    "args": {"type": "object"},
                    "full_screen_capture": {"type": "boolean", "default": False},
                    "confirm_token": {"type": "string"},
                },
                "required": ["action", "app_id", "title", "pid"],
                "additionalProperties": False,
            },
        },
        {
            "name": "cua_trigger_emergency_stop",
            "description": "Engage the emergency-stop kill switch immediately and abort active CUA/MCP steps.",
            "inputSchema": {
                "type": "object",
                "properties": {"reason": {"type": "string", "default": "mcp_emergency_stop"}},
                "additionalProperties": False,
            },
        },
    ]


class WorkspaceMcpServer:
    """MCP JSON-RPC 2.0 stdio server governing local workspace docs and single-window CUA."""

    def __init__(
        self,
        root_dir: str | Path,
        *,
        emergency_stop: EmergencyStopController | None = None,
        cua_policy: CuaPolicyEngine | None = None,
        cua_executor: Callable[[str, WindowTarget, dict[str, Any]], dict[str, Any]] | None = None,
    ) -> None:
        self.sandbox = WorkspaceSandbox(root_dir)
        self.emergency_stop = emergency_stop or EmergencyStopController()
        self.cua_policy = cua_policy or CuaPolicyEngine()
        self._cua_executor = cua_executor
        self._initialized = False

    @staticmethod
    def _ok_tool_result(payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
            "structuredContent": payload,
            "isError": False,
        }

    @staticmethod
    def _error_tool_result(code: str, message: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = {"error": code, "message": message, **(extra or {})}
        return {
            "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
            "structuredContent": payload,
            "isError": True,
        }

    def _call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        # Emergency-stop tool and capability query bypass the blocked-step gate.
        if name == "cua_trigger_emergency_stop":
            reason = str(arguments.get("reason") or "mcp_emergency_stop")
            return self._ok_tool_result(self.emergency_stop.trigger(reason))

        if name == "workspace_capabilities":
            return self._ok_tool_result({
                "capabilities": inspect_capabilities(),
                "sandbox_root": str(self.sandbox.root_dir),
                "emergency_stop": self.emergency_stop.status(),
                "zero_llm_keys_enforced": True,
            })

        try:
            self.emergency_stop.assert_not_stopped("before_step")

            if name == "workspace_list_files":
                files = self.sandbox.list_files(
                    arguments.get("subdir", "."),
                    max_entries=int(arguments.get("max_entries", 200)),
                )
                result_payload = {"files": files, "count": len(files)}
            elif name == "workspace_parse_document":
                result_payload = parse_document(self.sandbox, arguments["path"])
            elif name == "workspace_build_docx_draft":
                result_payload = build_docx_draft(
                    self.sandbox,
                    arguments["output_path"],
                    title=str(arguments["title"]),
                    paragraphs=[str(p) for p in arguments.get("paragraphs", [])],
                    tables=arguments.get("tables"),
                )
            elif name == "workspace_build_pptx_draft":
                result_payload = build_pptx_draft(
                    self.sandbox,
                    arguments["output_path"],
                    title=str(arguments["title"]),
                    slides=list(arguments.get("slides", [])),
                )
            elif name == "workspace_build_xlsx_draft":
                result_payload = build_xlsx_draft(
                    self.sandbox,
                    arguments["output_path"],
                    sheet_name=str(arguments["sheet_name"]),
                    headers=[str(h) for h in arguments.get("headers", [])],
                    rows=list(arguments.get("rows", [])),
                )
            elif name == "workspace_render_preview":
                result_payload = render_libreoffice_preview(
                    self.sandbox,
                    arguments["input_path"],
                    arguments.get("output_dir", "previews"),
                )
            elif name == "cua_inspect_window":
                target = WindowTarget(
                    app_id=str(arguments["app_id"]),
                    title=str(arguments["title"]),
                    pid=int(arguments["pid"]),
                )
                auth = self.cua_policy.authorize_action(
                    "inspect_window",
                    target,
                    full_screen_capture=bool(arguments.get("full_screen_capture", False)),
                )
                redacted = redact_screen_text_detailed(str(arguments.get("captured_text", "")))
                sanitized = inspect_untrusted_screen_text(redacted["redacted_text"])
                result_payload = {
                    "tier": auth.tier.value,
                    "app_id": target.app_id,
                    "title": target.title,
                    "pid": target.pid,
                    "redactions": redacted["redactions"],
                    "presidio_active": redacted["presidio_active"],
                    "injection_detected": sanitized["injection_detected"],
                    "matched_injection_rules": sanitized["matched_rules"],
                    "stripped_invisible_chars": sanitized["stripped_invisible_chars"],
                    "safe_screen_text": sanitized["sanitized_text"],
                }
            elif name == "cua_request_confirmation":
                target = WindowTarget(
                    app_id=str(arguments["app_id"]),
                    title=str(arguments["title"]),
                    pid=int(arguments["pid"]),
                )
                if arguments.get("challenge_id") and arguments.get("approve"):
                    token = self.cua_policy.approve_confirmation(
                        str(arguments["challenge_id"]),
                        approver=str(arguments.get("approver") or "human-operator"),
                    )
                    result_payload = {
                        "status": "approved",
                        "challenge_id": str(arguments["challenge_id"]),
                        "confirm_token": token,
                    }
                else:
                    challenge = self.cua_policy.request_confirmation(
                        str(arguments["action"]),
                        target,
                        summary=str(arguments.get("summary") or ""),
                    )
                    result_payload = {
                        "status": "pending_human_confirmation",
                        "challenge_id": challenge.challenge_id,
                        "action": challenge.action,
                        "app_id": challenge.app_id,
                        "pid": challenge.pid,
                        "summary": challenge.summary,
                    }
            elif name == "cua_execute_action":
                target = WindowTarget(
                    app_id=str(arguments["app_id"]),
                    title=str(arguments["title"]),
                    pid=int(arguments["pid"]),
                )
                action_name = str(arguments["action"])
                action_args = dict(arguments.get("args") or {})
                auth = self.cua_policy.authorize_action(
                    action_name,
                    target,
                    full_screen_capture=bool(arguments.get("full_screen_capture", False)),
                    target_label=str(arguments.get("target_label") or ""),
                    args=action_args,
                    confirm_token=arguments.get("confirm_token"),
                )
                if self._cua_executor is not None:
                    exec_meta = self._cua_executor(action_name, target, action_args)
                else:
                    exec_meta = {"simulated": True, "action": action_name}
                result_payload = {
                    "status": "executed",
                    "tier": auth.tier.value,
                    "action": action_name,
                    "app_id": target.app_id,
                    "pid": target.pid,
                    "confirmed_by": auth.confirmed_by,
                    "result": exec_meta,
                }
            else:
                return self._error_tool_result("UNKNOWN_TOOL", f"Unknown tool: {name}")

            # Re-verify kill switch after step execution before returning completion.
            self.emergency_stop.assert_not_stopped("after_step")
            return self._ok_tool_result(result_payload)

        except EmergencyStopError as exc:
            return self._error_tool_result("EMERGENCY_STOPPED", str(exc), {"sequence": exc.sequence})
        except ConfirmationRequiredError as exc:
            return self._error_tool_result(
                exc.code,
                str(exc),
                {"requires_confirmation": True, "tier": ActionTier.RED.value, "action": exc.action},
            )
        except (SandboxViolationError, CuaPolicyViolation) as exc:
            return self._error_tool_result(exc.code, str(exc))
        except Exception as exc:
            return self._error_tool_result("TOOL_EXECUTION_ERROR", str(exc))

    def handle_request(self, request: dict[str, Any]) -> dict[str, Any] | None:
        """Handle a single JSON-RPC 2.0 request object (returns None for notifications)."""
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}

        if not isinstance(method, str):
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32600, "message": "Invalid Request: missing string method"},
            }

        if method == "notifications/initialized":
            return None

        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

        if method == "initialize":
            self._initialized = True
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": SERVER_INFO,
                },
            }

        if method == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"tools": _tool_definitions()},
            }

        if method == "tools/call":
            tool_name = params.get("name")
            arguments = params.get("arguments") or {}
            if not isinstance(tool_name, str) or not isinstance(arguments, dict):
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32602, "message": "Invalid params: expected {name, arguments}"},
                }
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": self._call_tool(tool_name, arguments),
            }

        if req_id is None:
            return None

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }

    def serve_stdio(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
        """Process newline-delimited JSON-RPC 2.0 requests from `stdin` until EOF."""
        for raw_line in stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as exc:
                err_resp = {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": f"Parse error: {exc}"},
                }
                stdout.write(json.dumps(err_resp, ensure_ascii=False) + "\n")
                stdout.flush()
                continue

            if not isinstance(payload, dict):
                err_resp = {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32600, "message": "Invalid Request: expected JSON object"},
                }
                stdout.write(json.dumps(err_resp, ensure_ascii=False) + "\n")
                stdout.flush()
                continue

            response = self.handle_request(payload)
            if response is not None:
                stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                stdout.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Theodic AIOS Local Workspace & CUA MCP Server")
    parser.add_argument("--root", default=".", help="Workspace sandbox root directory")
    parser.add_argument("--kill-switch-file", default=None, help="Optional kill-switch sentinel file path")
    args = parser.parse_args(argv)

    stop_ctrl = EmergencyStopController(kill_switch_file=args.kill_switch_file)
    server = WorkspaceMcpServer(args.root, emergency_stop=stop_ctrl)
    server.serve_stdio()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
