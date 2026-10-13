//! G1-A bounded localhost lab: real HTTP adapter, actual Ed25519 proofs,
//! simulated human-verification state, no WebSocket and no real device account.
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{Duration as ChronoDuration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

use telechir_agent::identity::{
    CONNECTION_PROOF_AUDIENCE, PAIRING_PROOF_AUDIENCE, DeviceIdentityManager,
    DevicePairingMetadata, MemoryIdentityStore, connection_credential_proof_message,
    pairing_proof_message,
};
use telechir_agent::provisioning::{
    AgentMetadata, PairingProgress, advance_pairing, begin_pairing, prepare_connection,
};
use telechir_agent::provisioning_http::{ProvisioningHttp, ProvisionError};
use telechir_agent::provisioning_store::{BindingError, DeviceBinding, DeviceBindingStore};

const PAIRING_ID: &str = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID: &str = "22222222-2222-4222-8222-222222222222";
const CHALLENGE: &str = "ci_challenge_not_from_real_account_abcdefghijklm";

#[derive(Default)]
struct LabBinding(Mutex<Option<DeviceBinding>>);

impl DeviceBindingStore for LabBinding {
    fn load(&self) -> Result<Option<DeviceBinding>, BindingError> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, binding: &DeviceBinding) -> Result<(), BindingError> {
        let mut guard = self.0.lock().unwrap();
        if guard.as_ref().is_some_and(|old| old != binding) {
            return Err(BindingError::InvalidBinding);
        }
        *guard = Some(binding.clone());
        Ok(())
    }
}

fn response(status: &str, data: Value) -> Vec<u8> {
    let body = json!({"ok": true, "data": data, "meta": {"request_id": "lab-only"}}).to_string();
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

async fn receive_http(
    stream: &mut tokio::net::TcpStream,
) -> (String, Value) {
    let mut incoming = Vec::new();
    let mut header_end = None;
    let mut length = None;
    loop {
        if let Some(split) = incoming.windows(4).position(|part| part == b"\r\n\r\n") {
            let end = split + 4;
            if header_end.is_none() {
                let headers = String::from_utf8_lossy(&incoming[..end]).to_ascii_lowercase();
                let content_length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|n| n.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                assert!(content_length < 16 * 1024);
                header_end = Some(end);
                length = Some(content_length);
            }
            if incoming.len() >= end + length.unwrap() {
                break;
            }
        }
        assert!(incoming.len() <= 17 * 1024, "oversize lab HTTP request");
        let mut buffer = [0u8; 4096];
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer))
            .await
            .unwrap()
            .unwrap();
        assert!(read != 0, "unexpected EOF while parsing HTTP");
        incoming.extend_from_slice(&buffer[..read]);
    }
    let end = header_end.unwrap();
    let header = String::from_utf8_lossy(&incoming[..end]).into_owned();
    let data = if length.unwrap() == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&incoming[end..end + length.unwrap()]).unwrap()
    };
    (header, data)
}

fn verify_proof(public_key: &[u8], text: String, signature: &str) {
    let key: [u8; 32] = public_key.try_into().unwrap();
    let verifying = VerifyingKey::from_bytes(&key).unwrap();
    let bytes = URL_SAFE_NO_PAD.decode(signature).unwrap();
    let sig = Signature::from_slice(&bytes).unwrap();
    verifying.verify(text.as_bytes(), &sig).unwrap();
}

#[tokio::test]
async fn provisioning_e2e_lab_user_approved_pairing_to_fresh_credential() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        let mut registration: Option<Value> = None;
        let mut verified_nonce: Option<String> = None;
        for stage in 0..4 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let (header, data) = receive_http(&mut stream).await;
            let now = (Utc::now() + ChronoDuration::minutes(5)).to_rfc3339();
            let issued = (Utc::now() + ChronoDuration::seconds(30)).to_rfc3339();
            let result = match stage {
                0 => {
                    assert!(header.starts_with("POST /api/v1/pairings "));
                    assert_eq!(data["algorithm"], "Ed25519");
                    registration = Some(data.clone());
                    response(
                        "201 Created",
                        json!({"pairing_id": PAIRING_ID, "user_code": "ABCD-EFGH",
                          "verification_uri": "https://example.org/pair",
                          "expires_at": now, "fingerprint": data["fingerprint"]}),
                    )
                }
                1 => {
                    assert!(header.starts_with(&format!("GET /api/v1/pairings/{PAIRING_ID} ")));
                    assert!(header.to_ascii_lowercase().contains("x-telechir-device-key-id:"));
                    let original = registration.as_ref().unwrap();
                    response(
                        "200 OK",
                        json!({"pairing_id": PAIRING_ID, "state": "USER_VERIFIED",
                          "expires_at": now, "fingerprint": original["fingerprint"],
                          "challenge": CHALLENGE}),
                    )
                }
                2 => {
                    assert!(header.starts_with(&format!("POST /api/v1/pairings/{PAIRING_ID}/proof ")));
                    let original = registration.as_ref().unwrap();
                    assert_eq!(data["device_key_id"], original["device_key_id"]);
                    assert_eq!(data["device_installation_id"], original["device_installation_id"]);
                    let public = URL_SAFE_NO_PAD.decode(original["public_key"].as_str().unwrap()).unwrap();
                    let canonical = pairing_proof_message(
                        PAIRING_ID, original["device_key_id"].as_str().unwrap(),
                        original["device_installation_id"].as_str().unwrap(),
                        CHALLENGE, PAIRING_PROOF_AUDIENCE,
                    ).unwrap();
                    verify_proof(&public, canonical, data["signature"].as_str().unwrap());
                    response("200 OK", json!({"pairing_id": PAIRING_ID, "state": "ACTIVE", "device_id": DEVICE_ID}))
                }
                3 => {
                    assert!(header.starts_with(&format!(
                        "POST /api/v1/devices/{DEVICE_ID}/connection-credential "
                    )));
                    let original = registration.as_ref().unwrap();
                    assert_eq!(data["device_key_id"], original["device_key_id"]);
                    let nonce = data["connection_nonce"].as_str().unwrap();
                    assert!((16..=128).contains(&nonce.len()));
                    verified_nonce = Some(nonce.to_owned());
                    let public = URL_SAFE_NO_PAD.decode(original["public_key"].as_str().unwrap()).unwrap();
                    let canonical = connection_credential_proof_message(
                        DEVICE_ID, original["device_key_id"].as_str().unwrap(), nonce,
                        data["requested_at"].as_str().unwrap(), CONNECTION_PROOF_AUDIENCE,
                    ).unwrap();
                    verify_proof(&public, canonical, data["signature"].as_str().unwrap());
                    response("201 Created", json!({
                      "credential": "synthetic_local_only_credential",
                      "expires_at": issued,
                      "websocket_path": format!("/api/v1/devices/{DEVICE_ID}/realtime"),
                    }))
                }
                _ => unreachable!(),
            };
            stream.write_all(&result).await.unwrap();
        }
        verified_nonce.unwrap()
    });

    let api = ProvisioningHttp::new(origin.clone()).unwrap();
    let identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
    let binding = LabBinding::default();
    let started = begin_pairing(
        &identity,
        &binding,
        &api,
        DevicePairingMetadata {
            display_name: "Lab Windows".to_owned(),
            os: "windows".to_owned(),
            arch: "x86_64".to_owned(),
            agent_version: "0.1.0".to_owned(),
        },
    )
    .await
    .unwrap();
    assert_eq!(started.pairing_id, PAIRING_ID);
    let activated = advance_pairing(&identity, &binding, &api, PAIRING_ID)
        .await
        .unwrap();
    let PairingProgress::Active(linked) = activated else {
        panic!("user-approved pairing did not activate");
    };
    assert_eq!(linked.device_id, DEVICE_ID);
    assert!(linked.matches(&identity.load_existing().unwrap().unwrap().public_identity()));

    let prepared = prepare_connection(
        &identity,
        &binding,
        &api,
        &origin,
        AgentMetadata {
            agent_version: "0.1.0".to_owned(),
            os: "windows".to_owned(),
            arch: "x86_64".to_owned(),
            capabilities: Vec::new(),
        },
        Utc::now(),
    )
    .await
    .unwrap();
    assert_eq!(prepared.config.device_id, DEVICE_ID);
    assert_eq!(
        prepared.config.websocket_url,
        format!("ws://127.0.0.1:{}/api/v1/devices/{DEVICE_ID}/realtime", origin.port().unwrap())
    );
    assert!(prepared.config.capabilities.is_empty());
    assert!(!format!("{:?}", prepared.credentials).contains("synthetic_local_only_credential"));
    let nonce = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(nonce.len(), 32);
}

#[tokio::test]
async fn provisioning_lab_missing_identity_blocks_before_any_http() {
    let origin = Url::parse("http://127.0.0.1:9/").unwrap();
    let api = ProvisioningHttp::new(origin.clone()).unwrap();
    let identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
    let binding = LabBinding::default();
    let result = prepare_connection(
        &identity, &binding, &api, &origin,
        AgentMetadata {
            agent_version: "0.1.0".to_owned(),
            os: "windows".to_owned(),
            arch: "x86_64".to_owned(),
            capabilities: Vec::new(),
        },
        Utc::now(),
    ).await;
    assert!(matches!(result, Err(ProvisionError::InvalidState)));
}
