//! Cross-platform OS Keychain / Credential Manager storage for scoped device session tokens.
//!
//! Uses `keyring` v3 semantics:
//! - macOS: Apple Keychain via `security-framework` (`apple-native`)
//! - Windows: Windows Credential Manager via `wincred` (`windows-native`)
//!
//! SECURITY INVARIANT: The local desktop daemon MUST hold ZERO LLM API keys.
//! This module rejects any LLM provider key format before touching the OS keychain.

use keyring::{Entry, Error as KeyringError};
use std::fmt;

pub const KEYCHAIN_SERVICE_NAME: &str = "com.theodic.aios.device-token";
pub const MAX_DEVICE_TOKEN_TTL_SECS: u64 = 86_400; // 24 hours max short-lived device token

const FORBIDDEN_LLM_KEY_PREFIXES: &[&str] = &[
    "sk-",
    "sk-ant-",
    "sk-proj-",
    "aiza",
    "xai-",
    "gsk_",
    "hf_",
];

const FORBIDDEN_LLM_KEY_MARKERS: &[&str] = &[
    "deepseek_api_key",
    "openai_api_key",
    "anthropic_api_key",
    "gemini_api_key",
    "qwen_api_key",
    "aios_llm_api_key",
    "llm_api_key",
    "_api_key",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeychainError {
    InvalidDeviceId,
    InvalidToken(String),
    ForbiddenLlmSecret,
    TtlExceeded(u64),
    Backend(String),
}

impl fmt::Display for KeychainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDeviceId => write!(f, "device_id must be 3..=128 safe ASCII characters"),
            Self::InvalidToken(msg) => write!(f, "invalid device token: {msg}"),
            Self::ForbiddenLlmSecret => write!(
                f,
                "refusing to store LLM provider API key material on the desktop client"
            ),
            Self::TtlExceeded(ttl) => write!(
                f,
                "device session token TTL {ttl}s exceeds maximum {MAX_DEVICE_TOKEN_TTL_SECS}s"
            ),
            Self::Backend(msg) => write!(f, "os keychain backend error: {msg}"),
        }
    }
}

impl std::error::Error for KeychainError {}

pub fn active_backend_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos-keychain-security-framework"
    }
    #[cfg(target_os = "windows")]
    {
        "windows-credential-manager-wincred"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "keyring-platform-store"
    }
}

pub fn validate_device_id(device_id: &str) -> Result<String, KeychainError> {
    let trimmed = device_id.trim();
    if trimmed.len() < 3
        || trimmed.len() > 128
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(KeychainError::InvalidDeviceId);
    }
    Ok(trimmed.to_string())
}

pub fn reject_llm_api_key_material(value: &str) -> Result<(), KeychainError> {
    let normalized = value.trim().to_ascii_lowercase();
    if FORBIDDEN_LLM_KEY_PREFIXES
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
    {
        return Err(KeychainError::ForbiddenLlmSecret);
    }
    if FORBIDDEN_LLM_KEY_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return Err(KeychainError::ForbiddenLlmSecret);
    }
    Ok(())
}

pub fn validate_device_session_token(token: &str, ttl_seconds: u64) -> Result<String, KeychainError> {
    if ttl_seconds == 0 || ttl_seconds > MAX_DEVICE_TOKEN_TTL_SECS {
        return Err(KeychainError::TtlExceeded(ttl_seconds));
    }
    let trimmed = token.trim();
    if trimmed.len() < 16 || trimmed.len() > 2048 {
        return Err(KeychainError::InvalidToken(
            "token length must be between 16 and 2048 characters".to_string(),
        ));
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(KeychainError::InvalidToken(
            "token must not contain whitespace or control characters".to_string(),
        ));
    }
    reject_llm_api_key_material(trimmed)?;
    Ok(trimmed.to_string())
}

fn entry_for_device(device_id: &str) -> Result<Entry, KeychainError> {
    let clean_id = validate_device_id(device_id)?;
    let account = format!("device:{clean_id}");
    Entry::new(KEYCHAIN_SERVICE_NAME, &account).map_err(|e| KeychainError::Backend(e.to_string()))
}

pub fn store_device_token(
    device_id: &str,
    token: &str,
    ttl_seconds: u64,
) -> Result<(), KeychainError> {
    let clean_token = validate_device_session_token(token, ttl_seconds)?;
    let entry = entry_for_device(device_id)?;
    entry
        .set_password(&clean_token)
        .map_err(|e| KeychainError::Backend(e.to_string()))
}

pub fn load_device_token(device_id: &str) -> Result<Option<String>, KeychainError> {
    let entry = entry_for_device(device_id)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(KeychainError::Backend(err.to_string())),
    }
}

pub fn has_device_token(device_id: &str) -> Result<bool, KeychainError> {
    Ok(load_device_token(device_id)?.is_some())
}

pub fn delete_device_token(device_id: &str) -> Result<bool, KeychainError> {
    let entry = entry_for_device(device_id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(err) => Err(KeychainError::Backend(err.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_llm_keys_and_excessive_ttl() {
        assert_eq!(
            validate_device_session_token("sk-deepseek1234567890abcd", 3600),
            Err(KeychainError::ForbiddenLlmSecret)
        );
        assert_eq!(
            validate_device_session_token("DEEPSEEK_API_KEY=something1234", 3600),
            Err(KeychainError::ForbiddenLlmSecret)
        );
        assert_eq!(
            validate_device_session_token("devtok_scoped_session_abcdef123456", 90_000),
            Err(KeychainError::TtlExceeded(90_000))
        );
        assert!(validate_device_session_token("devtok_scoped_session_abcdef123456", 3600).is_ok());
    }
}
