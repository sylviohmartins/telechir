//! Strict HTTPS, size-bounded provisioning adapter. No device network request is
//! made by constructing this adapter; calls require explicit pairing/session actions.
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use std::time::Duration;
use reqwest::{Client, StatusCode};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;
use thiserror::Error;
use url::{Host, Url};
use uuid::Uuid;
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

const RESPONSE_LIMIT: usize = 16 * 1024;
const PAIRING_REQUEST_LIMIT: usize = 16 * 1024;
const CREDENTIAL_REQUEST_LIMIT: usize = 8 * 1024;

#[derive(Deserialize)]
struct Envelope<T> {
    ok: bool,
    data: T,
}

fn valid_uuid(value: &str) -> Result<String, ProvisionError> {
    let value = Uuid::parse_str(value).map_err(|_| ProvisionError::InvalidResponse)?;
    if value.is_nil() {
        return Err(ProvisionError::InvalidResponse);
    }
    Ok(value.to_string())
}

impl ProvisioningHttp {
    pub fn new(origin: Url) -> Result<Self, ProvisionError> {
        let local = match origin.host() {
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            None => false,
        };
        let allowed_scheme = origin.scheme() == "https"
            || (origin.scheme() == "http" && local);
        if !allowed_scheme
            || origin.host().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
        {
            return Err(ProvisionError::InvalidOrigin);
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| ProvisionError::Unavailable)?;
        Ok(Self { origin, client })
    }

    fn route(&self, path: &str) -> Result<Url, ProvisionError> {
        self.origin
            .join(path)
            .map_err(|_| ProvisionError::InvalidResponse)
    }

    fn request_json<T: Serialize>(
        &self,
        builder: reqwest::RequestBuilder,
        body: &T,
        limit: usize,
    ) -> Result<reqwest::RequestBuilder, ProvisionError> {
        let serialized = serde_json::to_vec(body).map_err(|_| ProvisionError::InvalidResponse)?;
        if serialized.len() > limit {
            return Err(ProvisionError::InvalidResponse);
        }
        Ok(builder.header(reqwest::header::CONTENT_TYPE, "application/json").body(serialized))
    }

    async fn decode<T: DeserializeOwned>(
        &self,
        mut response: reqwest::Response,
        expected: StatusCode,
    ) -> Result<T, ProvisionError> {
        if response.status() != expected {
            return Err(if response.status() == StatusCode::UNAUTHORIZED
                || response.status() == StatusCode::FORBIDDEN
            {
                ProvisionError::Denied
            } else {
                ProvisionError::InvalidResponse
            });
        }
        if response.content_length().is_some_and(|size| size > RESPONSE_LIMIT as u64) {
            return Err(ProvisionError::InvalidResponse);
        }
        let mut collected = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ProvisionError::Unavailable)? {
            if chunk.len() > RESPONSE_LIMIT.saturating_sub(collected.len()) {
                return Err(ProvisionError::InvalidResponse);
            }
            collected.extend_from_slice(&chunk);
        }
        let envelope: Envelope<T> =
            serde_json::from_slice(&collected).map_err(|_| ProvisionError::InvalidResponse)?;
        if !envelope.ok {
            return Err(ProvisionError::InvalidResponse);
        }
        Ok(envelope.data)
    }
}

#[async_trait]
impl ProvisioningApi for ProvisioningHttp {
    async fn create_pairing(
        &self,
        registration: &PairingRegistration,
    ) -> Result<PairingStart, ProvisionError> {
        let url = self.route("api/v1/pairings")?;
        let request = self.request_json(
            self.client.post(url),
            registration,
            PAIRING_REQUEST_LIMIT,
        )?;
        let response = request.send().await.map_err(|_| ProvisionError::Unavailable)?;
        let start: PairingStart = self.decode(response, StatusCode::CREATED).await?;
        if valid_uuid(&start.pairing_id).is_err() || start.fingerprint != registration.fingerprint {
            return Err(ProvisionError::IdentityMismatch);
        }
        Ok(start)
    }

    async fn get_pairing(
        &self,
        pairing_id: &str,
        key_id: &str,
        installation_id: &str,
    ) -> Result<PairingStatus, ProvisionError> {
        let pairing_id = valid_uuid(pairing_id)?;
        let key_id = valid_uuid(key_id)?;
        let installation_id = valid_uuid(installation_id)?;
        let url = self.route(&format!("api/v1/pairings/{pairing_id}"))?;
        let response = self.client.get(url)
            .header("x-telechir-device-key-id", key_id)
            .header("x-telechir-device-installation-id", installation_id)
            .send().await.map_err(|_| ProvisionError::Unavailable)?;
        let status: PairingStatus = self.decode(response, StatusCode::OK).await?;
        if status.pairing_id != pairing_id {
            return Err(ProvisionError::IdentityMismatch);
        }
        Ok(status)
    }

    async fn prove_device(
        &self,
        pairing_id: &str,
        proof: &PairingProof,
    ) -> Result<PairingActivation, ProvisionError> {
        let pairing_id = valid_uuid(pairing_id)?;
        let url = self.route(&format!("api/v1/pairings/{pairing_id}/proof"))?;
        let request = self.request_json(self.client.post(url), proof, PAIRING_REQUEST_LIMIT)?;
        let response = request.send().await.map_err(|_| ProvisionError::Unavailable)?;
        let activation: PairingActivation = self.decode(response, StatusCode::OK).await?;
        if activation.state != PairingState::Active
            || activation.pairing_id != pairing_id
            || valid_uuid(&activation.device_id).is_err()
        {
            return Err(ProvisionError::InvalidResponse);
        }
        Ok(activation)
    }

    async fn issue_credential(
        &self,
        device_id: &str,
        proof: &ConnectionCredentialProof,
    ) -> Result<CredentialResponse, ProvisionError> {
        let device_id = valid_uuid(device_id)?;
        let url = self.route(&format!("api/v1/devices/{device_id}/connection-credential"))?;
        let request = self.request_json(self.client.post(url), proof, CREDENTIAL_REQUEST_LIMIT)?;
        let response = request.send().await.map_err(|_| ProvisionError::Unavailable)?;
        let credential: CredentialResponse = self.decode(response, StatusCode::CREATED).await?;
        if credential.websocket_path != format!("/api/v1/devices/{device_id}/realtime")
            || credential.credential.is_empty()
            || credential.credential.len() > 16 * 1024
        {
            return Err(ProvisionError::InvalidResponse);
        }
        Ok(credential)
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
