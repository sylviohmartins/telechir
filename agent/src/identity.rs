use std::fmt;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroize;

const STORE_VERSION: u8 = 1;
const STORED_IDENTITY_LEN: usize = 65;
const NATIVE_KEYRING_SERVICE: &str = "telechir-agent";
const NATIVE_KEYRING_ACCOUNT: &str = "device-identity-v1";

pub const DEVICE_KEY_ALGORITHM: &str = "Ed25519";
pub const PAIRING_PROOF_VERSION: &str = "telechir-pairing-proof-v1";
pub const PAIRING_PROOF_AUDIENCE: &str = "telechir-control-plane";
pub const CONNECTION_PROOF_VERSION: &str = "telechir-connection-credential-proof-v1";
pub const CONNECTION_PROOF_AUDIENCE: &str = "telechir-control-plane/realtime";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicePublicIdentity {
    pub device_key_id: String,
    pub device_installation_id: String,
    pub algorithm: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicePairingMetadata {
    pub display_name: String,
    pub os: String,
    pub arch: String,
    pub agent_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingRegistration {
    pub device_key_id: String,
    pub device_installation_id: String,
    pub algorithm: String,
    pub public_key: String,
    pub fingerprint: String,
    pub display_name: String,
    pub os: String,
    pub arch: String,
    pub agent_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingProof {
    pub device_key_id: String,
    pub device_installation_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionCredentialProof {
    pub device_key_id: String,
    pub connection_nonce: String,
    pub requested_at: String,
    pub signature: String,
}

pub trait DeviceIdentityStore: Send + Sync {
    fn load(&self) -> Result<Option<Vec<u8>>, IdentityError>;
    fn save(&self, secret: &[u8]) -> Result<(), IdentityError>;
    fn delete(&self) -> Result<(), IdentityError>;
}
pub struct NativeKeyringIdentityStore {
    entry: Entry,
}

impl NativeKeyringIdentityStore {
    pub fn new() -> Result<Self, IdentityError> {
        let entry = Entry::new(NATIVE_KEYRING_SERVICE, NATIVE_KEYRING_ACCOUNT)
            .map_err(|error| IdentityError::Store(error.to_string()))?;
        Ok(Self { entry })
    }
}

impl DeviceIdentityStore for NativeKeyringIdentityStore {
    fn load(&self) -> Result<Option<Vec<u8>>, IdentityError> {
        match self.entry.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(IdentityError::Store(error.to_string())),
        }
    }

    fn save(&self, secret: &[u8]) -> Result<(), IdentityError> {
        self.entry
            .set_secret(secret)
            .map_err(|error| IdentityError::Store(error.to_string()))
    }

    fn delete(&self) -> Result<(), IdentityError> {
        match self.entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(IdentityError::Store(error.to_string())),
        }
    }
}

#[derive(Default)]
pub struct MemoryIdentityStore {
    secret: Mutex<Option<Vec<u8>>>,
}

impl DeviceIdentityStore for MemoryIdentityStore {
    fn load(&self) -> Result<Option<Vec<u8>>, IdentityError> {
        Ok(self
            .secret
            .lock()
            .map_err(|_| IdentityError::Store("identity store lock poisoned".to_owned()))?
            .clone())
    }

    fn save(&self, secret: &[u8]) -> Result<(), IdentityError> {
        *self
            .secret
            .lock()
            .map_err(|_| IdentityError::Store("identity store lock poisoned".to_owned()))? =
            Some(secret.to_vec());
        Ok(())
    }

    fn delete(&self) -> Result<(), IdentityError> {
        *self
            .secret
            .lock()
            .map_err(|_| IdentityError::Store("identity store lock poisoned".to_owned()))? = None;
        Ok(())
    }
}
pub struct DeviceIdentity {
    device_key_id: Uuid,
    device_installation_id: Uuid,
    signing_key: SigningKey,
}

impl fmt::Debug for DeviceIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceIdentity")
            .field("device_key_id", &self.device_key_id)
            .field("device_installation_id", &self.device_installation_id)
            .field("public_identity", &self.public_identity())
            .finish_non_exhaustive()
    }
}

impl DeviceIdentity {
    pub fn public_identity(&self) -> DevicePublicIdentity {
        let public_key = self.signing_key.verifying_key().to_bytes();
        let fingerprint = Sha256::digest(public_key);

        DevicePublicIdentity {
            device_key_id: self.device_key_id.to_string(),
            device_installation_id: self.device_installation_id.to_string(),
            algorithm: DEVICE_KEY_ALGORITHM.to_owned(),
            public_key: URL_SAFE_NO_PAD.encode(public_key),
            fingerprint: URL_SAFE_NO_PAD.encode(fingerprint),
        }
    }

    pub fn pairing_registration(&self, metadata: DevicePairingMetadata) -> PairingRegistration {
        let public = self.public_identity();

        PairingRegistration {
            device_key_id: public.device_key_id,
            device_installation_id: public.device_installation_id,
            algorithm: public.algorithm,
            public_key: public.public_key,
            fingerprint: public.fingerprint,
            display_name: metadata.display_name,
            os: metadata.os,
            arch: metadata.arch,
            agent_version: metadata.agent_version,
        }
    }

    pub fn sign_pairing_proof(
        &self,
        pairing_id: &str,
        challenge: &str,
        audience: &str,
    ) -> Result<PairingProof, IdentityError> {
        let message = pairing_proof_message(
            pairing_id,
            &self.device_key_id.to_string(),
            &self.device_installation_id.to_string(),
            challenge,
            audience,
        )?;
        let signature = self.signing_key.sign(message.as_bytes());

        Ok(PairingProof {
            device_key_id: self.device_key_id.to_string(),
            device_installation_id: self.device_installation_id.to_string(),
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        })
    }

    pub fn sign_connection_credential_request(
        &self,
        device_id: &str,
        connection_nonce: &str,
        requested_at: &str,
    ) -> Result<ConnectionCredentialProof, IdentityError> {
        let message = connection_credential_proof_message(
            device_id,
            &self.device_key_id.to_string(),
            connection_nonce,
            requested_at,
            CONNECTION_PROOF_AUDIENCE,
        )?;
        let signature = self.signing_key.sign(message.as_bytes());

        Ok(ConnectionCredentialProof {
            device_key_id: self.device_key_id.to_string(),
            connection_nonce: connection_nonce.to_owned(),
            requested_at: requested_at.to_owned(),
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        })
    }
}
pub struct DeviceIdentityManager<S> {
    store: S,
}

impl<S> DeviceIdentityManager<S>
where
    S: DeviceIdentityStore,
{
    pub fn new(store: S) -> Self {
        Self { store }
    }

    /// Never generates or rotates a key. The session path MUST fail closed
    /// when the device has not been paired explicitly.
    pub fn load_existing(&self) -> Result<Option<DeviceIdentity>, IdentityError> {
        match self.store.load()? {
            None => Ok(None),
            Some(mut stored) => {
                let decoded = decode_identity(&stored);
                stored.zeroize();
                decoded.map(Some)
            }
        }
    }

    pub fn load_or_generate(&self) -> Result<DeviceIdentity, IdentityError> {
        if let Some(mut stored) = self.store.load()? {
            let identity = decode_identity(&stored);
            stored.zeroize();
            return identity;
        }

        let identity = generate_identity()?;
        let mut encoded = encode_identity(&identity);
        let save_result = self.store.save(&encoded);
        encoded.zeroize();
        save_result?;

        Ok(identity)
    }

    pub fn delete(&self) -> Result<(), IdentityError> {
        self.store.delete()
    }
}

pub fn pairing_proof_message(
    pairing_id: &str,
    device_key_id: &str,
    device_installation_id: &str,
    challenge: &str,
    audience: &str,
) -> Result<String, IdentityError> {
    for (name, value) in [
        ("pairing_id", pairing_id),
        ("device_key_id", device_key_id),
        ("device_installation_id", device_installation_id),
        ("challenge", challenge),
        ("audience", audience),
    ] {
        if value.is_empty() || value.contains(['\n', '\r']) {
            return Err(IdentityError::InvalidProofField(name));
        }
    }

    Ok(format!(
        "{PAIRING_PROOF_VERSION}\npairing_id={pairing_id}\ndevice_key_id={device_key_id}\ndevice_installation_id={device_installation_id}\nchallenge={challenge}\naudience={audience}"
    ))
}

pub fn connection_credential_proof_message(
    device_id: &str,
    device_key_id: &str,
    connection_nonce: &str,
    requested_at: &str,
    audience: &str,
) -> Result<String, IdentityError> {
    for (name, value) in [
        ("device_id", device_id),
        ("device_key_id", device_key_id),
        ("connection_nonce", connection_nonce),
        ("requested_at", requested_at),
        ("audience", audience),
    ] {
        if value.is_empty() || value.contains(['\n', '\r']) {
            return Err(IdentityError::InvalidProofField(name));
        }
    }

    Ok(format!(
        "{CONNECTION_PROOF_VERSION}\ndevice_id={device_id}\ndevice_key_id={device_key_id}\nconnection_nonce={connection_nonce}\nrequested_at={requested_at}\naudience={audience}"
    ))
}
fn generate_identity() -> Result<DeviceIdentity, IdentityError> {
    let mut secret_key = [0_u8; 32];
    getrandom::fill(&mut secret_key).map_err(|error| IdentityError::Random(error.to_string()))?;
    let signing_key = SigningKey::from_bytes(&secret_key);
    secret_key.zeroize();

    Ok(DeviceIdentity {
        device_key_id: Uuid::new_v4(),
        device_installation_id: Uuid::new_v4(),
        signing_key,
    })
}

fn encode_identity(identity: &DeviceIdentity) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(STORED_IDENTITY_LEN);
    encoded.push(STORE_VERSION);
    encoded.extend_from_slice(identity.device_key_id.as_bytes());
    encoded.extend_from_slice(identity.device_installation_id.as_bytes());

    let mut secret_key = identity.signing_key.to_bytes();
    encoded.extend_from_slice(&secret_key);
    secret_key.zeroize();

    encoded
}

fn decode_identity(encoded: &[u8]) -> Result<DeviceIdentity, IdentityError> {
    if encoded.len() != STORED_IDENTITY_LEN {
        return Err(IdentityError::CorruptStore(format!(
            "stored identity must contain {STORED_IDENTITY_LEN} bytes"
        )));
    }
    if encoded[0] != STORE_VERSION {
        return Err(IdentityError::CorruptStore(format!(
            "unsupported stored identity version: {}",
            encoded[0]
        )));
    }

    let device_key_id = Uuid::from_slice(&encoded[1..17])
        .map_err(|error| IdentityError::CorruptStore(error.to_string()))?;
    let device_installation_id = Uuid::from_slice(&encoded[17..33])
        .map_err(|error| IdentityError::CorruptStore(error.to_string()))?;
    let mut secret_key = [0_u8; 32];
    secret_key.copy_from_slice(&encoded[33..65]);
    let signing_key = SigningKey::from_bytes(&secret_key);
    secret_key.zeroize();

    Ok(DeviceIdentity {
        device_key_id,
        device_installation_id,
        signing_key,
    })
}
#[derive(Debug, Error, PartialEq, Eq)]
pub enum IdentityError {
    #[error("native identity store failure: {0}")]
    Store(String),
    #[error("stored identity is corrupt: {0}")]
    CorruptStore(String),
    #[error("operating-system random source failed: {0}")]
    Random(String),
    #[error("pairing proof field {0} is empty or contains a line break")]
    InvalidProofField(&'static str),
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    use super::*;

    #[test]
    fn provisioning_missing_identity_does_not_generate() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct ObservedStore {
            saved: Mutex<Option<Vec<u8>>>,
            writes: Arc<AtomicUsize>,
        }
        impl DeviceIdentityStore for ObservedStore {
            fn load(&self) -> Result<Option<Vec<u8>>, IdentityError> {
                Ok(self.saved.lock().unwrap().clone())
            }
            fn save(&self, bytes: &[u8]) -> Result<(), IdentityError> {
                self.writes.fetch_add(1, Ordering::SeqCst);
                *self.saved.lock().unwrap() = Some(bytes.to_vec());
                Ok(())
            }
            fn delete(&self) -> Result<(), IdentityError> {
                Ok(())
            }
        }

        let writes = Arc::new(AtomicUsize::new(0));
        let empty = DeviceIdentityManager::new(ObservedStore {
            saved: Mutex::new(None),
            writes: Arc::clone(&writes),
        });
        assert!(empty.load_existing().unwrap().is_none());
        assert_eq!(writes.load(Ordering::SeqCst), 0);

        let identity = generate_identity().unwrap();
        let public = identity.public_identity();
        let existing = DeviceIdentityManager::new(ObservedStore {
            saved: Mutex::new(Some(encode_identity(&identity))),
            writes: Arc::clone(&writes),
        });
        assert_eq!(
            existing.load_existing().unwrap().unwrap().public_identity(),
            public
        );
        assert_eq!(writes.load(Ordering::SeqCst), 0);

        let invalid = DeviceIdentityManager::new(ObservedStore {
            saved: Mutex::new(Some(vec![0_u8; 3])),
            writes: Arc::clone(&writes),
        });
        assert!(matches!(
            invalid.load_existing(),
            Err(IdentityError::CorruptStore(_))
        ));
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn identity_is_stable_when_loaded_from_store() {
        let store = MemoryIdentityStore::default();
        let manager = DeviceIdentityManager::new(store);

        let first = manager.load_or_generate().unwrap();
        let first_public = first.public_identity();
        let second = manager.load_or_generate().unwrap();

        assert_eq!(second.public_identity(), first_public);
    }

    #[test]
    fn public_identity_contains_no_private_key_material() {
        let identity = generate_identity().unwrap();
        let public = serde_json::to_string(&identity.public_identity()).unwrap();

        assert!(!public.contains("secret"));
        assert!(!public.contains("private"));
        assert_eq!(identity.public_identity().algorithm, DEVICE_KEY_ALGORITHM);
    }
    #[test]
    fn pairing_registration_contains_only_public_identity_and_metadata() {
        let identity = generate_identity().unwrap();
        let registration = identity.pairing_registration(DevicePairingMetadata {
            display_name: "Dev workstation".to_owned(),
            os: "linux".to_owned(),
            arch: "x86_64".to_owned(),
            agent_version: "0.1.0".to_owned(),
        });
        let serialized = serde_json::to_string(&registration).unwrap();

        assert_eq!(registration.algorithm, DEVICE_KEY_ALGORITHM);
        assert_eq!(registration.display_name, "Dev workstation");
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("signing_key"));
    }

    #[test]
    fn pairing_proof_verifies_with_public_key() {
        let identity = generate_identity().unwrap();
        let public = identity.public_identity();
        let proof = identity
            .sign_pairing_proof(
                "pairing_123",
                "challenge_abcdefghijklmnopqrstuvwxyz",
                PAIRING_PROOF_AUDIENCE,
            )
            .unwrap();
        let message = pairing_proof_message(
            "pairing_123",
            &proof.device_key_id,
            &proof.device_installation_id,
            "challenge_abcdefghijklmnopqrstuvwxyz",
            PAIRING_PROOF_AUDIENCE,
        )
        .unwrap();

        let public_bytes: [u8; 32] = URL_SAFE_NO_PAD
            .decode(public.public_key)
            .unwrap()
            .try_into()
            .unwrap();
        let verifying_key = VerifyingKey::from_bytes(&public_bytes).unwrap();
        let signature_bytes: [u8; 64] = URL_SAFE_NO_PAD
            .decode(proof.signature)
            .unwrap()
            .try_into()
            .unwrap();
        let signature = Signature::from_bytes(&signature_bytes);

        verifying_key
            .verify(message.as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn pairing_proof_is_bound_to_challenge() {
        let identity = generate_identity().unwrap();
        let public = identity.public_identity();
        let proof = identity
            .sign_pairing_proof("pairing_123", "challenge_a", PAIRING_PROOF_AUDIENCE)
            .unwrap();

        let public_bytes: [u8; 32] = URL_SAFE_NO_PAD
            .decode(public.public_key)
            .unwrap()
            .try_into()
            .unwrap();
        let verifying_key = VerifyingKey::from_bytes(&public_bytes).unwrap();
        let signature_bytes: [u8; 64] = URL_SAFE_NO_PAD
            .decode(proof.signature)
            .unwrap()
            .try_into()
            .unwrap();
        let signature = Signature::from_bytes(&signature_bytes);
        let altered = pairing_proof_message(
            "pairing_123",
            &proof.device_key_id,
            &proof.device_installation_id,
            "challenge_b",
            PAIRING_PROOF_AUDIENCE,
        )
        .unwrap();

        assert!(
            verifying_key
                .verify(altered.as_bytes(), &signature)
                .is_err()
        );
    }

    #[test]
    fn connection_credential_proof_verifies_with_public_key() {
        let identity = generate_identity().unwrap();
        let public = identity.public_identity();
        let proof = identity
            .sign_connection_credential_request(
                "11111111-1111-4111-8111-111111111111",
                "nonce_abcdefghijklmnopqrstuvwxyz",
                "2026-10-02T18:45:00Z",
            )
            .unwrap();
        let message = connection_credential_proof_message(
            "11111111-1111-4111-8111-111111111111",
            &proof.device_key_id,
            &proof.connection_nonce,
            &proof.requested_at,
            CONNECTION_PROOF_AUDIENCE,
        )
        .unwrap();

        let public_bytes: [u8; 32] = URL_SAFE_NO_PAD
            .decode(public.public_key)
            .unwrap()
            .try_into()
            .unwrap();
        let verifying_key = VerifyingKey::from_bytes(&public_bytes).unwrap();
        let signature_bytes: [u8; 64] = URL_SAFE_NO_PAD
            .decode(proof.signature)
            .unwrap()
            .try_into()
            .unwrap();
        let signature = Signature::from_bytes(&signature_bytes);

        verifying_key
            .verify(message.as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn debug_output_does_not_render_private_key() {
        let identity = generate_identity().unwrap();
        let debug = format!("{identity:?}");

        assert!(!debug.contains("secret_key"));
        assert!(!debug.contains("signing_key"));
    }
}
