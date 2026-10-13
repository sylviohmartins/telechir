//! Explicit opt-in foreground host. No remote authority is enabled by default.
//! Until G1-C local policy/approvals are operational, ALL inbound tools are denied.
use std::convert::Infallible;

use chrono::Utc;
use thiserror::Error;
use tokio::time::sleep;
use url::Url;

use crate::config::AgentConfig;
use crate::identity::{DeviceIdentityManager, DevicePairingMetadata, NativeKeyringIdentityStore};
use crate::ports::{AuthorizationOutcome, CommandExecutor, ExecutionOutcome};
use crate::protocol::{CommandRequest, ErrorCode, TelechirError};
use crate::provisioning::{AgentMetadata, PairingProgress, advance_pairing, begin_pairing, prepare_connection};
use crate::provisioning_http::{ProvisionError, ProvisioningHttp};
use crate::provisioning_store::NativeKeyringDeviceBindingStore;
use crate::realtime::ReconnectController;
use crate::runtime::{SessionError, SessionExit, run_authenticated_session};

const MAX_RECONNECTS: usize = 3;

/// All connection and pairing commands require an explicit CLI verb and an
/// explicit origin. Simply invoking the executable must never touch keyring
/// state or start networking.
#[derive(Debug, PartialEq, Eq)]
pub enum HostAction {
    CoreInfo,
    Help,
    PairStart { origin: Url, display_name: String },
    PairCheck { origin: Url, pairing_id: String },
    Serve { origin: Url },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HostError {
    #[error("invalid Agent command; use --help to see explicit operations")]
    InvalidArguments,
    #[error("Agent remote operations require all sensitive features disabled")]
    UnsafeConfiguration,
    #[error("Agent secure keyring is unavailable")]
    KeyringUnavailable,
    #[error("Agent pairing or credential provisioning was refused")]
    Provisioning(#[from] ProvisionError),
    #[error("Agent realtime connection ended or was refused")]
    Session(#[from] SessionError),
}

impl HostAction {
    pub fn parse(args: &[String]) -> Result<Self, HostError> {
        let parsed = match args {
            [] => Self::CoreInfo,
            [flag] if flag == "--help" || flag == "-h" => Self::Help,
            [verb, url, name] if verb == "pair-start" => Self::PairStart {
                origin: parse_origin(url)?,
                display_name: name.clone(),
            },
            [verb, url, pairing_id] if verb == "pair-check" => Self::PairCheck {
                origin: parse_origin(url)?,
                pairing_id: pairing_id.clone(),
            },
            [verb, url] if verb == "serve" => Self::Serve {
                origin: parse_origin(url)?,
            },
            _ => return Err(HostError::InvalidArguments),
        };
        Ok(parsed)
    }
}

fn parse_origin(raw: &str) -> Result<Url, HostError> {
    let origin = Url::parse(raw).map_err(|_| HostError::InvalidArguments)?;
    // The HTTPS adapter validates all authority, redirects, and loopback rules.
    ProvisioningHttp::new(origin.clone()).map_err(HostError::Provisioning)?;
    Ok(origin)
}

fn safe_operational_config(config: &AgentConfig) -> Result<(), HostError> {
    if config.sandbox_enabled()
        || config.computer_screen_enabled
        || config.computer_input_enabled
        || config.browser_configured()
    {
        return Err(HostError::UnsafeConfiguration);
    }
    Ok(())
}

fn metadata() -> AgentMetadata {
    AgentMetadata {
        agent_version: env!("CARGO_PKG_VERSION").to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        // G1-C will gate optional capabilities; no permissions in G1-B.
        capabilities: vec![],
    }
}

fn deny_request() -> TelechirError {
    TelechirError {
        code: ErrorCode::PolicyDenied,
        message: "remote operations are disabled until G1-C policy approval is complete"
            .to_owned(),
        retryable: false,
        retry_after_ms: None,
        details: None,
    }
}

/// Hard deny: no filesystem, shell, screen, browser, git or input side effect.
/// Even an accidental execution bypass returns the same refusal.
pub struct DenyAllHostExecutor;

impl CommandExecutor for DenyAllHostExecutor {
    type Error = Infallible;

    fn authorize(
        &mut self,
        _request: &CommandRequest,
        _session_id: Option<&str>,
    ) -> AuthorizationOutcome {
        AuthorizationOutcome::Deny(deny_request())
    }

    fn execute(&mut self, _request: &CommandRequest) -> Result<ExecutionOutcome, Self::Error> {
        Ok(ExecutionOutcome::Failed(deny_request()))
    }
}

/// One explicitly invoked CLI operation; provisioning and session never run
/// merely because a user launches telechir-agent without arguments.
pub async fn run_host_action(
    action: HostAction,
    config: &AgentConfig,
) -> Result<(), HostError> {
    match action {
        HostAction::CoreInfo => {
            println!(
                "telechir-agent {} core ready (protocol {}, sandbox={}, screen={}, input={}, browser={})",
                env!("CARGO_PKG_VERSION"),
                config.protocol_version,
                if config.sandbox_enabled() { "docker" } else { "disabled" },
                if config.computer_screen_enabled { "enabled" } else { "disabled" },
                if config.computer_input_enabled { "enabled" } else { "disabled" },
                if config.browser_configured() { "configured" } else { "disabled" },
            );
            Ok(())
        }
        HostAction::Help => {
            println!("telechir-agent (no args): local core status only; no remote connection");
            println!("telechir-agent pair-start <https-origin> <display-name>");
            println!("telechir-agent pair-check <https-origin> <pairing-id>");
            println!("telechir-agent serve <https-origin>   (foreground, deny-all until G1-C)");
            Ok(())
        }
        operation => {
            safe_operational_config(config)?;
            let identity = DeviceIdentityManager::new(
                NativeKeyringIdentityStore::new().map_err(|_| HostError::KeyringUnavailable)?,
            );
            let binding = NativeKeyringDeviceBindingStore::new()
                .map_err(|_| HostError::KeyringUnavailable)?;
            let origin = match &operation {
                HostAction::PairStart { origin, .. }
                | HostAction::PairCheck { origin, .. }
                | HostAction::Serve { origin } => origin.clone(),
                _ => unreachable!("matched only operational commands"),
            };
            let api = ProvisioningHttp::new(origin.clone())?;
            match operation {
                HostAction::PairStart { display_name, .. } => {
                    let meta = DevicePairingMetadata {
                        display_name,
                        os: std::env::consts::OS.to_owned(),
                        arch: std::env::consts::ARCH.to_owned(),
                        agent_version: env!("CARGO_PKG_VERSION").to_owned(),
                    };
                    let result = begin_pairing(&identity, &binding, &api, meta).await?;
                    // Verification URL and code are intentionally shown ONLY
                    // to an interactive user who explicitly started pairing.
                    println!("STATE=WAITING_FOR_USER");
                    println!("verification_uri={}", result.verification_uri);
                    println!("user_code={}", result.user_code);
                    println!("pairing_id={}", result.pairing_id);
                    println!("expires_at={}", result.expires_at.to_rfc3339());
                    Ok(())
                }
                HostAction::PairCheck { pairing_id, .. } => {
                    match advance_pairing(&identity, &binding, &api, &pairing_id).await? {
                        PairingProgress::WaitingForUser => println!("STATE=WAITING_FOR_USER"),
                        PairingProgress::Active(_) => println!("STATE=PAIRED"),
                        PairingProgress::Expired => println!("STATE=EXPIRED"),
                        PairingProgress::Revoked => println!("STATE=REVOKED"),
                    }
                    Ok(())
                }
                HostAction::Serve { .. } => {
                    // Foreground CTRL+C only; no scheduled task, autostart,
                    // service installation, background job or user login.
                    let shutdown = async {
                        let _ = tokio::signal::ctrl_c().await;
                    };
                    serve_foreground(&identity, &binding, &api, &origin, shutdown).await
                }
                _ => unreachable!("matched operational commands"),
            }
        }
    }
}

/// Session supervisor for a provisioned device. Every new attempt obtains a
/// FRESH signed short-lived token and nonce. Bounded retries cannot replay
/// commands and never bypass an expired/revoked/denied pairing.
pub async fn serve_foreground<S, B, A, F>(
    identity: &DeviceIdentityManager<S>,
    binding: &B,
    api: &A,
    origin: &Url,
    shutdown: F,
) -> Result<(), HostError>
where
    S: crate::identity::DeviceIdentityStore,
    B: crate::provisioning_store::DeviceBindingStore,
    A: crate::provisioning_http::ProvisioningApi,
    F: std::future::Future<Output = ()>,
{
    tokio::pin!(shutdown);
    let mut reconnect = ReconnectController::default();
    for attempt in 0..=MAX_RECONNECTS {
        let prepared = tokio::select! {
            biased;
            () = shutdown.as_mut() => return Ok(()),
            result = prepare_connection(identity, binding, api, origin, metadata(), Utc::now()) =>
                result?,
        };
        println!("STATE=CONNECTING");
        let mut executor = DenyAllHostExecutor;
        let result = run_authenticated_session(
            prepared.config,
            prepared.credentials,
            &mut executor,
            shutdown.as_mut(),
        )
        .await;
        match result {
            Ok(SessionExit::StoppedByHost) => {
                println!("STATE=STOPPED");
                return Ok(());
            }
            Err(error @ (SessionError::InvalidConfiguration | SessionError::NotProvisioned)) => {
                return Err(HostError::Session(error));
            }
            Err(error) if attempt == MAX_RECONNECTS => return Err(HostError::Session(error)),
            Err(_) => {
                println!("STATE=RECONNECTING");
                tokio::select! {
                    biased;
                    () = shutdown.as_mut() => return Ok(()),
                    () = sleep(reconnect.next_delay()) => {},
                }
            }
        }
    }
    unreachable!("bounded reconnect loop returns in all paths")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::MemoryIdentityStore;
    use crate::ports::AuthorizationOutcome;
    use crate::provisioning_store::{BindingError, DeviceBinding, DeviceBindingStore};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn operational_cli_never_activates_on_default_or_bad_arguments() {
        assert_eq!(HostAction::parse(&[]).unwrap(), HostAction::CoreInfo);
        assert_eq!(HostAction::parse(&["--help".into()]).unwrap(), HostAction::Help);
        assert!(HostAction::parse(&["serve".into()]).is_err());
        assert!(HostAction::parse(&["--serve".into()]).is_err());
        assert!(HostAction::parse(&["serve".into(), "http://external.example".into()]).is_err());
        assert!(HostAction::parse(&["pair-start".into(), "https://host.test".into()]).is_err());
        assert!(HostAction::parse(&["serve".into(), "https://u:p@host.test".into()]).is_err());
        assert!(matches!(
            HostAction::parse(&["serve".into(), "https://host.test".into()]),
            Ok(HostAction::Serve { .. }),
        ));
    }

    #[test]
    fn operational_host_rejects_sensitive_capabilities_and_denies_all_commands() {
        let mut config = AgentConfig::default();
        config.computer_input_enabled = true;
        assert_eq!(safe_operational_config(&config), Err(HostError::UnsafeConfiguration));
        assert_eq!(safe_operational_config(&AgentConfig::default()), Ok(()));

        let mut executor = DenyAllHostExecutor;
        let request = CommandRequest::test_read_only();
        assert!(matches!(
            executor.authorize(&request, None),
            AuthorizationOutcome::Deny(_)
        ));
        assert!(matches!(
            executor.execute(&request),
            Ok(ExecutionOutcome::Failed(_))
        ));
    }

    struct EmptyBinding;
    impl DeviceBindingStore for EmptyBinding {
        fn load(&self) -> Result<Option<DeviceBinding>, BindingError> { Ok(None) }
        fn save(&self, _: &DeviceBinding) -> Result<(), BindingError> {
            Err(BindingError::InvalidBinding)
        }
    }

    struct NeverCallApi(AtomicUsize);
    #[async_trait::async_trait]
    impl crate::provisioning_http::ProvisioningApi for NeverCallApi {
        async fn create_pairing(&self, _: &crate::identity::PairingRegistration)
            -> Result<crate::provisioning_http::PairingStart, ProvisionError>
        { self.0.fetch_add(1, Ordering::SeqCst); Err(ProvisionError::Unavailable) }
        async fn get_pairing(&self, _: &str, _: &str, _: &str)
            -> Result<crate::provisioning_http::PairingStatus, ProvisionError>
        { self.0.fetch_add(1, Ordering::SeqCst); Err(ProvisionError::Unavailable) }
        async fn prove_device(&self, _: &str, _: &crate::identity::PairingProof)
            -> Result<crate::provisioning_http::PairingActivation, ProvisionError>
        { self.0.fetch_add(1, Ordering::SeqCst); Err(ProvisionError::Unavailable) }
        async fn issue_credential(&self, _: &str, _: &crate::identity::ConnectionCredentialProof)
            -> Result<crate::provisioning_http::CredentialResponse, ProvisionError>
        { self.0.fetch_add(1, Ordering::SeqCst); Err(ProvisionError::Unavailable) }
    }

    #[tokio::test]
    async fn operational_host_missing_identity_fails_without_any_network_request() {
        let identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
        let api = NeverCallApi(AtomicUsize::new(0));
        let origin = Url::parse("https://127.0.0.1:8988/").unwrap();
        let result = serve_foreground(&identity, &EmptyBinding, &api, &origin, std::future::pending()).await;
        assert_eq!(result, Err(HostError::Provisioning(ProvisionError::InvalidState)));
        assert_eq!(api.0.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn operational_host_shutdown_before_provisioning_causes_no_network() {
        let identity = DeviceIdentityManager::new(MemoryIdentityStore::default());
        let api = NeverCallApi(AtomicUsize::new(0));
        let origin = Url::parse("https://127.0.0.1:8988/").unwrap();
        let result = serve_foreground(&identity, &EmptyBinding, &api, &origin, async {}).await;
        assert_eq!(result, Ok(()));
        assert_eq!(api.0.load(Ordering::SeqCst), 0);
    }
}
