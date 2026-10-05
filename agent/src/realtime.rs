use std::collections::VecDeque;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, to_value};
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};
use url::Url;
use uuid::Uuid;

use crate::ports::{AuthorizationOutcome, CommandExecutor, ExecutionOutcome};
use crate::protocol::{
    AgentHello, AgentHelloAck, ApprovalDecision, ApprovalRequest, CommandAccepted,
    CommandCompleted, CommandFailed, CommandRequest, DeviceMessage, ErrorCode, Heartbeat,
    MessageType, PROTOCOL_VERSION, TelechirError, decode_and_validate,
};

pub const REALTIME_MAX_FRAME_BYTES: usize = 256 * 1024;
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_RECONNECT_BASE: Duration = Duration::from_millis(500);
pub const DEFAULT_RECONNECT_MAX: Duration = Duration::from_secs(30);
const RECENT_MESSAGE_IDS: usize = 64;

type AgentSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeClientConfig {
    pub websocket_url: String,
    pub device_id: String,
    pub device_key_id: String,
    pub agent_version: String,
    pub os: String,
    pub arch: String,
    pub capabilities: Vec<String>,
    pub handshake_timeout: Duration,
}

impl RealtimeClientConfig {
    pub fn validate(&self) -> Result<(), RealtimeError> {
        let url = Url::parse(&self.websocket_url)
            .map_err(|error| RealtimeError::Configuration(error.to_string()))?;
        let secure = url.scheme() == "wss";
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        if !secure && !(url.scheme() == "ws" && local) {
            return Err(RealtimeError::Configuration(
                "realtime URL must use wss:// outside localhost".to_owned(),
            ));
        }
        if self.device_id.is_empty() || self.device_key_id.is_empty() {
            return Err(RealtimeError::Configuration(
                "device identity must not be empty".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeState {
    Disconnected,
    Connecting,
    Online,
}

#[derive(Debug, Clone)]
pub struct ReconnectController {
    attempt: u32,
    base: Duration,
    max: Duration,
}

impl Default for ReconnectController {
    fn default() -> Self {
        Self {
            attempt: 0,
            base: DEFAULT_RECONNECT_BASE,
            max: DEFAULT_RECONNECT_MAX,
        }
    }
}

impl ReconnectController {
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn next_delay(&mut self) -> Duration {
        let mut jitter = [0_u8; 2];
        if getrandom::fill(&mut jitter).is_err() {
            jitter = [128, 0];
        }
        let unit = u16::from_le_bytes(jitter);
        let delay = self.delay_for(self.attempt, unit);
        self.attempt = self.attempt.saturating_add(1);
        delay
    }

    pub fn delay_for(&self, attempt: u32, jitter: u16) -> Duration {
        let exponent = attempt.min(16);
        let base_ms = self
            .base
            .as_millis()
            .saturating_mul(1_u128 << exponent)
            .min(self.max.as_millis());
        let centered = i64::from(jitter) - 32_768;
        let jitter_ppm = centered * 200_000 / 32_768;
        let adjusted =
            (base_ms as i128).saturating_mul(1_000_000 + i128::from(jitter_ppm)) / 1_000_000;
        let capped = adjusted.max(1).min(self.max.as_millis() as i128);
        Duration::from_millis(capped as u64)
    }

    pub const fn replays_commands_after_reconnect(&self) -> bool {
        false
    }
}
#[derive(Debug)]
struct ConnectionSequence {
    next_outbound: u64,
    last_inbound: Option<u64>,
    recent_message_ids: VecDeque<String>,
}

impl ConnectionSequence {
    fn new() -> Self {
        Self {
            next_outbound: 0,
            last_inbound: None,
            recent_message_ids: VecDeque::new(),
        }
    }

    fn next_outbound(&mut self) -> u64 {
        let value = self.next_outbound;
        self.next_outbound = self.next_outbound.saturating_add(1);
        value
    }

    fn accept_inbound(&mut self, message: &DeviceMessage) -> Result<(), RealtimeError> {
        if self
            .last_inbound
            .is_some_and(|previous| message.sequence <= previous)
        {
            return Err(RealtimeError::Protocol(
                "non-monotonic inbound sequence".to_owned(),
            ));
        }
        if self
            .recent_message_ids
            .iter()
            .any(|known| known == &message.message_id)
        {
            return Err(RealtimeError::Protocol(
                "duplicate inbound message_id".to_owned(),
            ));
        }
        self.last_inbound = Some(message.sequence);
        self.recent_message_ids
            .push_back(message.message_id.clone());
        while self.recent_message_ids.len() > RECENT_MESSAGE_IDS {
            self.recent_message_ids.pop_front();
        }
        Ok(())
    }

    fn last_inbound_or_zero(&self) -> u64 {
        self.last_inbound.unwrap_or(0)
    }
}

pub struct RealtimeConnection {
    socket: AgentSocket,
    config: RealtimeClientConfig,
    connection_id: String,
    heartbeat_interval: Duration,
    sequence: ConnectionSequence,
}

impl RealtimeConnection {
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub const fn state(&self) -> RealtimeState {
        RealtimeState::Online
    }

    pub fn heartbeat_interval(&self) -> Duration {
        self.heartbeat_interval
    }

    pub async fn send_heartbeat(&mut self) -> Result<(), RealtimeError> {
        let heartbeat = Heartbeat {
            agent_time: Utc::now(),
            last_received_sequence: self.sequence.last_inbound_or_zero(),
        };
        let message = DeviceMessage {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            message_type: MessageType::Heartbeat,
            message_id: new_message_id(),
            correlation_id: None,
            device_id: self.config.device_id.clone(),
            session_id: None,
            connection_id: Some(self.connection_id.clone()),
            sequence: self.sequence.next_outbound(),
            sent_at: Utc::now(),
            deadline_at: None,
            payload: to_value(heartbeat)
                .map_err(|error| RealtimeError::Protocol(error.to_string()))?,
        };
        self.send_message(&message).await
    }

    pub async fn receive(&mut self) -> Result<DeviceMessage, RealtimeError> {
        loop {
            let item = self
                .socket
                .next()
                .await
                .ok_or(RealtimeError::Disconnected)?
                .map_err(|error| RealtimeError::Transport(error.to_string()))?;

            match item {
                Message::Text(text) => {
                    if text.len() > REALTIME_MAX_FRAME_BYTES {
                        return Err(RealtimeError::Protocol(
                            "inbound frame exceeds negotiated limit".to_owned(),
                        ));
                    }
                    let message = decode_and_validate(text.as_str())
                        .map_err(|error| RealtimeError::Protocol(error.to_string()))?;
                    if message.device_id != self.config.device_id {
                        return Err(RealtimeError::Protocol("device_id mismatch".to_owned()));
                    }
                    if message.connection_id.as_deref() != Some(&self.connection_id) {
                        return Err(RealtimeError::Protocol("connection_id mismatch".to_owned()));
                    }
                    self.sequence.accept_inbound(&message)?;
                    return Ok(message);
                }
                Message::Close(_) => return Err(RealtimeError::Disconnected),
                Message::Binary(_) => {
                    return Err(RealtimeError::Protocol(
                        "binary frames are not supported in protocol 0.1".to_owned(),
                    ));
                }
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            }
        }
    }

    pub async fn handle_next_server_message<E>(
        &mut self,
        executor: &mut E,
    ) -> Result<Option<String>, RealtimeError>
    where
        E: CommandExecutor,
        E::Error: std::fmt::Display,
    {
        let message = self.receive().await?;

        if message.message_type == MessageType::ApprovalDecision {
            let decision: ApprovalDecision = serde_json::from_value(message.payload.clone())
                .map_err(|error| RealtimeError::Protocol(error.to_string()))?;
            executor.apply_approval_decision(&decision, message.session_id.as_deref());
            return Ok(None);
        }

        if message.message_type != MessageType::CommandRequest {
            return Ok(None);
        }

        let request: CommandRequest = serde_json::from_value(message.payload.clone())
            .map_err(|error| RealtimeError::Protocol(error.to_string()))?;
        let command_id = request.command_id.clone();

        if message
            .deadline_at
            .is_some_and(|deadline| deadline <= Utc::now())
        {
            self.send_command_failed(
                &message.message_id,
                &command_id,
                TelechirError {
                    code: ErrorCode::DeadlineExceeded,
                    message: "command deadline elapsed before local execution".to_owned(),
                    retryable: false,
                    retry_after_ms: None,
                    details: None,
                },
            )
            .await?;
            return Ok(Some(command_id));
        }

        let (prepared, approval_verified) =
            match executor.authorize(&request, message.session_id.as_deref()) {
                AuthorizationOutcome::Allow {
                    request,
                    approval_verified,
                } => (request, approval_verified),
                AuthorizationOutcome::Ask(approval) => {
                    self.send_approval_request(&message.message_id, approval)
                        .await?;
                    return Ok(Some(command_id));
                }
                AuthorizationOutcome::Deny(error) => {
                    self.send_command_failed(&message.message_id, &command_id, error)
                        .await?;
                    return Ok(Some(command_id));
                }
            };

        self.send_command_accepted(&message.message_id, &command_id)
            .await?;

        let outcome = executor
            .execute_authorized(&prepared, approval_verified)
            .map_err(|_error| {
                RealtimeError::Protocol("local command executor failed unexpectedly".to_owned())
            })?;

        match outcome {
            ExecutionOutcome::Completed(Value::Object(result)) => {
                self.send_command_completed(&message.message_id, &command_id, result)
                    .await?;
            }
            ExecutionOutcome::Completed(_) => {
                self.send_command_failed(
                    &message.message_id,
                    &command_id,
                    TelechirError {
                        code: ErrorCode::InternalError,
                        message: "local command result must be a JSON object".to_owned(),
                        retryable: false,
                        retry_after_ms: None,
                        details: None,
                    },
                )
                .await?;
            }
            ExecutionOutcome::Failed(error) => {
                self.send_command_failed(&message.message_id, &command_id, error)
                    .await?;
            }
        }

        Ok(Some(command_id))
    }

    async fn send_approval_request(
        &mut self,
        correlation_id: &str,
        approval: ApprovalRequest,
    ) -> Result<(), RealtimeError> {
        self.send_protocol_payload(
            MessageType::ApprovalRequest,
            Some(correlation_id.to_owned()),
            to_value(approval).map_err(|error| RealtimeError::Protocol(error.to_string()))?,
        )
        .await
    }

    async fn send_command_accepted(
        &mut self,
        correlation_id: &str,
        command_id: &str,
    ) -> Result<(), RealtimeError> {
        let payload = CommandAccepted {
            command_id: command_id.to_owned(),
            accepted_at: Utc::now(),
            process_id: None,
        };
        self.send_protocol_payload(
            MessageType::CommandAccepted,
            Some(correlation_id.to_owned()),
            to_value(payload).map_err(|error| RealtimeError::Protocol(error.to_string()))?,
        )
        .await
    }

    async fn send_command_completed(
        &mut self,
        correlation_id: &str,
        command_id: &str,
        result: Map<String, Value>,
    ) -> Result<(), RealtimeError> {
        let payload = CommandCompleted {
            command_id: command_id.to_owned(),
            completed_at: Utc::now(),
            result,
        };
        self.send_protocol_payload(
            MessageType::CommandCompleted,
            Some(correlation_id.to_owned()),
            to_value(payload).map_err(|error| RealtimeError::Protocol(error.to_string()))?,
        )
        .await
    }

    async fn send_command_failed(
        &mut self,
        correlation_id: &str,
        command_id: &str,
        error: TelechirError,
    ) -> Result<(), RealtimeError> {
        let payload = CommandFailed {
            command_id: command_id.to_owned(),
            failed_at: Utc::now(),
            error,
        };
        self.send_protocol_payload(
            MessageType::CommandFailed,
            Some(correlation_id.to_owned()),
            to_value(payload).map_err(|error| RealtimeError::Protocol(error.to_string()))?,
        )
        .await
    }

    async fn send_protocol_payload(
        &mut self,
        message_type: MessageType,
        correlation_id: Option<String>,
        payload: Value,
    ) -> Result<(), RealtimeError> {
        let message = DeviceMessage {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            message_type,
            message_id: new_message_id(),
            correlation_id,
            device_id: self.config.device_id.clone(),
            session_id: None,
            connection_id: Some(self.connection_id.clone()),
            sequence: self.sequence.next_outbound(),
            sent_at: Utc::now(),
            deadline_at: None,
            payload,
        };
        self.send_message(&message).await
    }

    pub async fn close(mut self) -> Result<(), RealtimeError> {
        self.socket
            .close(None)
            .await
            .map_err(|error| RealtimeError::Transport(error.to_string()))
    }

    async fn send_message(&mut self, message: &DeviceMessage) -> Result<(), RealtimeError> {
        let serialized = serde_json::to_string(message)
            .map_err(|error| RealtimeError::Protocol(error.to_string()))?;
        if serialized.len() > REALTIME_MAX_FRAME_BYTES {
            return Err(RealtimeError::Protocol(
                "outbound frame exceeds negotiated limit".to_owned(),
            ));
        }
        self.socket
            .send(Message::Text(serialized.into()))
            .await
            .map_err(|error| RealtimeError::Transport(error.to_string()))
    }
}
pub async fn connect_realtime(
    config: RealtimeClientConfig,
    credential: &str,
    connection_nonce: &str,
) -> Result<RealtimeConnection, RealtimeError> {
    config.validate()?;
    if connection_nonce.len() < 16 || connection_nonce.len() > 128 {
        return Err(RealtimeError::Configuration(
            "connection nonce must contain 16..128 characters".to_owned(),
        ));
    }

    let mut request = config
        .websocket_url
        .as_str()
        .into_client_request()
        .map_err(|error| RealtimeError::Configuration(error.to_string()))?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {credential}"))
            .map_err(|error| RealtimeError::Configuration(error.to_string()))?,
    );

    let websocket_config = WebSocketConfig::default()
        .max_message_size(Some(REALTIME_MAX_FRAME_BYTES))
        .max_frame_size(Some(REALTIME_MAX_FRAME_BYTES));

    let connect = connect_async_with_config(request, Some(websocket_config), false);
    let (socket, _) = timeout(config.handshake_timeout, connect)
        .await
        .map_err(|_| RealtimeError::Timeout)?
        .map_err(|error| RealtimeError::Transport(error.to_string()))?;

    let mut connection = RealtimeConnection {
        socket,
        config: config.clone(),
        connection_id: String::new(),
        heartbeat_interval: Duration::from_secs(30),
        sequence: ConnectionSequence::new(),
    };

    let hello = AgentHello {
        device_public_id: config.device_id.clone(),
        device_key_id: config.device_key_id.clone(),
        agent_version: config.agent_version.clone(),
        os: config.os.clone(),
        arch: config.arch.clone(),
        supported_protocol_versions: vec![PROTOCOL_VERSION.to_owned()],
        capabilities: config.capabilities.clone(),
        connection_nonce: connection_nonce.to_owned(),
    };
    let hello_message = DeviceMessage {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        message_type: MessageType::AgentHello,
        message_id: new_message_id(),
        correlation_id: None,
        device_id: config.device_id.clone(),
        session_id: None,
        connection_id: None,
        sequence: connection.sequence.next_outbound(),
        sent_at: Utc::now(),
        deadline_at: None,
        payload: to_value(hello).map_err(|error| RealtimeError::Protocol(error.to_string()))?,
    };
    connection.send_message(&hello_message).await?;

    let ack = timeout(
        config.handshake_timeout,
        receive_handshake(&mut connection.socket),
    )
    .await
    .map_err(|_| RealtimeError::Timeout)??;
    if ack.message_type != MessageType::AgentHelloAck {
        return Err(RealtimeError::Protocol(
            "first server message must be agent.hello_ack".to_owned(),
        ));
    }
    if ack.device_id != config.device_id {
        return Err(RealtimeError::Protocol(
            "hello_ack device_id mismatch".to_owned(),
        ));
    }
    connection.sequence.accept_inbound(&ack)?;
    let payload: AgentHelloAck = serde_json::from_value(ack.payload.clone())
        .map_err(|error| RealtimeError::Protocol(error.to_string()))?;
    if payload.selected_protocol_version != PROTOCOL_VERSION {
        return Err(RealtimeError::Protocol(
            "server selected unsupported protocol version".to_owned(),
        ));
    }
    if ack.connection_id.as_deref() != Some(payload.connection_id.as_str()) {
        return Err(RealtimeError::Protocol(
            "hello_ack connection_id mismatch".to_owned(),
        ));
    }

    connection.connection_id = payload.connection_id;
    connection.heartbeat_interval =
        Duration::from_secs(u64::from(payload.heartbeat_interval_seconds));
    Ok(connection)
}

async fn receive_handshake(socket: &mut AgentSocket) -> Result<DeviceMessage, RealtimeError> {
    loop {
        let item = socket
            .next()
            .await
            .ok_or(RealtimeError::Disconnected)?
            .map_err(|error| RealtimeError::Transport(error.to_string()))?;
        match item {
            Message::Text(text) => {
                if text.len() > REALTIME_MAX_FRAME_BYTES {
                    return Err(RealtimeError::Protocol(
                        "handshake frame exceeds negotiated limit".to_owned(),
                    ));
                }
                return decode_and_validate(text.as_str())
                    .map_err(|error| RealtimeError::Protocol(error.to_string()));
            }
            Message::Close(_) => return Err(RealtimeError::Disconnected),
            Message::Binary(_) => {
                return Err(RealtimeError::Protocol(
                    "binary handshake frames are unsupported".to_owned(),
                ));
            }
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        }
    }
}

pub fn new_connection_nonce() -> Result<String, RealtimeError> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(|error| RealtimeError::Random(error.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn new_message_id() -> String {
    format!("msg_{}", Uuid::new_v4())
}

#[derive(Debug, Error)]
pub enum RealtimeError {
    #[error("realtime configuration error: {0}")]
    Configuration(String),
    #[error("realtime transport error: {0}")]
    Transport(String),
    #[error("realtime protocol error: {0}")]
    Protocol(String),
    #[error("realtime connection timed out")]
    Timeout,
    #[error("realtime connection disconnected")]
    Disconnected,
    #[error("operating-system random source failed: {0}")]
    Random(String),
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_backoff_is_bounded_and_never_replays_commands() {
        let mut controller = ReconnectController::default();

        let low_jitter = controller.delay_for(0, 0);
        let high_jitter = controller.delay_for(0, u16::MAX);
        let capped = controller.delay_for(30, u16::MAX);

        assert!(low_jitter >= Duration::from_millis(399));
        assert!(high_jitter <= Duration::from_millis(601));
        assert!(capped <= DEFAULT_RECONNECT_MAX);
        assert!(!controller.replays_commands_after_reconnect());

        let first = controller.next_delay();
        assert!(first >= Duration::from_millis(399));
        controller.reset();
        assert_eq!(controller.attempt, 0);
    }

    #[test]
    fn config_requires_tls_outside_localhost() {
        let config = RealtimeClientConfig {
            websocket_url: "ws://example.com/realtime".to_owned(),
            device_id: "device".to_owned(),
            device_key_id: "key".to_owned(),
            agent_version: "0.1.0".to_owned(),
            os: "linux".to_owned(),
            arch: "x86_64".to_owned(),
            capabilities: vec![],
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
        };

        assert!(config.validate().is_err());
    }

    #[test]
    fn generated_connection_nonce_has_contract_length() {
        let nonce = new_connection_nonce().unwrap();
        assert!((16..=128).contains(&nonce.len()));
    }

    #[test]
    fn inbound_sequence_rejects_duplicates_and_regressions() {
        let mut sequence = ConnectionSequence::new();
        let base = DeviceMessage {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            message_type: MessageType::HeartbeatAck,
            message_id: "message_0001".to_owned(),
            correlation_id: None,
            device_id: "device".to_owned(),
            session_id: None,
            connection_id: Some("connection".to_owned()),
            sequence: 1,
            sent_at: Utc::now(),
            deadline_at: None,
            payload: serde_json::json!({
                "server_time": Utc::now(),
                "last_received_sequence": 0
            }),
        };
        sequence.accept_inbound(&base).unwrap();

        let mut duplicate_id = base.clone();
        duplicate_id.sequence = 2;
        assert!(sequence.accept_inbound(&duplicate_id).is_err());

        let mut regression = base;
        regression.message_id = "message_0002".to_owned();
        regression.sequence = 1;
        assert!(sequence.accept_inbound(&regression).is_err());
    }
}
