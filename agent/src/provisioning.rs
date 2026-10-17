//! Explicit, user-verified device pairing. This layer never opens a WebSocket.
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use url::{Host, Url};
use uuid::Uuid;

use crate::identity::{
    DeviceIdentityManager, DeviceIdentityStore, DevicePairingMetadata, PAIRING_PROOF_AUDIENCE,
};
use crate::provisioning_http::{PairingStart, PairingState, ProvisionError, ProvisioningApi};
use crate::provisioning_store::{BindingError, DeviceBinding, DeviceBindingStore};
use crate::realtime::{DEFAULT_HANDSHAKE_TIMEOUT, RealtimeClientConfig, new_connection_nonce};
use crate::runtime::SessionCredentials;

fn valid_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uuid| !uuid.is_nil())
}

fn store_error(error: BindingError) -> ProvisionError {
    match error {
        BindingError::InvalidBinding => ProvisionError::IdentityMismatch,
        BindingError::StoreUnavailable => ProvisionError::StoreUnavailable,
    }
}

#[derive(Debug, Clone)]
pub struct AgentMetadata {
    pub agent_version: String,
    pub os: String,
    pub arch: String,
    pub capabilities: Vec<String>,
}

pub struct PreparedConnection {
    pub config: RealtimeClientConfig,
    pub credentials: SessionCredentials,
}

/// Prepare a fresh proof and credential without opening a socket. A host may
/// consume this only after separately approving an operational session.
pub async fn prepare_connection<S, B, A>(
    identity: &DeviceIdentityManager<S>,
    binding: &B,
    api: &A,
    origin: &Url,
    metadata: AgentMetadata,
    now: DateTime<Utc>,
) -> Result<PreparedConnection, ProvisionError>
where
    S: DeviceIdentityStore,
    B: DeviceBindingStore,
    A: ProvisioningApi,
{
    // Caller must supply an origin authorized by the host. No URL from a
    // server response can replace this origin or expand its authority.
    let local = match origin.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    if !(origin.scheme() == "https" || (origin.scheme() == "http" && local))
        || origin.host().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return Err(ProvisionError::InvalidOrigin);
    }
    if !metadata.capabilities.is_empty()
        || [
            metadata.agent_version.as_str(),
            metadata.os.as_str(),
            metadata.arch.as_str(),
        ]
        .iter()
        .any(|value| value.is_empty() || value.len() > 64 || value.chars().any(char::is_control))
        || Utc::now().signed_duration_since(now).num_seconds().abs() > 30
    {
        // G1-A cannot authorize screen/input/browser/sandbox. G1-C owns the
        // eventual capabilities policy and the trusted runtime clock.
        return Err(ProvisionError::InvalidState);
    }
    let device = identity
        .load_existing()
        .map_err(|_| ProvisionError::StoreUnavailable)?
        .ok_or(ProvisionError::InvalidState)?;
    let public = device.public_identity();
    let association = binding
        .load()
        .map_err(store_error)?
        .ok_or(ProvisionError::InvalidState)?;
    if !association.matches(&public) {
        return Err(ProvisionError::IdentityMismatch);
    }
    let nonce = new_connection_nonce().map_err(|_| ProvisionError::Unavailable)?;
    let at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let proof = device
        .sign_connection_credential_request(&association.device_id, &nonce, &at)
        .map_err(|_| ProvisionError::InvalidState)?;
    let mut issued = api.issue_credential(&association.device_id, &proof).await?;
    if issued.expires_at <= Utc::now()
        || issued.expires_at > now + ChronoDuration::seconds(60)
        || issued.websocket_path != format!("/api/v1/devices/{}/realtime", association.device_id)
        || issued.credential.is_empty()
        || issued.credential.len() > 16 * 1024
        || issued.credential.bytes().any(|ch| !ch.is_ascii_graphic())
    {
        return Err(ProvisionError::InvalidResponse);
    }
    let mut websocket = origin.clone();
    websocket
        .set_scheme(if origin.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|_| ProvisionError::InvalidOrigin)?;
    websocket.set_path(&issued.websocket_path);
    let config = RealtimeClientConfig {
        websocket_url: websocket.to_string(),
        device_id: association.device_id,
        device_key_id: public.device_key_id,
        agent_version: metadata.agent_version,
        os: metadata.os,
        arch: metadata.arch,
        capabilities: metadata.capabilities,
        handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
    };
    config
        .validate()
        .map_err(|_| ProvisionError::InvalidOrigin)?;
    let credentials = SessionCredentials::new(std::mem::take(&mut issued.credential), nonce)
        .map_err(|_| ProvisionError::InvalidResponse)?;
    Ok(PreparedConnection {
        config,
        credentials,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairingProgress {
    WaitingForUser,
    Active(DeviceBinding),
    Expired,
    Revoked,
}

/// Only an explicit caller may start pairing and create a new local identity.
pub async fn begin_pairing<S, B, A>(
    identity: &DeviceIdentityManager<S>,
    binding: &B,
    api: &A,
    metadata: DevicePairingMetadata,
) -> Result<PairingStart, ProvisionError>
where
    S: DeviceIdentityStore,
    B: DeviceBindingStore,
    A: ProvisioningApi,
{
    // Existing pairing cannot be silently overwritten or transferred.
    if binding.load().map_err(store_error)?.is_some() {
        return Err(ProvisionError::InvalidState);
    }
    if metadata.display_name.trim().is_empty()
        || metadata.display_name.len() > 128
        || metadata.display_name.chars().any(char::is_control)
        || [
            metadata.os.as_str(),
            metadata.arch.as_str(),
            metadata.agent_version.as_str(),
        ]
        .iter()
        .any(|value| value.is_empty() || value.len() > 64 || value.chars().any(char::is_control))
    {
        return Err(ProvisionError::InvalidState);
    }
    // Key creation is ONLY allowed in this explicitly invoked pairing action.
    let device = identity
        .load_or_generate()
        .map_err(|_| ProvisionError::StoreUnavailable)?;
    let public = device.public_identity();
    let started = api
        .create_pairing(&device.pairing_registration(metadata))
        .await?;
    let now = Utc::now();
    let verification =
        Url::parse(&started.verification_uri).map_err(|_| ProvisionError::InvalidResponse)?;
    if !valid_uuid(&started.pairing_id)
        || started.fingerprint != public.fingerprint
        || started.expires_at <= now
        || started.expires_at > now + ChronoDuration::minutes(10)
        || started.user_code.is_empty()
        || started.user_code.len() > 64
        || started.user_code.chars().any(char::is_control)
        || verification.scheme() != "https"
        || verification.host().is_none()
        || !verification.username().is_empty()
        || verification.password().is_some()
        || verification.fragment().is_some()
    {
        return Err(ProvisionError::InvalidResponse);
    }
    Ok(started)
}

/// Only verified pairing may produce a device association in the OS keyring.
pub async fn advance_pairing<S, B, A>(
    identity: &DeviceIdentityManager<S>,
    binding: &B,
    api: &A,
    pairing_id: &str,
) -> Result<PairingProgress, ProvisionError>
where
    S: DeviceIdentityStore,
    B: DeviceBindingStore,
    A: ProvisioningApi,
{
    if !valid_uuid(pairing_id) {
        return Err(ProvisionError::InvalidState);
    }
    // Never create an identity while polling for a pairing or preparing a session.
    let device = identity
        .load_existing()
        .map_err(|_| ProvisionError::StoreUnavailable)?
        .ok_or(ProvisionError::InvalidState)?;
    let public = device.public_identity();
    let previous = binding.load().map_err(store_error)?;
    if previous
        .as_ref()
        .is_some_and(|saved| !saved.matches(&public))
    {
        return Err(ProvisionError::IdentityMismatch);
    }
    let status = api
        .get_pairing(
            pairing_id,
            &public.device_key_id,
            &public.device_installation_id,
        )
        .await?;
    if status.pairing_id != pairing_id || status.fingerprint != public.fingerprint {
        return Err(ProvisionError::IdentityMismatch);
    }
    match status.state {
        PairingState::Created | PairingState::DeviceProvedKey => {
            return Ok(PairingProgress::WaitingForUser);
        }
        PairingState::Expired => return Ok(PairingProgress::Expired),
        PairingState::Revoked => return Ok(PairingProgress::Revoked),
        PairingState::Active => {
            // A status alone does not authorize a new keyring binding. A prior
            // validated, identity-matching activation must already exist.
            return match (previous, status.device_id) {
                (Some(saved), Some(device_id)) if saved.device_id == device_id => {
                    Ok(PairingProgress::Active(saved))
                }
                _ => Err(ProvisionError::InvalidState),
            };
        }
        PairingState::UserVerified => {}
    }
    if previous.is_some() || status.expires_at <= Utc::now() || status.device_id.is_some() {
        return Err(ProvisionError::InvalidState);
    }
    let challenge = status.challenge.ok_or(ProvisionError::InvalidResponse)?;
    if challenge.is_empty() || challenge.len() > 512 || challenge.chars().any(char::is_control) {
        return Err(ProvisionError::InvalidResponse);
    }
    let proof = device
        .sign_pairing_proof(pairing_id, &challenge, PAIRING_PROOF_AUDIENCE)
        .map_err(|_| ProvisionError::InvalidResponse)?;
    let activated = api.prove_device(pairing_id, &proof).await?;
    if activated.state != PairingState::Active || activated.pairing_id != pairing_id {
        return Err(ProvisionError::InvalidResponse);
    }
    let association = DeviceBinding::new(activated.device_id, &public).map_err(store_error)?;
    binding.save(&association).map_err(store_error)?;
    Ok(PairingProgress::Active(association))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use chrono::{Duration, Utc};

    use super::*;
    use crate::identity::{
        ConnectionCredentialProof, DevicePublicIdentity, MemoryIdentityStore, PairingProof,
        PairingRegistration,
    };
    use crate::provisioning_http::{
        CredentialResponse, PairingActivation, PairingState, PairingStatus,
    };
    use crate::provisioning_store::BindingError;

    const PAIRING_ID: &str = "11111111-1111-4111-8111-111111111111";
    const DEVICE_ID: &str = "22222222-2222-4222-8222-222222222222";

    #[derive(Default)]
    struct MemoryBinding {
        binding: Mutex<Option<DeviceBinding>>,
        writes: AtomicUsize,
    }
    impl DeviceBindingStore for MemoryBinding {
        fn load(&self) -> Result<Option<DeviceBinding>, BindingError> {
            Ok(self.binding.lock().unwrap().clone())
        }
        fn save(&self, binding: &DeviceBinding) -> Result<(), BindingError> {
            *self.binding.lock().unwrap() = Some(binding.clone());
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct FakeApi {
        state: Mutex<PairingState>,
        fingerprint: Mutex<Option<String>>,
        proofs: AtomicUsize,
    }
    impl FakeApi {
        fn new(state: PairingState) -> Self {
            Self {
                state: Mutex::new(state),
                fingerprint: Mutex::new(None),
                proofs: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl ProvisioningApi for FakeApi {
        async fn create_pairing(
            &self,
            registration: &PairingRegistration,
        ) -> Result<PairingStart, ProvisionError> {
            *self.fingerprint.lock().unwrap() = Some(registration.fingerprint.clone());
            Ok(PairingStart {
                pairing_id: PAIRING_ID.to_owned(),
                user_code: "ABCD-EFGH".to_owned(),
                verification_uri: "https://example.com/pair".to_owned(),
                expires_at: Utc::now() + Duration::minutes(5),
                fingerprint: registration.fingerprint.clone(),
            })
        }

        async fn get_pairing(
            &self,
            pairing_id: &str,
            _key_id: &str,
            _installation_id: &str,
        ) -> Result<PairingStatus, ProvisionError> {
            Ok(PairingStatus {
                pairing_id: pairing_id.to_owned(),
                state: *self.state.lock().unwrap(),
                expires_at: Utc::now() + Duration::minutes(5),
                fingerprint: self.fingerprint.lock().unwrap().clone().unwrap_or_default(),
                challenge: Some("challenge_abcdefghijklmnopqrstuvwxyz".to_owned()),
                device_id: None,
            })
        }
        async fn prove_device(
            &self,
            pairing_id: &str,
            _proof: &PairingProof,
        ) -> Result<PairingActivation, ProvisionError> {
            self.proofs.fetch_add(1, Ordering::SeqCst);
            Ok(PairingActivation {
                pairing_id: pairing_id.to_owned(),
                state: PairingState::Active,
                device_id: DEVICE_ID.to_owned(),
            })
        }
        async fn issue_credential(
            &self,
            _device_id: &str,
            _proof: &ConnectionCredentialProof,
        ) -> Result<CredentialResponse, ProvisionError> {
            Err(ProvisionError::InvalidState)
        }
    }

    fn metadata() -> DevicePairingMetadata {
        DevicePairingMetadata {
            display_name: "CI test device".to_owned(),
            os: "windows".to_owned(),
            arch: "x86_64".to_owned(),
            agent_version: "0.1.0".to_owned(),
        }
    }

    #[tokio::test]
    async fn provisioning_pairing_created_requires_user_verification() {
        let identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
        let store = MemoryBinding::default();
        let api = FakeApi::new(PairingState::Created);
        let started = begin_pairing(&identity, &store, &api, metadata())
            .await
            .unwrap();
        assert_eq!(started.pairing_id, PAIRING_ID);
        assert_eq!(
            advance_pairing(&identity, &store, &api, PAIRING_ID)
                .await
                .unwrap(),
            PairingProgress::WaitingForUser
        );
        assert_eq!(api.proofs.load(Ordering::SeqCst), 0);
        assert_eq!(store.writes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn provisioning_pairing_active_persists_once() {
        let identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
        let store = MemoryBinding::default();
        let api = FakeApi::new(PairingState::UserVerified);
        begin_pairing(&identity, &store, &api, metadata())
            .await
            .unwrap();
        let active = advance_pairing(&identity, &store, &api, PAIRING_ID)
            .await
            .unwrap();
        let PairingProgress::Active(binding) = active else {
            panic!("validated pairing did not activate");
        };
        let public: DevicePublicIdentity =
            identity.load_existing().unwrap().unwrap().public_identity();
        assert_eq!(binding.device_id, DEVICE_ID);
        assert!(binding.matches(&public));
        assert_eq!(store.writes.load(Ordering::SeqCst), 1);
        assert_eq!(api.proofs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn provisioning_pairing_rejects_unregistered_or_invalid_state() {
        let identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
        let store = MemoryBinding::default();
        let api = FakeApi::new(PairingState::Revoked);
        assert!(matches!(
            advance_pairing(&identity, &store, &api, PAIRING_ID).await,
            Err(ProvisionError::InvalidState) | Err(ProvisionError::IdentityMismatch)
        ));
        assert_eq!(api.proofs.load(Ordering::SeqCst), 0);
        assert_eq!(store.writes.load(Ordering::SeqCst), 0);
    }

    struct CredentialApi {
        calls: AtomicUsize,
        nonces: Mutex<Vec<String>>,
        ttl_seconds: i64,
        path: String,
        denied: bool,
    }
    impl CredentialApi {
        fn new(ttl_seconds: i64, path: String, denied: bool) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                nonces: Mutex::new(Vec::new()),
                ttl_seconds,
                path,
                denied,
            }
        }
    }

    #[async_trait]
    impl ProvisioningApi for CredentialApi {
        async fn create_pairing(
            &self,
            _registration: &PairingRegistration,
        ) -> Result<PairingStart, ProvisionError> {
            Err(ProvisionError::InvalidState)
        }
        async fn get_pairing(
            &self,
            _pairing_id: &str,
            _key_id: &str,
            _installation_id: &str,
        ) -> Result<PairingStatus, ProvisionError> {
            Err(ProvisionError::InvalidState)
        }
        async fn prove_device(
            &self,
            _pairing_id: &str,
            _proof: &PairingProof,
        ) -> Result<PairingActivation, ProvisionError> {
            Err(ProvisionError::InvalidState)
        }
        async fn issue_credential(
            &self,
            _device_id: &str,
            proof: &ConnectionCredentialProof,
        ) -> Result<CredentialResponse, ProvisionError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.nonces
                .lock()
                .unwrap()
                .push(proof.connection_nonce.clone());
            if self.denied {
                return Err(ProvisionError::Denied);
            }
            Ok(CredentialResponse {
                credential: "ephemeral_ci_only_mock_credential".to_owned(),
                expires_at: Utc::now() + Duration::seconds(self.ttl_seconds),
                websocket_path: self.path.clone(),
            })
        }
    }

    fn active_binding() -> (DeviceIdentityManager<MemoryIdentityStore>, MemoryBinding) {
        let identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
        let public = identity.load_or_generate().unwrap().public_identity();
        let binding = DeviceBinding::new(DEVICE_ID.to_owned(), &public).unwrap();
        (
            identity,
            MemoryBinding {
                binding: Mutex::new(Some(binding)),
                writes: AtomicUsize::new(0),
            },
        )
    }

    fn connection_metadata() -> AgentMetadata {
        AgentMetadata {
            agent_version: "0.1.0".to_owned(),
            os: "windows".to_owned(),
            arch: "x86_64".to_owned(),
            capabilities: Vec::new(),
        }
    }

    fn connection_origin() -> Url {
        Url::parse("https://example.org/").unwrap()
    }

    fn credential_path() -> String {
        format!("/api/v1/devices/{DEVICE_ID}/realtime")
    }

    #[tokio::test]
    async fn provisioning_session_missing_identity_never_calls_api() {
        let identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
        let store = MemoryBinding::default();
        let api = CredentialApi::new(30, credential_path(), false);
        let result = prepare_connection(
            &identity,
            &store,
            &api,
            &connection_origin(),
            connection_metadata(),
            Utc::now(),
        )
        .await;
        assert!(matches!(result, Err(ProvisionError::InvalidState)));
        assert_eq!(api.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn provisioning_session_mismatched_binding_never_calls_api() {
        let (identity, store) = active_binding();
        let other_identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
        other_identity.load_or_generate().unwrap();
        let api = CredentialApi::new(30, credential_path(), false);
        let result = prepare_connection(
            &other_identity,
            &store,
            &api,
            &connection_origin(),
            connection_metadata(),
            Utc::now(),
        )
        .await;
        assert!(matches!(result, Err(ProvisionError::IdentityMismatch)));
        assert_eq!(api.calls.load(Ordering::SeqCst), 0);
        drop(identity);
    }

    #[tokio::test]
    async fn provisioning_session_valid_credential_does_not_connect() {
        let (identity, store) = active_binding();
        let api = CredentialApi::new(30, credential_path(), false);
        let prepared = prepare_connection(
            &identity,
            &store,
            &api,
            &connection_origin(),
            connection_metadata(),
            Utc::now(),
        )
        .await
        .unwrap();
        assert_eq!(prepared.config.device_id, DEVICE_ID);
        assert_eq!(
            prepared.config.websocket_url,
            format!("wss://example.org/api/v1/devices/{DEVICE_ID}/realtime")
        );
        assert!(prepared.config.capabilities.is_empty());
        assert!(
            !format!("{:?}", prepared.credentials).contains("ephemeral_ci_only_mock_credential")
        );
        let second = prepare_connection(
            &identity,
            &store,
            &api,
            &connection_origin(),
            connection_metadata(),
            Utc::now(),
        )
        .await
        .unwrap();
        let nonces = api.nonces.lock().unwrap();
        assert_ne!(nonces[0], nonces[1]);
        assert_eq!(second.config.device_id, prepared.config.device_id);
        assert_eq!(api.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn provisioning_session_rejects_expired_or_long_ttl_or_altered_ws_path() {
        let (identity, store) = active_binding();
        for (ttl, path) in [
            (-5, credential_path()),
            (121, credential_path()),
            (
                30,
                "/api/v1/devices/not-the-bound-device/realtime".to_owned(),
            ),
        ] {
            let api = CredentialApi::new(ttl, path, false);
            let result = prepare_connection(
                &identity,
                &store,
                &api,
                &connection_origin(),
                connection_metadata(),
                Utc::now(),
            )
            .await;
            assert!(result.is_err());
            assert_eq!(api.calls.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn provisioning_session_exact_readonly_capabilities_can_receive_credential() {
        let (identity, binding) = active_binding();
        let api = CredentialApi::new(30, credential_path(), false);
        let mut meta = connection_metadata();
        meta.capabilities = crate::host_readonly::READ_ONLY_CAPABILITIES
            .iter()
            .map(|capability| (*capability).to_owned())
            .collect();
        let expected = meta.capabilities.clone();
        let result = prepare_connection(
            &identity,
            &binding,
            &api,
            &connection_origin(),
            meta,
            Utc::now(),
        )
        .await
        .unwrap();
        assert_eq!(result.config.capabilities, expected);
        assert_eq!(api.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn provisioning_session_rejects_expanded_or_reordered_readonly_capabilities_before_http()
    {
        let (identity, binding) = active_binding();
        let allowed: Vec<String> = crate::host_readonly::READ_ONLY_CAPABILITIES
            .iter()
            .map(|capability| (*capability).to_owned())
            .collect();
        let mut additional = allowed.clone();
        additional.push("fs.write".to_owned());
        let mut modified = allowed.clone();
        modified[0] = "shell.exec".to_owned();
        let mut reordered = allowed.clone();
        reordered.swap(0, 1);
        let mut duplicate = allowed.clone();
        duplicate[0] = duplicate[1].clone();
        for capabilities in [additional, modified, reordered, duplicate] {
            let api = CredentialApi::new(30, credential_path(), false);
            let mut meta = connection_metadata();
            meta.capabilities = capabilities;
            let result = prepare_connection(
                &identity,
                &binding,
                &api,
                &connection_origin(),
                meta,
                Utc::now(),
            )
            .await;
            assert!(matches!(result, Err(ProvisionError::InvalidState)));
            assert_eq!(api.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn provisioning_session_revoked_credential_denied() {
        let (identity, store) = active_binding();
        let api = CredentialApi::new(30, credential_path(), true);
        let result = prepare_connection(
            &identity,
            &store,
            &api,
            &connection_origin(),
            connection_metadata(),
            Utc::now(),
        )
        .await;
        assert!(matches!(result, Err(ProvisionError::Denied)));
        assert_eq!(api.calls.load(Ordering::SeqCst), 1);
    }
}
