#![forbid(unsafe_code)]

pub mod config;
pub mod executor;
pub mod filesystem;
pub mod git;
pub mod identity;
pub mod lifecycle;
pub mod policy;
pub mod ports;
pub mod process;
pub mod protocol;
pub mod realtime;

pub use config::AgentConfig;
pub use executor::LocalCommandExecutor;
pub use filesystem::{FILESYSTEM_CAPABILITIES, FilesystemExecutor, FilesystemPolicy};
pub use git::{GIT_CAPABILITIES, GitExecutor};
pub use identity::{
    CONNECTION_PROOF_AUDIENCE, CONNECTION_PROOF_VERSION, ConnectionCredentialProof,
    DEVICE_KEY_ALGORITHM, DeviceIdentity, DeviceIdentityManager, DeviceIdentityStore,
    DevicePairingMetadata, DevicePublicIdentity, IdentityError, MemoryIdentityStore,
    NativeKeyringIdentityStore, PAIRING_PROOF_AUDIENCE, PairingProof, PairingRegistration,
    connection_credential_proof_message, pairing_proof_message,
};
pub use lifecycle::{CommandLifecycle, CommandState, TransitionError};
pub use process::{PROCESS_CAPABILITIES, ProcessExecutor, ProcessPolicy};
pub use protocol::{DeviceMessage, MessageType, ProtocolValidationError, decode_and_validate};
pub use realtime::{
    DEFAULT_HANDSHAKE_TIMEOUT, RealtimeClientConfig, RealtimeConnection, RealtimeError,
    RealtimeState, ReconnectController, connect_realtime, new_connection_nonce,
};
