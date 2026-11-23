# Theodic Local Workspace & Controlled CUA MCP Server (`mcp/workspace-server/`)

Local Python **MCP stdio** server running alongside the Tauri 2 Desktop shell (`desktop/`). Holds **zero LLM API keys** and confines all file, document, and desktop UI automation behind deterministic sandboxes, allowlists, redaction, and kill switches.

## Modules

- [`sandbox.py`](file:///Users/rexzheng/Documents/AIOS/mcp/workspace-server/sandbox.py): `WorkspaceSandbox(root_dir)` enforces `os.path.realpath` containment inside `root_dir`, rejecting `..` traversal, symlink escapes, system paths (`/etc`, `/etc/aios`, `/var/lib/aios`, `/opt/aios`), and sensitive files (`.env`, `.ssh`, `id_rsa`, `.sqlite`, `.reviewer-pass.local.json`, `SOUL.md`).
- [`document_tools.py`](file:///Users/rexzheng/Documents/AIOS/mcp/workspace-server/document_tools.py): API-first parsing & draft generation inside `WorkspaceSandbox`:
  - `inspect_capabilities()` probes optional OSS packages (`docling`, `markitdown`, `python-docx`, `python-pptx`, `openpyxl`, `playwright`, `presidio_analyzer`, `omniparser`) and `libreoffice` (`soffice`) without failing on stdlib-only hosts.
  - `parse_document()` parses `.txt`, `.md`, `.csv`, `.tsv`, `.json` natively, OOXML `.docx`/`.pptx`/`.xlsx` via optional libs or pure-stdlib ZIP/XML fallback, and `.pdf` via `docling`/`markitdown`.
  - `build_docx_draft()`, `build_pptx_draft()`, `build_xlsx_draft()`, and `render_libreoffice_preview()` (sanitized env, `shell=False`) stay strictly inside `WorkspaceSandbox`.
- [`cua_guard.py`](file:///Users/rexzheng/Documents/AIOS/mcp/workspace-server/cua_guard.py):
  - **Dual-OS Work-App Allowlist** (`WindowTarget(app_id, title, pid)`): macOS AX bundle IDs (`com.microsoft.Word`, `com.microsoft.Excel`, `com.microsoft.Powerpoint`, `com.apple.Safari`, `com.google.Chrome`, `com.kingsoft.wpsoffice`, etc.) + Windows UIA process names (`WINWORD.EXE`, `EXCEL.EXE`, `POWERPNT.EXE`, `chrome.exe`, `msedge.exe`, etc.); rejects Steam/Spotify/gaming/streaming apps and requires `full_screen_capture=False`.
  - **Three-Tier Classification**: `GREEN` (read-only auto), `YELLOW` (reversible local workspace draft), `RED` (outbound send/payment/delete/external submit/shell execution -> requires single-use `confirm_token`).
  - **Pre-Redaction PII/Secret Scrubber** (`redact_screen_text`) + **Indirect Prompt-Injection Sanitizer** (`sanitize_untrusted_screen_text`).
- [`server.py`](file:///Users/rexzheng/Documents/AIOS/mcp/workspace-server/server.py): Stdio JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `ping`) + `EmergencyStopController` checked before and after every step.

## Running Locally (Stdio)

```bash
/Users/rexzheng/Documents/AIOS/.venv/bin/python mcp/workspace-server/server.py --root /path/to/workspace
```
