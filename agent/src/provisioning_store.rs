//! OS-native store for the confirmed, identity-bound device association.
//! No WebSocket, pairing, token or implicit credential issuance in this module.
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::identity::DevicePublicIdentity;

const BINDING_VERSION: u8 = 1;
const MAX_BINDING_BYTES: usize = 4096;
const NATIVE_KEYRING_SERVICE: &str = "telechir-agent";
const NATIVE_KEYRING_ACCOUNT: &str = "device-binding-v1";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BindingError {
    #[error("device binding is invalid or mismatched")]
    InvalidBinding,
    #[error("device binding store is unavailable")]
    StoreUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceBinding {
    version: u8,
    pub device_id: String,
    pub device_key_id: String,
    pub device_installation_id: String,
    pub fingerprint: String,
}

impl DeviceBinding {
    pub fn new(device_id: String, public: &DevicePublicIdentity) -> Result<Self, BindingError> {
        let _ = (device_id, public);
        // TDD RED: strict versioned association checks not implemented.
        Err(BindingError::InvalidBinding)
    }

    pub fn matches(&self, public: &DevicePublicIdentity) -> bool {
        let _ = public;
        // TDD RED: fail closed until the association is checked.
        false
    }
}

pub trait DeviceBindingStore: Send + Sync {
    fn load(&self) -> Result<Option<DeviceBinding>, BindingError>;
    fn save(&self, binding: &DeviceBinding) -> Result<(), BindingError>;
}

pub struct NativeKeyringDeviceBindingStore {
    entry: Entry,
}

impl NativeKeyringDeviceBindingStore {
    pub fn new() -> Result<Self, BindingError> {
        let entry = Entry::new(NATIVE_KEYRING_SERVICE, NATIVE_KEYRING_ACCOUNT)
            .map_err(|_| BindingError::StoreUnavailable)?;
        Ok(Self { entry })
    }
}

impl DeviceBindingStore for NativeKeyringDeviceBindingStore {
    fn load(&self) -> Result<Option<DeviceBinding>, BindingError> {
        let mut stored = match self.entry.get_secret() {
            Ok(stored) => stored,
            Err(KeyringError::NoEntry) => return Ok(None),
            Err(_) => return Err(BindingError::StoreUnavailable),
        };
        // TDD RED: credential store contents must be validated and decoded.
        stored.zeroize();
        Ok(None)
    }

    fn save(&self, binding: &DeviceBinding) -> Result<(), BindingError> {
        let _ = binding;
        // TDD RED: never persist an unverified association.
        Err(BindingError::InvalidBinding)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{DeviceIdentityManager, MemoryIdentityStore};

    fn identity() -> DevicePublicIdentity {
        DeviceIdentityManager::new(MemoryIdentityStore::default())
            .load_or_generate()
            .unwrap()
            .public_identity()
    }

    #[test]
    fn provisioning_binding_roundtrip() {
        let public = identity();
        let id = "11111111-1111-4111-8111-111111111111";
        let binding = DeviceBinding::new(id.to_owned(), &public).unwrap();
        assert_eq!(binding.device_id, id);
        assert!(binding.matches(&public));
        let bytes = serde_json::to_vec(&binding).unwrap();
        let stored: DeviceBinding = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(stored, binding);
    }

    #[test]
    fn provisioning_binding_rejects_corrupt_or_mismatched_key() {
        let public = identity();
        let binding =
            DeviceBinding::new("22222222-2222-4222-8222-222222222222".to_owned(), &public).unwrap();
        let other = identity();
        assert!(!binding.matches(&other));
        let mut altered = binding.clone();
        altered.version = 2;
        assert!(!altered.matches(&public));
        altered.version = 1;
        altered.fingerprint = "adversarial-mismatch".to_owned();
        assert!(!altered.matches(&public));
        assert!(serde_json::from_slice::<DeviceBinding>(b"not-json").is_err());
    }

    #[test]
    fn provisioning_binding_rejects_blank_or_invalid_uuid() {
        let public = identity();
        assert!(DeviceBinding::new("".to_owned(), &public).is_err());
        assert!(DeviceBinding::new("not-a-uuid".to_owned(), &public).is_err());
        assert!(
            DeviceBinding::new("00000000-0000-0000-0000-000000000000".to_owned(), &public).is_err()
        );
    }
}
