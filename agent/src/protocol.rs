use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use thiserror::Error;

pub const PROTOCOL_VERSION: &str = "0.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MessageType {
    #[serde(rename = "agent.hello")]
    AgentHello,
    #[serde(rename = "agent.hello_ack")]
    AgentHelloAck,
    #[serde(rename = "heartbeat")]
    Heartbeat,
    #[serde(rename = "heartbeat_ack")]
    HeartbeatAck,
    #[serde(rename = "capabilities.changed")]
    CapabilitiesChanged,
    #[serde(rename = "command.request")]
    CommandRequest,
    #[serde(rename = "command.accepted")]
    CommandAccepted,
    #[serde(rename = "command.chunk")]
    CommandChunk,
    #[serde(rename = "command.completed")]
    CommandCompleted,
    #[serde(rename = "command.failed")]
    CommandFailed,
    #[serde(rename = "command.cancel")]
    CommandCancel,
    #[serde(rename = "command.cancelled")]
    CommandCancelled,
    #[serde(rename = "approval.request")]
    ApprovalRequest,
    #[serde(rename = "approval.decision")]
    ApprovalDecision,
    #[serde(rename = "protocol.error")]
    ProtocolError,
}

impl MessageType {
    pub const ALL: [Self; 15] = [
        Self::AgentHello,
        Self::AgentHelloAck,
        Self::Heartbeat,
        Self::HeartbeatAck,
        Self::CapabilitiesChanged,
        Self::CommandRequest,
        Self::CommandAccepted,
        Self::CommandChunk,
        Self::CommandCompleted,
        Self::CommandFailed,
        Self::CommandCancel,
        Self::CommandCancelled,
        Self::ApprovalRequest,
        Self::ApprovalDecision,
        Self::ProtocolError,
    ];
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AgentHello => "agent.hello",
            Self::AgentHelloAck => "agent.hello_ack",
            Self::Heartbeat => "heartbeat",
            Self::HeartbeatAck => "heartbeat_ack",
            Self::CapabilitiesChanged => "capabilities.changed",
            Self::CommandRequest => "command.request",
            Self::CommandAccepted => "command.accepted",
            Self::CommandChunk => "command.chunk",
            Self::CommandCompleted => "command.completed",
            Self::CommandFailed => "command.failed",
            Self::CommandCancel => "command.cancel",
            Self::CommandCancelled => "command.cancelled",
            Self::ApprovalRequest => "approval.request",
            Self::ApprovalDecision => "approval.decision",
            Self::ProtocolError => "protocol.error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceMessage {
    pub protocol_version: String,
    pub message_type: MessageType,
    pub message_id: String,
    #[serde(default)]
    pub correlation_id: Option<String>,
    pub device_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub connection_id: Option<String>,
    pub sequence: u64,
    pub sent_at: DateTime<Utc>,
    #[serde(default)]
    pub deadline_at: Option<DateTime<Utc>>,
    pub payload: Value,
}

impl DeviceMessage {
    pub fn validate(&self) -> Result<(), ProtocolValidationError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolValidationError::Envelope(format!(
                "protocol_version must be {PROTOCOL_VERSION}"
            )));
        }
        validate_len("message_id", &self.message_id, 8, 128)?;
        validate_len("device_id", &self.device_id, 3, 128)?;
        validate_optional_max("session_id", self.session_id.as_deref(), 128)?;
        validate_optional_max("connection_id", self.connection_id.as_deref(), 128)?;
        if let Some(correlation_id) = self.correlation_id.as_deref() {
            validate_len("correlation_id", correlation_id, 8, 128)?;
        }

        match self.message_type {
            MessageType::AgentHello => self.validate_payload::<AgentHello>(),
            MessageType::AgentHelloAck => self.validate_payload::<AgentHelloAck>(),
            MessageType::Heartbeat => self.validate_payload::<Heartbeat>(),
            MessageType::HeartbeatAck => self.validate_payload::<HeartbeatAck>(),
            MessageType::CapabilitiesChanged => self.validate_payload::<CapabilitiesChanged>(),
            MessageType::CommandRequest => self.validate_payload::<CommandRequest>(),
            MessageType::CommandAccepted => self.validate_payload::<CommandAccepted>(),
            MessageType::CommandChunk => {
                let object =
                    self.payload
                        .as_object()
                        .ok_or_else(|| ProtocolValidationError::Payload {
                            message_type: self.message_type.as_str().to_owned(),
                            reason: "payload must be an object".to_owned(),
                        })?;
                if !object.contains_key("data") && !object.contains_key("artifact_id") {
                    return Err(ProtocolValidationError::Payload {
                        message_type: self.message_type.as_str().to_owned(),
                        reason: "command.chunk requires data or artifact_id".to_owned(),
                    });
                }
                self.validate_payload::<CommandChunk>()
            }
            MessageType::CommandCompleted => self.validate_payload::<CommandCompleted>(),
            MessageType::CommandFailed => self.validate_payload::<CommandFailed>(),
            MessageType::CommandCancel => self.validate_payload::<CommandCancel>(),
            MessageType::CommandCancelled => self.validate_payload::<CommandCancelled>(),
            MessageType::ApprovalRequest => self.validate_payload::<ApprovalRequest>(),
            MessageType::ApprovalDecision => self.validate_payload::<ApprovalDecision>(),
            MessageType::ProtocolError => self.validate_payload::<ProtocolErrorPayload>(),
        }
    }
    fn validate_payload<T>(&self) -> Result<(), ProtocolValidationError>
    where
        T: DeserializeOwned + PayloadContract,
    {
        let payload: T = serde_json::from_value(self.payload.clone()).map_err(|error| {
            ProtocolValidationError::Payload {
                message_type: self.message_type.as_str().to_owned(),
                reason: error.to_string(),
            }
        })?;

        payload
            .validate()
            .map_err(|reason| ProtocolValidationError::Payload {
                message_type: self.message_type.as_str().to_owned(),
                reason,
            })
    }
}

pub fn decode_and_validate(input: &str) -> Result<DeviceMessage, ProtocolValidationError> {
    let message: DeviceMessage = serde_json::from_str(input)
        .map_err(|error| ProtocolValidationError::InvalidJson(error.to_string()))?;
    message.validate()?;
    Ok(message)
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolValidationError {
    #[error("invalid message JSON: {0}")]
    InvalidJson(String),
    #[error("invalid message envelope: {0}")]
    Envelope(String),
    #[error("invalid payload for {message_type}: {reason}")]
    Payload {
        message_type: String,
        reason: String,
    },
}
fn validate_len(
    field: &str,
    value: &str,
    min: usize,
    max: usize,
) -> Result<(), ProtocolValidationError> {
    let count = value.chars().count();
    if !(min..=max).contains(&count) {
        return Err(ProtocolValidationError::Envelope(format!(
            "{field} length must be between {min} and {max}"
        )));
    }
    Ok(())
}

fn validate_optional_max(
    field: &str,
    value: Option<&str>,
    max: usize,
) -> Result<(), ProtocolValidationError> {
    if value.is_some_and(|value| value.chars().count() > max) {
        return Err(ProtocolValidationError::Envelope(format!(
            "{field} length must be at most {max}"
        )));
    }
    Ok(())
}

trait PayloadContract {
    fn validate(&self) -> Result<(), String> {
        Ok(())
    }
}

macro_rules! payload_ok {
    ($($type:ty),+ $(,)?) => {
        $(impl PayloadContract for $type {})+
    };
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentHello {
    pub device_public_id: String,
    pub device_key_id: String,
    pub agent_version: String,
    pub os: String,
    pub arch: String,
    pub supported_protocol_versions: Vec<String>,
    pub capabilities: Vec<String>,
    pub connection_nonce: String,
}

impl PayloadContract for AgentHello {
    fn validate(&self) -> Result<(), String> {
        if self.supported_protocol_versions.is_empty() {
            return Err("supported_protocol_versions must not be empty".to_owned());
        }
        if self.connection_nonce.chars().count() < 16 {
            return Err("connection_nonce must contain at least 16 characters".to_owned());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionLimits {
    pub max_frame_bytes: u64,
    pub max_output_chunk_bytes: u64,
    pub process_ring_buffer_bytes: u64,
    pub max_inline_result_bytes: u64,
}
impl Default for ConnectionLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: 256 * 1024,
            max_output_chunk_bytes: 64 * 1024,
            process_ring_buffer_bytes: 4 * 1024 * 1024,
            max_inline_result_bytes: 256 * 1024,
        }
    }
}

impl ConnectionLimits {
    pub fn validate(&self) -> Result<(), String> {
        validate_range("max_frame_bytes", self.max_frame_bytes, 1024, 1_048_576)?;
        validate_range(
            "max_output_chunk_bytes",
            self.max_output_chunk_bytes,
            1024,
            262_144,
        )?;
        validate_range(
            "process_ring_buffer_bytes",
            self.process_ring_buffer_bytes,
            65_536,
            67_108_864,
        )?;
        validate_range(
            "max_inline_result_bytes",
            self.max_inline_result_bytes,
            1024,
            1_048_576,
        )
    }
}
fn validate_range(field: &str, value: u64, min: u64, max: u64) -> Result<(), String> {
    if !(min..=max).contains(&value) {
        return Err(format!("{field} must be between {min} and {max}"));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentHelloAck {
    pub connection_id: String,
    pub selected_protocol_version: String,
    pub server_time: DateTime<Utc>,
    pub heartbeat_interval_seconds: u16,
    pub limits: ConnectionLimits,
    #[serde(default)]
    pub policy_revision: Option<String>,
}

impl PayloadContract for AgentHelloAck {
    fn validate(&self) -> Result<(), String> {
        if !(5..=300).contains(&self.heartbeat_interval_seconds) {
            return Err("heartbeat_interval_seconds must be between 5 and 300".to_owned());
        }
        self.limits.validate()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PermissionDomain {
    FsRead,
    FsWrite,
    FsDelete,
    ShellSafe,
    ShellFull,
    ProcessControl,
    Network,
    GitWrite,
    GitRemoteWrite,
    ScreenRead,
    InputControl,
    Browser,
    SecretUse,
    Elevation,
    Admin,
}

impl PermissionDomain {
    pub const ALL: [Self; 15] = [
        Self::FsRead,
        Self::FsWrite,
        Self::FsDelete,
        Self::ShellSafe,
        Self::ShellFull,
        Self::ProcessControl,
        Self::Network,
        Self::GitWrite,
        Self::GitRemoteWrite,
        Self::ScreenRead,
        Self::InputControl,
        Self::Browser,
        Self::SecretUse,
        Self::Elevation,
        Self::Admin,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FsRead => "FS_READ",
            Self::FsWrite => "FS_WRITE",
            Self::FsDelete => "FS_DELETE",
            Self::ShellSafe => "SHELL_SAFE",
            Self::ShellFull => "SHELL_FULL",
            Self::ProcessControl => "PROCESS_CONTROL",
            Self::Network => "NETWORK",
            Self::GitWrite => "GIT_WRITE",
            Self::GitRemoteWrite => "GIT_REMOTE_WRITE",
            Self::ScreenRead => "SCREEN_READ",
            Self::InputControl => "INPUT_CONTROL",
            Self::Browser => "BROWSER",
            Self::SecretUse => "SECRET_USE",
            Self::Elevation => "ELEVATION",
            Self::Admin => "ADMIN",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

impl RiskLevel {
    pub const ALL: [Self; 4] = [Self::Low, Self::Medium, Self::High, Self::Critical];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "LOW",
            Self::Medium => "MEDIUM",
            Self::High => "HIGH",
            Self::Critical => "CRITICAL",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommandOperation {
    #[serde(rename = "fs.list")]
    FsList,
    #[serde(rename = "fs.stat")]
    FsStat,
    #[serde(rename = "fs.read")]
    FsRead,
    #[serde(rename = "fs.write")]
    FsWrite,
    #[serde(rename = "fs.patch")]
    FsPatch,
    #[serde(rename = "fs.search")]
    FsSearch,
    #[serde(rename = "shell.exec")]
    ShellExec,
    #[serde(rename = "process.start")]
    ProcessStart,
    #[serde(rename = "process.read")]
    ProcessRead,
    #[serde(rename = "process.write")]
    ProcessWrite,
    #[serde(rename = "process.cancel")]
    ProcessCancel,
    #[serde(rename = "process.list")]
    ProcessList,
    #[serde(rename = "git.status")]
    GitStatus,
    #[serde(rename = "git.diff")]
    GitDiff,
    #[serde(rename = "screen.capture")]
    ScreenCapture,
    #[serde(rename = "computer.input")]
    ComputerInput,
    #[serde(rename = "system.metrics")]
    SystemMetrics,
}

impl CommandOperation {
    pub const ALL: [Self; 17] = [
        Self::FsList,
        Self::FsStat,
        Self::FsRead,
        Self::FsWrite,
        Self::FsPatch,
        Self::FsSearch,
        Self::ShellExec,
        Self::ProcessStart,
        Self::ProcessRead,
        Self::ProcessWrite,
        Self::ProcessCancel,
        Self::ProcessList,
        Self::GitStatus,
        Self::GitDiff,
        Self::ScreenCapture,
        Self::ComputerInput,
        Self::SystemMetrics,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FsList => "fs.list",
            Self::FsStat => "fs.stat",
            Self::FsRead => "fs.read",
            Self::FsWrite => "fs.write",
            Self::FsPatch => "fs.patch",
            Self::FsSearch => "fs.search",
            Self::ShellExec => "shell.exec",
            Self::ProcessStart => "process.start",
            Self::ProcessRead => "process.read",
            Self::ProcessWrite => "process.write",
            Self::ProcessCancel => "process.cancel",
            Self::ProcessList => "process.list",
            Self::GitStatus => "git.status",
            Self::GitDiff => "git.diff",
            Self::ScreenCapture => "screen.capture",
            Self::ComputerInput => "computer.input",
            Self::SystemMetrics => "system.metrics",
        }
    }

    pub const fn has_side_effect(self) -> bool {
        matches!(
            self,
            Self::FsWrite
                | Self::FsPatch
                | Self::ShellExec
                | Self::ProcessStart
                | Self::ProcessWrite
                | Self::ProcessCancel
                | Self::ComputerInput
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandRequest {
    pub command_id: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    pub operation: CommandOperation,
    pub arguments: Map<String, Value>,
    pub requested_permissions: Vec<PermissionDomain>,
    pub risk: RiskLevel,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub approval_id: Option<String>,
}

impl CommandRequest {
    pub fn test_read_only() -> Self {
        Self {
            command_id: "cmd_test".to_owned(),
            idempotency_key: None,
            operation: CommandOperation::FsRead,
            arguments: Map::new(),
            requested_permissions: vec![PermissionDomain::FsRead],
            risk: RiskLevel::Low,
            workspace_id: None,
            approval_id: None,
        }
    }
}

impl PayloadContract for CommandRequest {
    fn validate(&self) -> Result<(), String> {
        let unique: HashSet<_> = self.requested_permissions.iter().copied().collect();
        if unique.len() != self.requested_permissions.len() {
            return Err("requested_permissions must contain unique values".to_owned());
        }

        if self.operation.has_side_effect() {
            let key = self
                .idempotency_key
                .as_deref()
                .ok_or_else(|| "side-effect operation requires idempotency_key".to_owned())?;
            let len = key.chars().count();
            if !(8..=160).contains(&len) {
                return Err("idempotency_key length must be between 8 and 160".to_owned());
            }
        } else if let Some(key) = self.idempotency_key.as_deref() {
            let len = key.chars().count();
            if !(8..=160).contains(&len) {
                return Err("idempotency_key length must be between 8 and 160".to_owned());
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandAccepted {
    pub command_id: String,
    pub accepted_at: DateTime<Utc>,
    #[serde(default)]
    pub process_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandStream {
    Stdout,
    Stderr,
    Event,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandChunk {
    pub command_id: String,
    pub stream: CommandStream,
    pub offset: u64,
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default)]
    pub artifact_id: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandCompleted {
    pub command_id: String,
    pub completed_at: DateTime<Utc>,
    pub result: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    Unauthenticated,
    Unauthorized,
    PolicyDenied,
    ApprovalRequired,
    DeviceOffline,
    DeviceRevoked,
    InvalidArgument,
    NotFound,
    Conflict,
    Timeout,
    DeadlineExceeded,
    OutputTruncated,
    IdempotencyConflict,
    UnsupportedProtocol,
    UnsupportedCapability,
    RateLimited,
    InternalError,
}

impl ErrorCode {
    pub const ALL: [Self; 17] = [
        Self::Unauthenticated,
        Self::Unauthorized,
        Self::PolicyDenied,
        Self::ApprovalRequired,
        Self::DeviceOffline,
        Self::DeviceRevoked,
        Self::InvalidArgument,
        Self::NotFound,
        Self::Conflict,
        Self::Timeout,
        Self::DeadlineExceeded,
        Self::OutputTruncated,
        Self::IdempotencyConflict,
        Self::UnsupportedProtocol,
        Self::UnsupportedCapability,
        Self::RateLimited,
        Self::InternalError,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unauthenticated => "UNAUTHENTICATED",
            Self::Unauthorized => "UNAUTHORIZED",
            Self::PolicyDenied => "POLICY_DENIED",
            Self::ApprovalRequired => "APPROVAL_REQUIRED",
            Self::DeviceOffline => "DEVICE_OFFLINE",
            Self::DeviceRevoked => "DEVICE_REVOKED",
            Self::InvalidArgument => "INVALID_ARGUMENT",
            Self::NotFound => "NOT_FOUND",
            Self::Conflict => "CONFLICT",
            Self::Timeout => "TIMEOUT",
            Self::DeadlineExceeded => "DEADLINE_EXCEEDED",
            Self::OutputTruncated => "OUTPUT_TRUNCATED",
            Self::IdempotencyConflict => "IDEMPOTENCY_CONFLICT",
            Self::UnsupportedProtocol => "UNSUPPORTED_PROTOCOL",
            Self::UnsupportedCapability => "UNSUPPORTED_CAPABILITY",
            Self::RateLimited => "RATE_LIMITED",
            Self::InternalError => "INTERNAL_ERROR",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TelechirError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default)]
    pub retry_after_ms: Option<u64>,
    #[serde(default)]
    pub details: Option<Map<String, Value>>,
}

impl PayloadContract for TelechirError {
    fn validate(&self) -> Result<(), String> {
        let len = self.message.chars().count();
        if !(1..=1000).contains(&len) {
            return Err("error message length must be between 1 and 1000".to_owned());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandFailed {
    pub command_id: String,
    pub failed_at: DateTime<Utc>,
    pub error: TelechirError,
}

impl PayloadContract for CommandFailed {
    fn validate(&self) -> Result<(), String> {
        self.error.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandCancel {
    pub command_id: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelState {
    Cancelled,
    AlreadyFinished,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandCancelled {
    pub command_id: String,
    pub cancelled_at: DateTime<Utc>,
    pub state: CancelState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heartbeat {
    pub agent_time: DateTime<Utc>,
    pub last_received_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeartbeatAck {
    pub server_time: DateTime<Utc>,
    pub last_received_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilitiesChanged {
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub agent_version: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

impl PayloadContract for CapabilitiesChanged {
    fn validate(&self) -> Result<(), String> {
        let unique: HashSet<_> = self.capabilities.iter().collect();
        if unique.len() != self.capabilities.len() {
            return Err("capabilities must contain unique values".to_owned());
        }
        if self
            .reason
            .as_deref()
            .is_some_and(|reason| reason.chars().count() > 500)
        {
            return Err("reason length must be at most 500".to_owned());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub command_id: String,
    pub permission: PermissionDomain,
    pub risk: RiskLevel,
    pub argument_digest: String,
    #[serde(default)]
    pub human_summary: Option<String>,
    pub expires_at: DateTime<Utc>,
}

impl PayloadContract for ApprovalRequest {
    fn validate(&self) -> Result<(), String> {
        if !(8..=160).contains(&self.approval_id.chars().count()) {
            return Err("approval_id length must be between 8 and 160".to_owned());
        }
        if !(1..=160).contains(&self.command_id.chars().count()) {
            return Err("command_id length must be between 1 and 160".to_owned());
        }
        if self.argument_digest.len() != 43
            || !self
                .argument_digest
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err("argument_digest must be a SHA-256 base64url digest".to_owned());
        }
        if self
            .human_summary
            .as_deref()
            .is_some_and(|summary| summary.chars().count() > 2000)
        {
            return Err("human_summary length must be at most 2000".to_owned());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ApprovalDecisionKind {
    Approve,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalScope {
    #[default]
    Once,
    Session,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalDecision {
    pub approval_id: String,
    pub decision: ApprovalDecisionKind,
    pub decided_at: DateTime<Utc>,
    #[serde(default)]
    pub scope: ApprovalScope,
}

impl PayloadContract for ApprovalDecision {
    fn validate(&self) -> Result<(), String> {
        if !(8..=160).contains(&self.approval_id.chars().count()) {
            return Err("approval_id length must be between 8 and 160".to_owned());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolErrorPayload {
    pub error: TelechirError,
}

impl PayloadContract for ProtocolErrorPayload {
    fn validate(&self) -> Result<(), String> {
        self.error.validate()
    }
}
payload_ok!(
    CommandAccepted,
    CommandChunk,
    CommandCompleted,
    CommandCancel,
    CommandCancelled,
    Heartbeat,
    HeartbeatAck,
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_type_baseline_has_exactly_fifteen_variants() {
        assert_eq!(MessageType::ALL.len(), 15);
        let names: HashSet<_> = MessageType::ALL.iter().map(|item| item.as_str()).collect();
        assert_eq!(names.len(), 15);
    }

    #[test]
    fn all_side_effect_operations_are_marked() {
        let side_effects = [
            CommandOperation::FsWrite,
            CommandOperation::FsPatch,
            CommandOperation::ShellExec,
            CommandOperation::ProcessStart,
            CommandOperation::ProcessWrite,
            CommandOperation::ProcessCancel,
            CommandOperation::ComputerInput,
        ];
        assert!(
            side_effects
                .into_iter()
                .all(CommandOperation::has_side_effect)
        );
        assert!(!CommandOperation::FsRead.has_side_effect());
    }

    #[test]
    fn default_connection_limits_match_protocol_baseline() {
        let limits = ConnectionLimits::default();
        assert_eq!(limits.max_frame_bytes, 256 * 1024);
        assert_eq!(limits.max_output_chunk_bytes, 64 * 1024);
        assert_eq!(limits.process_ring_buffer_bytes, 4 * 1024 * 1024);
        assert_eq!(limits.max_inline_result_bytes, 256 * 1024);
        limits.validate().unwrap();
    }
}
