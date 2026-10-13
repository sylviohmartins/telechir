//! Explicit, user-verified device pairing. This layer never opens a WebSocket.
use crate::identity::{DeviceIdentityManager, DeviceIdentityStore, DevicePairingMetadata};
use crate::provisioning_http::{PairingStart, ProvisionError, ProvisioningApi};
use crate::provisioning_store::{DeviceBinding, DeviceBindingStore};

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
    let _ = (identity, binding, api, metadata);
    // RED: server registration and fingerprint validation are not wired.
    Err(ProvisionError::InvalidState)
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
    let _ = (identity, binding, api, pairing_id);
    // RED: no proof or activation until the server's state is verified.
    Err(ProvisionError::InvalidState)
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
