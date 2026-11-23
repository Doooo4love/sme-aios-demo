# Theodic AIOS Desktop Harness (`desktop/`)

Cross-platform **Tauri 2** desktop shell for macOS (`.dmg` / `.app`) and Windows (`.msi` / `.exe`) wrapping the existing `web/` Next.js Enterprise Workbench UI while enforcing strict local security boundaries.

## Security Architecture

1. **Zero Local LLM API Keys**:
   - The desktop binary and local MCP sidecars **never** store or read `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `AIOS_LLM_API_KEY`.
   - All LLM inference stays in the cloud control plane (`aios_platform/`).
   - `src-tauri/src/keychain.rs` uses `keyring` v3 (`apple-native` `security-framework` on macOS Keychain, `windows-native` `wincred` on Windows Credential Manager) exclusively for short-lived, scoped device session tokens (max TTL 24h) and actively rejects LLM key prefixes (`sk-`, `AIza`, etc.).

2. **Least-Privilege Capabilities & Strict CSP**:
   - `src-tauri/capabilities/default.json` grants only window/event primitives and `global-shortcut` registration. Arbitrary shell execution (`shell:allow-execute`) and unrestricted filesystem access (`fs:allow-*`) are **omitted**.
   - `src-tauri/tauri.conf.json` configures a strict `Content-Security-Policy` (`script-src 'self'; object-src 'none'; frame-ancestors 'none'`) locked to loopback dev origins and the production cloud origin.

3. **Global Emergency Stop (`CmdOrCtrl+Escape`)**:
   - Wired via `tauri-plugin-global-shortcut` in `src-tauri/src/lib.rs` (`Cmd+Escape` on macOS, `Ctrl+Escape` on Windows/Linux).
   - Atomically cancels `DaemonState::active_run`, clears `kill_switch_latch`, clears pending confirmations, and emits the `"aios://emergency-stop"` window event to the Next.js `DesktopHarnessOverlay`.

4. **Rust IPC Commands (`src-tauri/src/ipc.rs`)**:
   - `get_daemon_status`
   - `register_device`
   - `trigger_emergency_stop`
   - `request_action_confirmation`
   - `revoke_local_token`

## Building on macOS & Windows CI

> **Note**: `rustc` / `cargo` are not preinstalled on lightweight developer/API hosts. Native desktop bundles are built on macOS and Windows CI runners (or workstations with the Rust toolchain + platform SDKs installed).

### Prerequisites

- **All platforms**: Node.js `>= 20`, `pnpm`, Rust stable (`rustup`, `cargo >= 1.77`).
- **macOS**: Xcode Command Line Tools (`xcode-select --install`). Produces `.app` and `.dmg`.
- **Windows**: Microsoft Visual Studio C++ Build Tools + WebView2 Runtime. Produces `.msi` (WiX) and `.exe` (NSIS).

### Commands

```bash
# Install Tauri CLI / JS bindings
pnpm --dir desktop install

# Run desktop shell against local Next.js dev server
pnpm --dir desktop dev

# Build production installers (macOS .dmg/.app or Windows .msi/.exe)
pnpm --dir desktop build
```
