//! G1-D integrated Agent acceptance: pairing -> locally persisted identity
//! binding -> fresh signed credential -> actual WebSocket read-only policy,
//! durable audit -> controlled shutdown. ALL endpoints/data are CI loopback
//! fixtures; no OS keyring, external service, user device or LLM is used.
use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{Duration as ChronoDuration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json, to_value};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::timeout;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use url::Url;

use telechir_agent::host::{HostError, serve_foreground_with_executor};
use telechir_agent::host_readonly::{READ_ONLY_CAPABILITIES, ReadOnlyHostExecutor};
use telechir_agent::identity::{
    CONNECTION_PROOF_AUDIENCE, ConnectionCredentialProof, DeviceIdentityManager,
    DevicePairingMetadata, MemoryIdentityStore, PAIRING_PROOF_AUDIENCE, PairingProof,
    PairingRegistration, connection_credential_proof_message, pairing_proof_message,
};
use telechir_agent::protocol::{
    AgentHelloAck, CommandOperation, CommandRequest, ConnectionLimits, DeviceMessage, MessageType,
    PROTOCOL_VERSION, PermissionDomain,
};
use telechir_agent::provisioning::{PairingProgress, advance_pairing, begin_pairing};
use telechir_agent::provisioning_http::{
    CredentialResponse, PairingActivation, PairingStart, PairingState, PairingStatus,
    ProvisionError, ProvisioningApi,
};
use telechir_agent::provisioning_store::{BindingError, DeviceBinding, DeviceBindingStore};

const PAIRING_ID: &str = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID: &str = "22222222-2222-4222-8222-222222222222";
const CHALLENGE: &str = "g1d_loopback_challenge_not_for_production";

#[derive(Default)]
struct MemoryBinding {
    saved: Mutex<Option<DeviceBinding>>,
    writes: AtomicUsize,
}
impl DeviceBindingStore for MemoryBinding {
    fn load(&self) -> Result<Option<DeviceBinding>, BindingError> {
        Ok(self.saved.lock().unwrap().clone())
    }
    fn save(&self, value: &DeviceBinding) -> Result<(), BindingError> {
        let mut guard = self.saved.lock().unwrap();
        if let Some(existing) = guard.as_ref() {
            if existing != value {
                return Err(BindingError::InvalidBinding);
            }
        } else {
            self.writes.fetch_add(1, Ordering::SeqCst);
            *guard = Some(value.clone());
        }
        Ok(())
    }
}

#[derive(Default)]
struct VerifiedLoopbackApi {
    registration: Mutex<Option<PairingRegistration>>,
    confirmed_by_user: AtomicBool,
    disabled: AtomicBool,
    pairing_proofs: AtomicUsize,
    connection_proofs: AtomicUsize,
    nonces: Mutex<HashSet<String>>,
}

fn verify_signed(public: &str, payload: String, signature: &str) {
    let public_bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(public).unwrap().try_into().unwrap();
    let key = VerifyingKey::from_bytes(&public_bytes).unwrap();
    let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).unwrap()).unwrap();
    key.verify(payload.as_bytes(), &signature).unwrap();
}

#[async_trait]
impl ProvisioningApi for VerifiedLoopbackApi {
    async fn create_pairing(
        &self,
        registration: &PairingRegistration,
    ) -> Result<PairingStart, ProvisionError> {
        assert!(self.registration.lock().unwrap().is_none());
        *self.registration.lock().unwrap() = Some(registration.clone());
        Ok(PairingStart {
            pairing_id: PAIRING_ID.to_owned(),
            user_code: "CI-LOOPBACK".to_owned(),
            verification_uri: "https://example.invalid/activate".to_owned(),
            expires_at: Utc::now() + ChronoDuration::minutes(5),
            fingerprint: registration.fingerprint.clone(),
        })
    }

    async fn get_pairing(
        &self,
        pairing_id: &str,
        key_id: &str,
        installation_id: &str,
    ) -> Result<PairingStatus, ProvisionError> {
        assert_eq!(pairing_id, PAIRING_ID);
        let registration = self.registration.lock().unwrap();
        let registered = registration.as_ref().expect("pairing started");
        assert_eq!(key_id, registered.device_key_id);
        assert_eq!(installation_id, registered.device_installation_id);
        Ok(PairingStatus {
            pairing_id: PAIRING_ID.to_owned(),
            state: if self.confirmed_by_user.load(Ordering::SeqCst) {
                PairingState::UserVerified
            } else {
                PairingState::Created
            },
            expires_at: Utc::now() + ChronoDuration::minutes(5),
            fingerprint: registered.fingerprint.clone(),
            challenge: if self.confirmed_by_user.load(Ordering::SeqCst) {
                Some(CHALLENGE.to_owned())
            } else {
                None
            },
            device_id: None,
        })
    }

    async fn prove_device(
        &self,
        pairing_id: &str,
        proof: &PairingProof,
    ) -> Result<PairingActivation, ProvisionError> {
        assert!(self.confirmed_by_user.load(Ordering::SeqCst));
        let registration = self.registration.lock().unwrap();
        let registered = registration.as_ref().unwrap();
        assert_eq!(pairing_id, PAIRING_ID);
        assert_eq!(proof.device_key_id, registered.device_key_id);
        assert_eq!(
            proof.device_installation_id,
            registered.device_installation_id
        );
        verify_signed(
            &registered.public_key,
            pairing_proof_message(
                PAIRING_ID,
                &proof.device_key_id,
                &proof.device_installation_id,
                CHALLENGE,
                PAIRING_PROOF_AUDIENCE,
            )
            .unwrap(),
            &proof.signature,
        );
        self.pairing_proofs.fetch_add(1, Ordering::SeqCst);
        Ok(PairingActivation {
            pairing_id: PAIRING_ID.to_owned(),
            state: PairingState::Active,
            device_id: DEVICE_ID.to_owned(),
        })
    }

    async fn issue_credential(
        &self,
        device_id: &str,
        proof: &ConnectionCredentialProof,
    ) -> Result<CredentialResponse, ProvisionError> {
        if self.disabled.load(Ordering::SeqCst) {
            return Err(ProvisionError::Denied);
        }
        let registration = self.registration.lock().unwrap();
        let registered = registration.as_ref().ok_or(ProvisionError::Denied)?;
        if self.pairing_proofs.load(Ordering::SeqCst) == 0 {
            return Err(ProvisionError::Denied);
        }
        assert_eq!(device_id, DEVICE_ID);
        assert_eq!(proof.device_key_id, registered.device_key_id);
        let timestamp = chrono::DateTime::parse_from_rfc3339(&proof.requested_at).unwrap();
        assert!(
            (Utc::now() - timestamp.with_timezone(&Utc))
                .num_seconds()
                .abs()
                <= 60
        );
        assert!((16..=128).contains(&proof.connection_nonce.len()));
        verify_signed(
            &registered.public_key,
            connection_credential_proof_message(
                device_id,
                &proof.device_key_id,
                &proof.connection_nonce,
                &proof.requested_at,
                CONNECTION_PROOF_AUDIENCE,
            )
            .unwrap(),
            &proof.signature,
        );
        assert!(
            self.nonces
                .lock()
                .unwrap()
                .insert(proof.connection_nonce.clone())
        );
        self.connection_proofs.fetch_add(1, Ordering::SeqCst);
        Ok(CredentialResponse {
            credential: "short_lived_ci_loopback_only".to_owned(),
            expires_at: Utc::now() + ChronoDuration::seconds(30),
            websocket_path: format!("/api/v1/devices/{DEVICE_ID}/realtime"),
        })
    }
}

fn wire(kind: MessageType, payload: Value, seq: u64) -> DeviceMessage {
    DeviceMessage {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        message_type: kind,
        message_id: format!("g1d_message_{seq:04}"),
        correlation_id: None,
        device_id: DEVICE_ID.to_owned(),
        session_id: None,
        connection_id: Some("connection_g1d_loopback".to_owned()),
        sequence: seq,
        sent_at: Utc::now(),
        deadline_at: None,
        payload,
    }
}

#[tokio::test]
async fn g1d_agent_pairing_credential_readonly_revoke_and_durable_audit_loopback() {
    let identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
    let binding = MemoryBinding::default();
    let api = VerifiedLoopbackApi::default();
    let metadata = DevicePairingMetadata {
        display_name: "G1-D synthetic device".to_owned(),
        os: "windows".to_owned(),
        arch: "x86_64".to_owned(),
        agent_version: "0.1.0".to_owned(),
    };

    // No session is permitted before the human-confirmed pairing.
    let origin = Url::parse("http://127.0.0.1:8988/").unwrap();
    let mut never = telechir_agent::host::DenyAllHostExecutor;
    let early = serve_foreground_with_executor(
        &identity,
        &binding,
        &api,
        &origin,
        &mut never,
        vec![],
        std::future::pending(),
    )
    .await;
    assert!(matches!(
        early,
        Err(HostError::Provisioning(ProvisionError::InvalidState))
    ));
    assert_eq!(api.connection_proofs.load(Ordering::SeqCst), 0);

    let started = begin_pairing(&identity, &binding, &api, metadata)
        .await
        .unwrap();
    assert_eq!(started.pairing_id, PAIRING_ID);
    assert!(matches!(
        advance_pairing(&identity, &binding, &api, PAIRING_ID)
            .await
            .unwrap(),
        PairingProgress::WaitingForUser
    ));
    assert_eq!(binding.writes.load(Ordering::SeqCst), 0);
    assert_eq!(api.pairing_proofs.load(Ordering::SeqCst), 0);

    // This is a synthetic fixture switch, NOT a real human or dashboard.
    api.confirmed_by_user.store(true, Ordering::SeqCst);
    let paired = advance_pairing(&identity, &binding, &api, PAIRING_ID)
        .await
        .unwrap();
    assert!(matches!(paired, PairingProgress::Active(_)));
    assert_eq!(binding.writes.load(Ordering::SeqCst), 1);
    assert_eq!(api.pairing_proofs.load(Ordering::SeqCst), 1);

    // Existing binding is not silently overwritten by a second pairing.
    assert!(matches!(
        begin_pairing(
            &identity,
            &binding,
            &api,
            DevicePairingMetadata {
                display_name: "should fail".to_owned(),
                os: "windows".to_owned(),
                arch: "x86_64".to_owned(),
                agent_version: "0.1.0".to_owned()
            }
        )
        .await,
        Err(ProvisionError::InvalidState)
    ));

    let root = tempfile::tempdir().unwrap();
    let audit_dir = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("visible.txt"),
        "CI fixture without secrets",
    )
    .unwrap();
    let audit_path = audit_dir.path().join("g1d.jsonl");
    let mut executor = ReadOnlyHostExecutor::new_with_audit(root.path(), &audit_path).unwrap();

    // Disabled principal cannot obtain a new credential or open a socket.
    api.disabled.store(true, Ordering::SeqCst);
    let blocked = serve_foreground_with_executor(
        &identity,
        &binding,
        &api,
        &origin,
        &mut executor,
        READ_ONLY_CAPABILITIES
            .iter()
            .map(|x| (*x).to_owned())
            .collect(),
        std::future::pending(),
    )
    .await;
    assert!(matches!(
        blocked,
        Err(HostError::Provisioning(ProvisionError::Denied))
    ));

    api.disabled.store(false, Ordering::SeqCst);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let origin = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();

    let client = async {
        serve_foreground_with_executor(
            &identity,
            &binding,
            &api,
            &origin,
            &mut executor,
            READ_ONLY_CAPABILITIES
                .iter()
                .map(|x| (*x).to_owned())
                .collect(),
            async {
                let _ = stop_rx.await;
            },
        )
        .await
    };

    let server = async {
        let (tcp, _) = timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        let hello = timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let hello: DeviceMessage = serde_json::from_str(hello.to_text().unwrap()).unwrap();
        assert_eq!(hello.message_type, MessageType::AgentHello);
        assert_eq!(hello.device_id, DEVICE_ID);
        assert_eq!(hello.payload["capabilities"], json!(READ_ONLY_CAPABILITIES));

        let ack = AgentHelloAck {
            connection_id: "connection_g1d_loopback".to_owned(),
            selected_protocol_version: PROTOCOL_VERSION.to_owned(),
            server_time: Utc::now(),
            heartbeat_interval_seconds: 5,
            limits: ConnectionLimits::default(),
            policy_revision: None,
        };
        socket
            .send(Message::Text(
                serde_json::to_string(&wire(MessageType::AgentHelloAck, to_value(ack).unwrap(), 1))
                    .unwrap()
                    .into(),
            ))
            .await
            .unwrap();

        let mut read = CommandRequest::test_read_only();
        read.command_id = "g1d_private_command_id".to_owned();
        read.operation = CommandOperation::FsList;
        read.arguments = json!({"path": root.path().to_string_lossy()})
            .as_object()
            .unwrap()
            .clone();
        socket
            .send(Message::Text(
                serde_json::to_string(&wire(
                    MessageType::CommandRequest,
                    to_value(&read).unwrap(),
                    2,
                ))
                .unwrap()
                .into(),
            ))
            .await
            .unwrap();

        for expected in [MessageType::CommandAccepted, MessageType::CommandCompleted] {
            let response = timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let parsed: DeviceMessage = serde_json::from_str(response.to_text().unwrap()).unwrap();
            assert_eq!(parsed.message_type, expected);
        }
        let mut escalated = read.clone();
        escalated.command_id = "g1d_escalated_id".to_owned();
        escalated.requested_permissions = vec![PermissionDomain::FsWrite];
        socket
            .send(Message::Text(
                serde_json::to_string(&wire(
                    MessageType::CommandRequest,
                    to_value(escalated).unwrap(),
                    3,
                ))
                .unwrap()
                .into(),
            ))
            .await
            .unwrap();
        let refused = timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let refused: DeviceMessage = serde_json::from_str(refused.to_text().unwrap()).unwrap();
        assert_eq!(refused.message_type, MessageType::CommandFailed);
        assert_eq!(refused.payload["error"]["code"], "POLICY_DENIED");

        stop_tx.send(()).unwrap();
    };
    // No Send-bound task spawn: tests actual concurrent socket on one runtime.
    let (finished, ()) = timeout(Duration::from_secs(15), async {
        tokio::join!(client, server)
    })
    .await
    .unwrap();
    assert_eq!(finished, Ok(()));
    assert_eq!(api.connection_proofs.load(Ordering::SeqCst), 1);
    assert_eq!(api.nonces.lock().unwrap().len(), 1);
    let journal = std::fs::read_to_string(&audit_path).unwrap();
    let events: Vec<Value> = journal
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["event"]["decision"], "Allowed");
    assert_eq!(events[1]["event"]["decision"], "Completed");
    assert_eq!(events[2]["event"]["decision"], "Denied");
    assert!(!journal.contains("g1d_private_command_id"));
    assert!(!journal.contains("g1d_escalated_id"));
    assert!(!journal.contains("visible.txt"));
    assert!(!journal.contains(root.path().to_string_lossy().as_ref()));
}
