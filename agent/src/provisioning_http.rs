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

const MAX_PAIRING_JSON: usize = 16 * 1024;
const MAX_CREDENTIAL_JSON: usize = 8 * 1024;

#[derive(Deserialize)]
struct SuccessEnvelope<T> {
    ok: bool,
    data: T,
    meta: serde_json::Value,
}

fn checked_uuid(id: &str) -> Result<(), ProvisionError> {
    if uuid::Uuid::parse_str(id).is_ok_and(|parsed| !parsed.is_nil()) {
        Ok(())
    } else {
        Err(ProvisionError::InvalidResponse)
    }
}

impl ProvisioningHttp {
    async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &[&str],
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
        expected: StatusCode,
        limit: usize,
    ) -> Result<T, ProvisionError> {
        let mut url = self.origin.clone();
        {
            let mut segments = url.path_segments_mut().map_err(|_| ProvisionError::InvalidOrigin)?;
            segments.pop_if_empty();
            for segment in path {
                if segment.is_empty() || segment.contains(['\r', '\n']) || segment == &".." || segment == &"." {
                    return Err(ProvisionError::InvalidResponse);
                }
                segments.push(segment);
            }
        }
        let mut req = self.client.request(method, url).header(reqwest::header::ACCEPT, "application/json");
        for &(name, value) in headers {
            if value.is_empty() || value.contains(['\r', '\n']) {
                return Err(ProvisionError::InvalidResponse);
            }
            req = req.header(name, value);
        }
        if let Some(mut bytes) = body {
            if bytes.is_empty() || bytes.len() > limit {
                bytes.zeroize();
                return Err(ProvisionError::InvalidResponse);
            }
            req = req.header(reqwest::header::CONTENT_TYPE, "application/json").body(bytes);
        }
        let mut response = req.send().await.map_err(|_| ProvisionError::Unavailable)?;
        let status = response.status();
        if status != expected {
            return Err(if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                ProvisionError::Denied
            } else {
                ProvisionError::InvalidResponse
            });
        }
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|mime| mime.starts_with("application/json"))
        {
            return Err(ProvisionError::InvalidResponse);
        }
        let mut payload = Vec::new();
        while let Some(part) = response.chunk().await.map_err(|_| ProvisionError::Unavailable)? {
            if payload.len().saturating_add(part.len()) > limit {
                payload.zeroize();
                return Err(ProvisionError::InvalidResponse);
            }
            payload.extend_from_slice(&part);
        }
        let envelope: Result<SuccessEnvelope<T>, _> = serde_json::from_slice(&payload);
        payload.zeroize();
        let envelope = envelope.map_err(|_| ProvisionError::InvalidResponse)?;
        if !envelope.ok || !envelope.meta.is_object() {
            return Err(ProvisionError::InvalidResponse);
        }
        Ok(envelope.data)
    }
}

#[async_trait]
impl ProvisioningApi for ProvisioningHttp {
    async fn create_pairing(&self, registration: &PairingRegistration) -> Result<PairingStart, ProvisionError> {
        let body = serde_json::to_vec(registration).map_err(|_| ProvisionError::InvalidResponse)?;
        self.call(Method::POST, &["api","v1","pairings"], &[], Some(body), StatusCode::CREATED, MAX_PAIRING_JSON).await
    }

    async fn get_pairing(&self, pairing_id: &str, key_id: &str, installation_id: &str) -> Result<PairingStatus, ProvisionError> {
        for id in [pairing_id, key_id, installation_id] {
            checked_uuid(id)?;
        }
        self.call(Method::GET, &["api","v1","pairings", pairing_id],
            &[("x-telechir-device-key-id", key_id), ("x-telechir-device-installation-id", installation_id)],
            None, StatusCode::OK, MAX_PAIRING_JSON).await
    }

    async fn prove_device(&self, pairing_id: &str, proof: &PairingProof) -> Result<PairingActivation, ProvisionError> {
        checked_uuid(pairing_id)?;
        let body = serde_json::to_vec(proof).map_err(|_| ProvisionError::InvalidResponse)?;
        self.call(Method::POST, &["api","v1","pairings", pairing_id, "proof"],
            &[], Some(body), StatusCode::OK, MAX_PAIRING_JSON).await
    }

    async fn issue_credential(&self, device_id: &str, proof: &ConnectionCredentialProof) -> Result<CredentialResponse, ProvisionError> {
        checked_uuid(device_id)?;
        let body = serde_json::to_vec(proof).map_err(|_| ProvisionError::InvalidResponse)?;
        self.call(Method::POST, &["api","v1","devices",device_id,"connection-credential"],
            &[], Some(body), StatusCode::CREATED, MAX_CREDENTIAL_JSON).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn mock_http(response: String) -> (Url, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
                .await.unwrap().unwrap();
            let mut request = [0_u8; 8192];
            let read = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut request))
                .await.unwrap().unwrap();
            socket.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        (origin, task)
    }

    fn http_response(status: &str, body: &str, additional_headers: &str) -> String {
        format!(
            "HTTP/1.1 {status}\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n{additional_headers}\\r\\n{body}",
            body.len()
        ).replace("\\r\\n", "\r\n")
    }

    #[tokio::test]
    async fn provisioning_http_does_not_follow_redirect() {
        let redirect = http_response("302 Found", "", "Location: https://evil.example/");
        let (origin, server) = mock_http(redirect).await;
        let api = ProvisioningHttp::new(origin).unwrap();
        let a = "11111111-1111-4111-8111-111111111111";
        let b = "22222222-2222-4222-8222-222222222222";
        let c = "33333333-3333-4333-8333-333333333333";
        assert!(matches!(api.get_pairing(a, b, c).await, Err(ProvisionError::InvalidResponse)));
        let request = server.await.unwrap();
        assert!(request.starts_with(&format!("GET /api/v1/pairings/{a} ")));
        assert!(request.contains("x-telechir-device-key-id:"));
        assert!(request.contains("x-telechir-device-installation-id:"));
    }

    #[tokio::test]
    async fn provisioning_http_rejects_oversize_or_invalid_json() {
        for body in [
            "{malformed-json".to_owned(),
            "x".repeat(RESPONSE_LIMIT + 1),
        ] {
            let response = http_response("200 OK", &body, "Content-Type: application/json\\r\\n");
            let (origin, server) = mock_http(response).await;
            let api = ProvisioningHttp::new(origin).unwrap();
            let a = "11111111-1111-4111-8111-111111111111";
            let b = "22222222-2222-4222-8222-222222222222";
            let c = "33333333-3333-4333-8333-333333333333";
            assert!(matches!(api.get_pairing(a, b, c).await, Err(ProvisionError::InvalidResponse)));
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn provisioning_http_redacts_remote_error() {
        let body = r#"{\"ok\":false,\"error\":\"secret-device-token-DO-NOT-LOG\"}"#;
        let (origin, server) = mock_http(http_response("403 Forbidden", body, "")).await;
        let api = ProvisioningHttp::new(origin).unwrap();
        let a = "11111111-1111-4111-8111-111111111111";
        let b = "22222222-2222-4222-8222-222222222222";
        let c = "33333333-3333-4333-8333-333333333333";
        let result = api.get_pairing(a, b, c).await;
        assert!(matches!(result, Err(ProvisionError::Denied)));
        assert!(!format!("{result:?}").contains("secret-device-token"));
        server.await.unwrap();
    }

    #[test]
    fn provisioning_http_blocks_cross_origin_path_and_secret_debug() {
        assert!(matches!(
            ProvisioningHttp::new(Url::parse("https://example.com/other/").unwrap()),
            Err(ProvisionError::InvalidOrigin)
        ));
        let api = ProvisioningHttp::new(Url::parse("https://example.com/").unwrap()).unwrap();
        assert!(matches!(api.route("//evil.example/path"), Err(ProvisionError::InvalidResponse)));
        let secret = CredentialResponse {
            credential: "top-secret-token".to_owned(),
            expires_at: Utc::now(),
            websocket_path: "/api/v1/devices/synthetic/realtime".to_owned(),
        };
        assert!(!format!("{secret:?}").contains("top-secret-token"));
    }

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
