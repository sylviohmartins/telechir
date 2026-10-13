//! Strict HTTPS, size-bounded provisioning adapter. No device network request is
//! made by constructing this adapter; calls require explicit pairing/session actions.
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;
use thiserror::Error;
use url::Url;
use zeroize::Zeroize;

use crate::identity::{ConnectionCredentialProof, PairingProof, PairingRegistration};

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum ProvisionError {
    #[error("provisioning origin is not a secure, trusted origin")]
    InvalidOrigin,
    #[error("invalid or oversized provisioning request/response")]
    InvalidResponse,
    #[error("device provisioning request was denied")]
    Denied,
    #[error("provisioning transport is unavailable")]
    Unavailable,
    #[error("device provisioning state is invalid")]
    InvalidState,
    #[error("device provisioning identity is invalid")]
    IdentityMismatch,
    #[error("device provisioning credential has expired")]
    Expired,
    #[error("device provisioning store is unavailable")]
    StoreUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PairingState {
    Created,
    UserVerified,
    DeviceProvedKey,
    Active,
    Expired,
    Revoked,
}

#[derive(Deserialize)]
pub struct PairingStart {
    pub pairing_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_at: DateTime<Utc>,
    pub fingerprint: String,
}

impl std::fmt::Debug for PairingStart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingStart")
            .field("pairing_id", &self.pairing_id)
            .field("user_code", &"[redacted]")
            .field("verification_uri", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .field("fingerprint", &self.fingerprint)
            .finish()
    }
}

#[derive(Deserialize)]
pub struct PairingStatus {
    pub pairing_id: String,
    pub state: PairingState,
    pub expires_at: DateTime<Utc>,
    pub fingerprint: String,
    pub challenge: Option<String>,
    pub device_id: Option<String>,
}

impl std::fmt::Debug for PairingStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingStatus")
            .field("pairing_id", &self.pairing_id)
            .field("state", &self.state)
            .field("expires_at", &self.expires_at)
            .field("fingerprint", &self.fingerprint)
            .field("challenge", &"[redacted]")
            .field("device_id", &self.device_id)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
pub struct PairingActivation {
    pub pairing_id: String,
    pub state: PairingState,
    pub device_id: String,
}

#[derive(Deserialize)]
pub struct CredentialResponse {
    pub credential: String,
    pub expires_at: DateTime<Utc>,
    pub websocket_path: String,
}

impl Drop for CredentialResponse {
    fn drop(&mut self) {
        self.credential.zeroize();
    }
}
impl std::fmt::Debug for CredentialResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialResponse")
            .field("credential", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .field("websocket_path", &self.websocket_path)
            .finish()
    }
}

#[async_trait]
pub trait ProvisioningApi: Send + Sync {
    async fn create_pairing(
        &self,
        registration: &PairingRegistration,
    ) -> Result<PairingStart, ProvisionError>;
    async fn get_pairing(
        &self,
        pairing_id: &str,
        key_id: &str,
        installation_id: &str,
    ) -> Result<PairingStatus, ProvisionError>;
    async fn prove_device(
        &self,
        pairing_id: &str,
        proof: &PairingProof,
    ) -> Result<PairingActivation, ProvisionError>;
    async fn issue_credential(
        &self,
        device_id: &str,
        proof: &ConnectionCredentialProof,
    ) -> Result<CredentialResponse, ProvisionError>;
}

pub struct ProvisioningHttp {
    origin: Url,
    client: Client,
}

impl ProvisioningHttp {
    pub fn new(origin: Url) -> Result<Self, ProvisionError> {
        // RED: validate HTTPS/loopback origin and redirect policy in GREEN.
        let client = Client::new();
        Ok(Self { origin, client })
    }
}

#[async_trait]
impl ProvisioningApi for ProvisioningHttp {
    async fn create_pairing(
        &self,
        _registration: &PairingRegistration,
    ) -> Result<PairingStart, ProvisionError> {
        let _ = (&self.origin, &self.client);
        Err(ProvisionError::Unavailable)
    }
    async fn get_pairing(
        &self,
        _pairing_id: &str,
        _key_id: &str,
        _installation_id: &str,
    ) -> Result<PairingStatus, ProvisionError> {
        Err(ProvisionError::Unavailable)
    }
    async fn prove_device(
        &self,
        _pairing_id: &str,
        _proof: &PairingProof,
    ) -> Result<PairingActivation, ProvisionError> {
        Err(ProvisionError::Unavailable)
    }
    async fn issue_credential(
        &self,
        _device_id: &str,
        _proof: &ConnectionCredentialProof,
    ) -> Result<CredentialResponse, ProvisionError> {
        Err(ProvisionError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provisioning_http_rejects_non_loopback_plaintext_or_url_credentials() {
        for url in [
            "http://example.com/",
            "http://10.0.0.22/",
            "https://user:secret@example.com/",
            "https://example.com/path",
            "https://example.com/?token=secret",
            "https://example.com/#fragment",
        ] {
            assert!(matches!(
                ProvisioningHttp::new(Url::parse(url).unwrap()),
                Err(ProvisionError::InvalidOrigin)
            ));
        }
        assert!(ProvisioningHttp::new(Url::parse("https://example.com/").unwrap()).is_ok());
        assert!(ProvisioningHttp::new(Url::parse("http://127.0.0.1:8988/").unwrap()).is_ok());
    }
}
