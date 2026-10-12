//! Explicit fail-closed session supervisor for an ALREADY-PAIRED device.
//! The current binary does not call this module: no implicit network or authority.
use std::fmt;
use std::future::Future;
use std::time::Duration;

use thiserror::Error;
use tokio::time::{Instant, interval_at, timeout};
use zeroize::Zeroize;

use crate::ports::CommandExecutor;
use crate::realtime::{RealtimeClientConfig, RealtimeConnection, connect_realtime};

const MAX_TOKEN_BYTES: usize = 16 * 1024;
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

/// Scoped token material must be provided by a future verified credential
/// broker, never inferred from config defaults or a user session.
pub struct SessionCredentials {
    bearer: String,
    connection_nonce: String,
}

impl SessionCredentials {
    pub fn new(bearer: String, connection_nonce: String) -> Result<Self, SessionError> {
        if bearer.is_empty()
            || bearer.len() > MAX_TOKEN_BYTES
            || bearer.bytes().any(|byte| !byte.is_ascii_graphic())
            || !(16..=128).contains(&connection_nonce.len())
            || !connection_nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(SessionError::NotProvisioned);
        }
        Ok(Self {
            bearer,
            connection_nonce,
        })
    }
}

impl fmt::Debug for SessionCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCredentials")
            .field("bearer", &"[redacted]")
            .field("connection_nonce", &"[redacted]")
            .finish()
    }
}

impl Drop for SessionCredentials {
    fn drop(&mut self) {
        self.bearer.zeroize();
        self.connection_nonce.zeroize();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionExit {
    StoppedByHost,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("device session credential is not provisioned")]
    NotProvisioned,
    #[error("invalid realtime connection configuration")]
    InvalidConfiguration,
    #[error("realtime session could not connect or negotiate")]
    ConnectFailed,
    #[error("realtime session disconnected or protocol was rejected")]
    Disconnected,
    #[error("realtime session failed to send a heartbeat")]
    HeartbeatFailed,
}

/// Host must supply a previously authorized device credential, fresh nonce,
/// restricted CommandExecutor and shutdown signal explicitly. There is NO
/// retry: a caller must re-prove identity and get a NEW connection credential.
pub async fn run_authenticated_session<E, S>(
    config: RealtimeClientConfig,
    credentials: SessionCredentials,
    executor: &mut E,
    shutdown: S,
) -> Result<SessionExit, SessionError>
where
    E: CommandExecutor,
    E::Error: fmt::Display,
    S: Future<Output = ()>,
{
    config
        .validate()
        .map_err(|_| SessionError::InvalidConfiguration)?;
    tokio::pin!(shutdown);
    let connection = tokio::select! {
        biased;
        () = &mut shutdown => return Ok(SessionExit::StoppedByHost),
        result = connect_realtime(config, &credentials.bearer, &credentials.connection_nonce) =>
            result.map_err(|_| SessionError::ConnectFailed)?,
    };
    run_established_session(connection, executor, shutdown).await
}

/// Existing realtime transport and local policy handle all typed commands.
/// Heartbeats honor the negotiated cadence, with missed ticks skipped.
/// Disconnects fail closed, without command replay or automatic credential reuse.
pub async fn run_established_session<E, S>(
    mut connection: RealtimeConnection,
    executor: &mut E,
    shutdown: S,
) -> Result<SessionExit, SessionError>
where
    E: CommandExecutor,
    E::Error: fmt::Display,
    S: Future<Output = ()>,
{
    tokio::pin!(shutdown);
    let heartbeat = connection.heartbeat_interval();
    let mut interval = interval_at(Instant::now() + heartbeat, heartbeat);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            () = &mut shutdown => {
                let _ = timeout(CLOSE_TIMEOUT, connection.close()).await;
                return Ok(SessionExit::StoppedByHost);
            }
            result = connection.handle_next_server_message(executor) => {
                if result.is_err() {
                    return Err(SessionError::Disconnected);
                }
            }
            _ = interval.tick() => {
                connection.send_heartbeat().await.map_err(|_| SessionError::HeartbeatFailed)?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use chrono::Utc;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::to_value;
    use tokio::net::TcpListener;
    use tokio::time::sleep;
    use tokio_tungstenite::accept_async;
    use tokio_tungstenite::tungstenite::Message;

    use super::*;
    use crate::ports::{AuthorizationOutcome, ExecutionOutcome};
    use crate::protocol::{
        AgentHelloAck, CommandRequest, ConnectionLimits, DeviceMessage, ErrorCode, MessageType,
        PROTOCOL_VERSION, TelechirError,
    };

    fn config(url: String) -> RealtimeClientConfig {
        RealtimeClientConfig {
            websocket_url: url,
            device_id: "device_test_agent".to_owned(),
            device_key_id: "key_test_agent".to_owned(),
            agent_version: "0.1.0".to_owned(),
            os: "windows".to_owned(),
            arch: "x86_64".to_owned(),
            capabilities: vec![],
            handshake_timeout: Duration::from_secs(2),
        }
    }

    struct DenyAll;

    impl CommandExecutor for DenyAll {
        type Error = Infallible;

        fn authorize(
            &mut self,
            _request: &CommandRequest,
            _session_id: Option<&str>,
        ) -> AuthorizationOutcome {
            AuthorizationOutcome::Deny(TelechirError {
                code: ErrorCode::PolicyDenied,
                message: "local policy denied the request".to_owned(),
                retryable: false,
                retry_after_ms: None,
                details: None,
            })
        }

        fn execute(&mut self, _request: &CommandRequest) -> Result<ExecutionOutcome, Self::Error> {
            panic!("denied request cannot execute");
        }
    }

    fn message(
        kind: MessageType,
        payload: serde_json::Value,
        sequence: u64,
        connection_id: Option<&str>,
    ) -> DeviceMessage {
        DeviceMessage {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            message_type: kind,
            message_id: format!("test_message_{sequence:04}"),
            correlation_id: None,
            device_id: "device_test_agent".to_owned(),
            session_id: None,
            connection_id: connection_id.map(str::to_owned),
            sequence,
            sent_at: Utc::now(),
            deadline_at: None,
            payload,
        }
    }

    #[test]
    fn credentials_never_debug_or_accept_invalid_material() {
        let secret = "sensitive_mock_credential_for_ci".to_owned();
        let c = SessionCredentials::new(secret.clone(), "abcdefghABCDEFGH".to_owned()).unwrap();
        assert!(!format!("{c:?}").contains(&secret));
        assert!(SessionCredentials::new("".to_owned(), "abcdefghijklmnop".to_owned()).is_err());
        assert!(
            SessionCredentials::new("x\nBearer admin".to_owned(), "abcdefghijklmnop".to_owned())
                .is_err()
        );
        assert!(SessionCredentials::new(secret, "bad".to_owned()).is_err());
    }

    #[tokio::test]
    async fn external_plaintext_ws_is_rejected_before_connection_attempt() {
        let credentials =
            SessionCredentials::new("synthetic_token".to_owned(), "abcdefghijklmnop".to_owned())
                .unwrap();
        let mut executor = DenyAll;
        let result = run_authenticated_session(
            config("ws://example.org:8988/realtime".to_owned()),
            credentials,
            &mut executor,
            std::future::pending(),
        )
        .await;
        assert_eq!(result, Err(SessionError::InvalidConfiguration));
    }

    #[tokio::test]
    async fn local_loopback_handshake_denies_command_and_stops_gracefully() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let credentials = SessionCredentials::new(
            "local_ephemeral_mock_only".to_owned(),
            "abcdefghijklmnop".to_owned(),
        )
        .unwrap();
        let client = tokio::spawn(async move {
            let mut executor = DenyAll;
            run_authenticated_session(
                config(format!("ws://127.0.0.1:{port}/realtime")),
                credentials,
                &mut executor,
                sleep(Duration::from_millis(500)),
            )
            .await
        });

        let (stream, _) = timeout(Duration::from_secs(2), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        let hello = timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let hello: DeviceMessage = serde_json::from_str(hello.to_text().unwrap()).unwrap();
        assert_eq!(hello.message_type, MessageType::AgentHello);
        assert_eq!(hello.connection_id, None);

        let ack = AgentHelloAck {
            connection_id: "connection_test_0001".to_owned(),
            selected_protocol_version: PROTOCOL_VERSION.to_owned(),
            server_time: Utc::now(),
            heartbeat_interval_seconds: 5,
            limits: ConnectionLimits::default(),
            policy_revision: None,
        };
        let hello_ack = message(
            MessageType::AgentHelloAck,
            to_value(ack).unwrap(),
            1,
            Some("connection_test_0001"),
        );
        socket
            .send(Message::Text(serde_json::to_string(&hello_ack).unwrap().into()))
            .await
            .unwrap();

        let denied_command = message(
            MessageType::CommandRequest,
            to_value(CommandRequest::test_read_only()).unwrap(),
            2,
            Some("connection_test_0001"),
        );
        socket
            .send(Message::Text(
                serde_json::to_string(&denied_command).unwrap().into(),
            ))
            .await
            .unwrap();
        let denied = timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let denied: DeviceMessage = serde_json::from_str(denied.to_text().unwrap()).unwrap();
        assert_eq!(denied.message_type, MessageType::CommandFailed);
        assert_eq!(
            denied.payload.get("error").unwrap().get("code").unwrap(),
            "POLICY_DENIED"
        );
        assert_eq!(
            timeout(Duration::from_secs(2), client).await.unwrap().unwrap(),
            Ok(SessionExit::StoppedByHost)
        );
    }
}
