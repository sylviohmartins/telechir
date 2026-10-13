//! Explicit, user-verified device pairing. This layer never opens a WebSocket.
use chrono::{Duration as ChronoDuration, Utc};
use url::Url;
use uuid::Uuid;

use crate::identity::{
    DeviceIdentityManager, DeviceIdentityStore, DevicePairingMetadata, PAIRING_PROOF_AUDIENCE,
};
use crate::provisioning_http::{PairingStart, PairingState, ProvisionError, ProvisioningApi};
use crate::provisioning_store::{BindingError, DeviceBinding, DeviceBindingStore};

fn valid_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uuid| !uuid.is_nil())
}

fn store_error(error: BindingError) -> ProvisionError {
    match error {
        BindingError::InvalidBinding => ProvisionError::IdentityMismatch,
        BindingError::StoreUnavailable => ProvisionError::StoreUnavailable,
    }
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
}
