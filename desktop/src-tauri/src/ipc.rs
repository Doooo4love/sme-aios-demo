//! Tauri 2 IPC command surface and shared atomic emergency-stop / device runtime state.

use crate::keychain::{
    active_backend_name, delete_device_token, has_device_token, reject_llm_api_key_material,
    store_device_token, validate_device_id, MAX_DEVICE_TOKEN_TTL_SECS,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

pub const EMERGENCY_STOP_EVENT: &str = "aios://emergency-stop";
pub const ACTION_CONFIRMATION_EVENT: &str = "aios://action-confirmation";

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
pub struct RegisteredDeviceMeta {
    pub device_id: String,
    pub device_name: String,
    pub tenant: String,
    pub subject: String,
    pub control_plane_url: String,
    pub scopes: Vec<String>,
    pub expires_at_epoch_s: u64,
    pub registered_at_epoch_s: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingConfirmation {
    pub confirmation_id: String,
    pub action: String,
    pub tier: String,
    pub app_id: String,
    pub window_title: String,
    pub summary: String,
    pub created_at_epoch_s: u64,
    pub expires_at_epoch_s: u64,
    pub approved: bool,
}

pub struct DaemonState {
    /// Atomic flag indicating whether any CUA or local workspace MCP step is active.
    pub active_run: AtomicBool,
    /// Atomic execution latch cleared immediately when `CmdOrCtrl+Escape` or emergency stop triggers.
    pub kill_switch_latch: AtomicBool,
    /// Monotonically incremented counter of emergency-stop invocations.
    pub emergency_stop_count: AtomicU64,
    pub last_stop_epoch_ms: AtomicU64,
    pub confirmation_seq: AtomicU64,
    pub last_stop_reason: Mutex<Option<String>>,
    pub registered_device: Mutex<Option<RegisteredDeviceMeta>>,
    pub pending_confirmations: Mutex<HashMap<String, PendingConfirmation>>,
}

impl Default for DaemonState {
    fn default() -> Self {
        Self {
            active_run: AtomicBool::new(false),
            kill_switch_latch: AtomicBool::new(false),
            emergency_stop_count: AtomicU64::new(0),
            last_stop_epoch_ms: AtomicU64::new(0),
            confirmation_seq: AtomicU64::new(0),
            last_stop_reason: Mutex::new(None),
            registered_device: Mutex::new(None),
            pending_confirmations: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EmergencyStopPayload {
    pub stopped: bool,
    pub previous_active_run: bool,
    pub active_run: bool,
    pub kill_switch_latch: bool,
    pub sequence: u64,
    pub reason: String,
    pub source: String,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DaemonStatusResponse {
    pub status: String,
    pub platform: &'static str,
    pub keychain_backend: &'static str,
    pub device_registered: bool,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub tenant: Option<String>,
    pub control_plane_url: Option<String>,
    pub scopes: Vec<String>,
    pub token_expires_at_epoch_s: Option<u64>,
    pub has_local_token: bool,
    pub active_run: bool,
    pub kill_switch_latch: bool,
    pub emergency_stop_count: u64,
    pub last_stop_reason: Option<String>,
    pub last_stop_epoch_ms: Option<u64>,
    pub pending_confirmations: usize,
    pub zero_llm_keys_enforced: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegisterDeviceRequest {
    pub device_id: String,
    pub device_name: String,
    pub tenant: String,
    pub subject: String,
    pub control_plane_url: String,
    pub scoped_session_token: String,
    pub ttl_seconds: Option<u64>,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegisterDeviceResponse {
    pub registered: bool,
    pub device_id: String,
    pub tenant: String,
    pub control_plane_url: String,
    pub scopes: Vec<String>,
    pub expires_at_epoch_s: u64,
    pub keychain_backend: &'static str,
    pub token_stored_in_keychain: bool,
    pub zero_llm_keys_enforced: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActionConfirmationRequest {
    pub action: String,
    pub tier: Option<String>,
    pub app_id: String,
    pub window_title: String,
    pub summary: String,
    pub confirmation_id: Option<String>,
    pub approved: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionConfirmationResponse {
    pub confirmation_id: String,
    pub action: String,
    pub tier: String,
    pub requires_human_confirmation: bool,
    pub approved: bool,
    pub status: String,
    pub expires_at_epoch_s: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RevokeTokenResponse {
    pub revoked: bool,
    pub deleted_from_keychain: bool,
    pub active_run: bool,
    pub kill_switch_latch: bool,
}

fn validate_control_plane_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let allowed = lower.starts_with("https://")
        || lower.starts_with("http://127.0.0.1")
        || lower.starts_with("http://localhost");
    if !allowed || trimmed.contains(char::is_whitespace) || trimmed.len() > 256 {
        return Err(
            "control_plane_url must use https:// or loopback http://127.0.0.1 / http://localhost"
                .to_string(),
        );
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

fn validate_scopes(scopes: &[String]) -> Result<Vec<String>, String> {
    if scopes.is_empty() || scopes.len() > 16 {
        return Err("scopes must contain 1 to 16 explicit capability entries".to_string());
    }
    let mut normalized = Vec::with_capacity(scopes.len());
    for scope in scopes {
        let s = scope.trim();
        let lower = s.to_ascii_lowercase();
        if s.is_empty()
            || s == "*"
            || lower.contains("llm")
            || lower.contains("api_key")
            || lower.contains("admin:*")
            || !s
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '-' | '_'))
        {
            return Err(format!("invalid or overly broad device scope: {s}"));
        }
        normalized.push(s.to_string());
    }
    Ok(normalized)
}

/// Atomically cancels active CUA/MCP runs, clears the execution latch, and emits `aios://emergency-stop`.
pub fn execute_emergency_stop(
    app: &AppHandle,
    state: &DaemonState,
    reason: &str,
    source: &str,
) -> Result<EmergencyStopPayload, String> {
    let previous_active_run = state.active_run.swap(false, Ordering::SeqCst);
    state.kill_switch_latch.store(false, Ordering::SeqCst);
    let sequence = state.emergency_stop_count.fetch_add(1, Ordering::SeqCst) + 1;
    let timestamp_ms = now_epoch_ms();
    state.last_stop_epoch_ms.store(timestamp_ms, Ordering::SeqCst);

    let clean_reason = if reason.trim().is_empty() {
        "user_emergency_stop".to_string()
    } else {
        reason.trim().chars().take(160).collect()
    };

    if let Ok(mut guard) = state.last_stop_reason.lock() {
        *guard = Some(clean_reason.clone());
    }
    if let Ok(mut pending) = state.pending_confirmations.lock() {
        pending.clear();
    }

    let payload = EmergencyStopPayload {
        stopped: true,
        previous_active_run,
        active_run: false,
        kill_switch_latch: false,
        sequence,
        reason: clean_reason,
        source: source.to_string(),
        timestamp_ms,
    };

    app.emit(EMERGENCY_STOP_EVENT, &payload)
        .map_err(|e| format!("failed to emit emergency-stop event: {e}"))?;

    Ok(payload)
}

#[tauri::command]
pub fn get_daemon_status(state: State<'_, DaemonState>) -> Result<DaemonStatusResponse, String> {
    let meta = state
        .registered_device
        .lock()
        .map_err(|_| "device state lock poisoned".to_string())?
        .clone();

    let pending_count = state
        .pending_confirmations
        .lock()
        .map_err(|_| "confirmation state lock poisoned".to_string())?
        .len();

    let last_reason = state
        .last_stop_reason
        .lock()
        .map_err(|_| "stop reason lock poisoned".to_string())?
        .clone();

    let has_local_token = match &meta {
        Some(device) => has_device_token(&device.device_id).unwrap_or(false),
        None => false,
    };

    let last_stop_ms = state.last_stop_epoch_ms.load(Ordering::SeqCst);
    let active_run = state.active_run.load(Ordering::SeqCst);

    Ok(DaemonStatusResponse {
        status: if active_run { "running" } else { "idle" }.to_string(),
        platform: std::env::consts::OS,
        keychain_backend: active_backend_name(),
        device_registered: meta.is_some(),
        device_id: meta.as_ref().map(|m| m.device_id.clone()),
        device_name: meta.as_ref().map(|m| m.device_name.clone()),
        tenant: meta.as_ref().map(|m| m.tenant.clone()),
        control_plane_url: meta.as_ref().map(|m| m.control_plane_url.clone()),
        scopes: meta.as_ref().map(|m| m.scopes.clone()).unwrap_or_default(),
        token_expires_at_epoch_s: meta.as_ref().map(|m| m.expires_at_epoch_s),
        has_local_token,
        active_run,
        kill_switch_latch: state.kill_switch_latch.load(Ordering::SeqCst),
        emergency_stop_count: state.emergency_stop_count.load(Ordering::SeqCst),
        last_stop_reason: last_reason,
        last_stop_epoch_ms: if last_stop_ms > 0 {
            Some(last_stop_ms)
        } else {
            None
        },
        pending_confirmations: pending_count,
        zero_llm_keys_enforced: true,
    })
}

#[tauri::command]
pub fn register_device(
    request: RegisterDeviceRequest,
    state: State<'_, DaemonState>,
) -> Result<RegisterDeviceResponse, String> {
    let device_id = validate_device_id(&request.device_id).map_err(|e| e.to_string())?;
    let control_plane_url = validate_control_plane_url(&request.control_plane_url)?;
    let scopes = validate_scopes(&request.scopes)?;

    let device_name = request.device_name.trim();
    if device_name.is_empty() || device_name.len() > 120 {
        return Err("device_name must be 1..=120 characters".to_string());
    }
    let tenant = request.tenant.trim();
    let subject = request.subject.trim();
    if tenant.is_empty() || subject.is_empty() {
        return Err("tenant and subject are required".to_string());
    }

    reject_llm_api_key_material(&request.scoped_session_token).map_err(|e| e.to_string())?;
    let ttl_seconds = request.ttl_seconds.unwrap_or(3600).min(MAX_DEVICE_TOKEN_TTL_SECS);
    store_device_token(&device_id, &request.scoped_session_token, ttl_seconds)
        .map_err(|e| e.to_string())?;

    let now_s = now_epoch_secs();
    let expires_at = now_s.saturating_add(ttl_seconds);

    let meta = RegisteredDeviceMeta {
        device_id: device_id.clone(),
        device_name: device_name.to_string(),
        tenant: tenant.to_string(),
        subject: subject.to_string(),
        control_plane_url: control_plane_url.clone(),
        scopes: scopes.clone(),
        expires_at_epoch_s: expires_at,
        registered_at_epoch_s: now_s,
    };

    let mut guard = state
        .registered_device
        .lock()
        .map_err(|_| "device state lock poisoned".to_string())?;
    *guard = Some(meta);

    Ok(RegisterDeviceResponse {
        registered: true,
        device_id,
        tenant: tenant.to_string(),
        control_plane_url,
        scopes,
        expires_at_epoch_s: expires_at,
        keychain_backend: active_backend_name(),
        token_stored_in_keychain: true,
        zero_llm_keys_enforced: true,
    })
}

#[tauri::command]
pub fn trigger_emergency_stop(
    reason: Option<String>,
    app: AppHandle,
    state: State<'_, DaemonState>,
) -> Result<EmergencyStopPayload, String> {
    execute_emergency_stop(
        &app,
        &state,
        reason.as_deref().unwrap_or("ipc_emergency_stop"),
        "ipc",
    )
}

#[tauri::command]
pub fn request_action_confirmation(
    request: ActionConfirmationRequest,
    app: AppHandle,
    state: State<'_, DaemonState>,
) -> Result<ActionConfirmationResponse, String> {
    let action = request.action.trim();
    let app_id = request.app_id.trim();
    let window_title = request.window_title.trim();
    let summary = request.summary.trim();

    if action.is_empty() || app_id.is_empty() || window_title.is_empty() || summary.is_empty() {
        return Err("action, app_id, window_title, and summary are required".to_string());
    }

    let tier = request
        .tier
        .as_deref()
        .unwrap_or("RED")
        .trim()
        .to_ascii_uppercase();
    let now_s = now_epoch_secs();

    if let (Some(existing_id), Some(approved)) =
        (request.confirmation_id.as_deref(), request.approved)
    {
        let mut pending = state
            .pending_confirmations
            .lock()
            .map_err(|_| "confirmation state lock poisoned".to_string())?;
        let record = pending
            .remove(existing_id)
            .ok_or_else(|| "confirmation challenge not found or already consumed".to_string())?;
        if now_s > record.expires_at_epoch_s {
            return Err("confirmation challenge expired".to_string());
        }
        return Ok(ActionConfirmationResponse {
            confirmation_id: record.confirmation_id,
            action: record.action,
            tier: record.tier,
            requires_human_confirmation: true,
            approved,
            status: if approved {
                "approved_by_human".to_string()
            } else {
                "rejected_by_human".to_string()
            },
            expires_at_epoch_s: record.expires_at_epoch_s,
        });
    }

    let seq = state.confirmation_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let confirmation_id = format!("confirm-{now_s}-{seq}");
    let expires_at = now_s.saturating_add(300);

    let challenge = PendingConfirmation {
        confirmation_id: confirmation_id.clone(),
        action: action.to_string(),
        tier: tier.clone(),
        app_id: app_id.to_string(),
        window_title: window_title.to_string(),
        summary: summary.chars().take(280).collect(),
        created_at_epoch_s: now_s,
        expires_at_epoch_s: expires_at,
        approved: false,
    };

    {
        let mut pending = state
            .pending_confirmations
            .lock()
            .map_err(|_| "confirmation state lock poisoned".to_string())?;
        pending.insert(confirmation_id.clone(), challenge.clone());
    }

    app.emit(ACTION_CONFIRMATION_EVENT, &challenge)
        .map_err(|e| format!("failed to emit action confirmation event: {e}"))?;

    Ok(ActionConfirmationResponse {
        confirmation_id,
        action: challenge.action,
        tier,
        requires_human_confirmation: true,
        approved: false,
        status: "pending_human_confirmation".to_string(),
        expires_at_epoch_s: expires_at,
    })
}

#[tauri::command]
pub fn revoke_local_token(state: State<'_, DaemonState>) -> Result<RevokeTokenResponse, String> {
    state.active_run.store(false, Ordering::SeqCst);
    state.kill_switch_latch.store(false, Ordering::SeqCst);

    let previous = {
        let mut guard = state
            .registered_device
            .lock()
            .map_err(|_| "device state lock poisoned".to_string())?;
        guard.take()
    };

    if let Ok(mut pending) = state.pending_confirmations.lock() {
        pending.clear();
    }

    let deleted_from_keychain = match previous {
        Some(device) => delete_device_token(&device.device_id).map_err(|e| e.to_string())?,
        None => false,
    };

    Ok(RevokeTokenResponse {
        revoked: true,
        deleted_from_keychain,
        active_run: false,
        kill_switch_latch: false,
    })
}
