use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::protocol::{
    CommandOperation, CommandRequest, ErrorCode, PermissionDomain, TelechirError,
};

pub const BROWSER_ADAPTER_CAPABILITY: &str = "browser.playwright";
pub const BROWSER_CAPABILITIES: [&str; 6] = [
    "browser.session",
    "browser.snapshot",
    "browser.navigate",
    "browser.click",
    "browser.fill",
    BROWSER_ADAPTER_CAPABILITY,
];

const MAX_BROWSER_SESSION_ID_CHARS: usize = 96;
const MAX_LOCATOR_VALUE_CHARS: usize = 256;
const MAX_FILL_TEXT_CHARS: usize = 2_000;
const MAX_BROWSER_RESULT_BYTES: usize = 128 * 1024;
const MIN_BROWSER_TIMEOUT_MS: u64 = 1_000;
const MAX_BROWSER_TIMEOUT_MS: u64 = 60_000;
const MIN_BROWSER_SESSION_TTL_SECONDS: u64 = 30;
const MAX_BROWSER_SESSION_TTL_SECONDS: u64 = 3_600;
const MAX_BROWSER_SESSIONS_LIMIT: u16 = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserConfig {
    pub node_binary: PathBuf,
    pub adapter_script: PathBuf,
    pub request_timeout_ms: u64,
    pub session_ttl_seconds: u64,
    pub max_sessions: u16,
}

impl BrowserConfig {
    pub fn new(node_binary: PathBuf, adapter_script: PathBuf) -> Self {
        Self {
            node_binary,
            adapter_script,
            request_timeout_ms: 15_000,
            session_ttl_seconds: 900,
            max_sessions: 2,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.node_binary.is_file() {
            return Err("browser node binary must reference an existing file".to_owned());
        }
        if !self.adapter_script.is_file() {
            return Err("browser adapter script must reference an existing file".to_owned());
        }
        if !(MIN_BROWSER_TIMEOUT_MS..=MAX_BROWSER_TIMEOUT_MS).contains(&self.request_timeout_ms) {
            return Err(format!(
                "browser request timeout must be between {MIN_BROWSER_TIMEOUT_MS} and {MAX_BROWSER_TIMEOUT_MS} ms"
            ));
        }
        if !(MIN_BROWSER_SESSION_TTL_SECONDS..=MAX_BROWSER_SESSION_TTL_SECONDS)
            .contains(&self.session_ttl_seconds)
        {
            return Err(format!(
                "browser session TTL must be between {MIN_BROWSER_SESSION_TTL_SECONDS} and {MAX_BROWSER_SESSION_TTL_SECONDS} seconds"
            ));
        }
        if !(1..=MAX_BROWSER_SESSIONS_LIMIT).contains(&self.max_sessions) {
            return Err(format!(
                "browser max sessions must be between 1 and {MAX_BROWSER_SESSIONS_LIMIT}"
            ));
        }
        Ok(())
    }
}

pub trait BrowserPlatform: Send + Sync {
    fn execute(
        &self,
        operation: CommandOperation,
        arguments: &Map<String, Value>,
    ) -> Result<Value, TelechirError>;
}

pub struct BrowserExecutor {
    platform: Option<Box<dyn BrowserPlatform>>,
}

impl Default for BrowserExecutor {
    fn default() -> Self {
        Self::disabled()
    }
}

impl BrowserExecutor {
    pub fn disabled() -> Self {
        Self { platform: None }
    }

    pub fn from_config(config: Option<&BrowserConfig>) -> Result<Self, TelechirError> {
        let Some(config) = config else {
            return Ok(Self::disabled());
        };
        config
            .validate()
            .map_err(|message| error(ErrorCode::InvalidArgument, message))?;
        let platform = PlaywrightBrowserPlatform::new(config)?;
        Ok(Self {
            platform: Some(Box::new(platform)),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_test_platform(platform: Box<dyn BrowserPlatform>) -> Self {
        Self {
            platform: Some(platform),
        }
    }

    pub fn enabled(&self) -> bool {
        self.platform.is_some()
    }

    pub fn augment_capabilities(&self, capabilities: &mut Vec<String>) {
        if !self.enabled() {
            return;
        }
        for capability in BROWSER_CAPABILITIES {
            if !capabilities.iter().any(|value| value == capability) {
                capabilities.push(capability.to_owned());
            }
        }
        for operation in browser_operations() {
            let capability = operation.as_str();
            if !capabilities.iter().any(|value| value == capability) {
                capabilities.push(capability.to_owned());
            }
        }
    }

    pub fn preflight(&self, request: &CommandRequest) -> Result<(), TelechirError> {
        if !is_browser_operation(request.operation) {
            return Ok(());
        }
        self.platform()?;
        require_exact_browser_permission(request)?;
        validate_browser_arguments(request)
    }

    pub fn execute(&self, request: &CommandRequest) -> Result<Value, TelechirError> {
        if !is_browser_operation(request.operation) {
            return Err(error(
                ErrorCode::UnsupportedCapability,
                "operation is not a browser operation",
            ));
        }
        self.preflight(request)?;
        let value = self
            .platform()?
            .execute(request.operation, &request.arguments)?;
        let encoded = serde_json::to_vec(&value).map_err(|_| {
            error(
                ErrorCode::InternalError,
                "browser adapter result could not be serialized",
            )
        })?;
        if encoded.len() > MAX_BROWSER_RESULT_BYTES {
            return Err(error(
                ErrorCode::OutputTruncated,
                "browser adapter result exceeds the bounded result budget",
            ));
        }
        Ok(value)
    }

    fn platform(&self) -> Result<&dyn BrowserPlatform, TelechirError> {
        self.platform.as_deref().ok_or_else(|| {
            error(
                ErrorCode::UnsupportedCapability,
                "browser automation is disabled or the local adapter is unavailable",
            )
        })
    }
}

struct PlaywrightBrowserPlatform {
    state: Mutex<SidecarState>,
    timeout: Duration,
}

struct SidecarState {
    child: Child,
    stdin: ChildStdin,
    responses: mpsc::Receiver<String>,
    dead: bool,
}

#[derive(Debug, Deserialize)]
struct SidecarResponse {
    id: String,
    ok: bool,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    error: Option<SidecarError>,
}

#[derive(Debug, Deserialize)]
struct SidecarError {
    code: String,
    message: String,
}

impl PlaywrightBrowserPlatform {
    fn new(config: &BrowserConfig) -> Result<Self, TelechirError> {
        let mut child = Command::new(&config.node_binary)
            .arg(&config.adapter_script)
            .arg("--stdio")
            .arg("--session-ttl-seconds")
            .arg(config.session_ttl_seconds.to_string())
            .arg("--max-sessions")
            .arg(config.max_sessions.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("NODE_OPTIONS")
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("ALL_PROXY")
            .env_remove("NO_PROXY")
            .env_remove("TELECHIR_BROWSER_TEST_ALLOW_LOOPBACK")
            .spawn()
            .map_err(|_| {
                error(
                    ErrorCode::UnsupportedCapability,
                    "Playwright browser adapter process could not be started",
                )
            })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            error(
                ErrorCode::InternalError,
                "browser adapter stdin is unavailable",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            error(
                ErrorCode::InternalError,
                "browser adapter stdout is unavailable",
            )
        })?;
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("telechir-browser-sidecar-reader".to_owned())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    match line {
                        Ok(line) => {
                            if sender.send(line).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|_| {
                error(
                    ErrorCode::InternalError,
                    "browser adapter response reader could not start",
                )
            })?;

        let platform = Self {
            state: Mutex::new(SidecarState {
                child,
                stdin,
                responses: receiver,
                dead: false,
            }),
            timeout: Duration::from_millis(config.request_timeout_ms),
        };
        let health = platform.call("health", &Map::new())?;
        if health.get("adapter").and_then(Value::as_str) != Some("playwright")
            || health.get("ready").and_then(Value::as_bool) != Some(true)
        {
            return Err(error(
                ErrorCode::UnsupportedCapability,
                "Playwright browser adapter health check did not report ready",
            ));
        }
        Ok(platform)
    }

    fn call(
        &self,
        operation: &str,
        arguments: &Map<String, Value>,
    ) -> Result<Value, TelechirError> {
        let request_id = format!("browser_{}", Uuid::new_v4().simple());
        let request = json!({
            "id": request_id,
            "operation": operation,
            "arguments": arguments
        });
        let encoded = serde_json::to_string(&request).map_err(|_| {
            error(
                ErrorCode::InternalError,
                "browser adapter request could not be serialized",
            )
        })?;

        let mut state = self.state.lock().map_err(|_| {
            error(
                ErrorCode::InternalError,
                "browser adapter process lock is poisoned",
            )
        })?;
        if state.dead {
            return Err(error(
                ErrorCode::UnsupportedCapability,
                "browser adapter process is no longer available",
            ));
        }
        if state.stdin.write_all(encoded.as_bytes()).is_err()
            || state.stdin.write_all(b"\n").is_err()
            || state.stdin.flush().is_err()
        {
            terminate_sidecar(&mut state);
            return Err(error(
                ErrorCode::UnsupportedCapability,
                "browser adapter process stopped accepting requests",
            ));
        }

        let line = match state.responses.recv_timeout(self.timeout) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                terminate_sidecar(&mut state);
                return Err(error(
                    ErrorCode::Timeout,
                    "browser adapter request exceeded its local timeout",
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                terminate_sidecar(&mut state);
                return Err(error(
                    ErrorCode::UnsupportedCapability,
                    "browser adapter process terminated unexpectedly",
                ));
            }
        };
        let response: SidecarResponse = serde_json::from_str(&line).map_err(|_| {
            terminate_sidecar(&mut state);
            error(
                ErrorCode::InternalError,
                "browser adapter returned an invalid response frame",
            )
        })?;
        if response.id != request_id {
            terminate_sidecar(&mut state);
            return Err(error(
                ErrorCode::Conflict,
                "browser adapter response correlation changed unexpectedly",
            ));
        }
        if response.ok {
            return Ok(response.data.unwrap_or(Value::Null));
        }
        let sidecar_error = response.error.unwrap_or(SidecarError {
            code: "INTERNAL_ERROR".to_owned(),
            message: "browser adapter operation failed".to_owned(),
        });
        Err(error(
            map_sidecar_error(&sidecar_error.code),
            sanitize_sidecar_message(&sidecar_error.message),
        ))
    }
}

impl BrowserPlatform for PlaywrightBrowserPlatform {
    fn execute(
        &self,
        operation: CommandOperation,
        arguments: &Map<String, Value>,
    ) -> Result<Value, TelechirError> {
        self.call(operation.as_str(), arguments)
    }
}

impl Drop for PlaywrightBrowserPlatform {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            terminate_sidecar(&mut state);
        }
    }
}

fn terminate_sidecar(state: &mut SidecarState) {
    if state.dead {
        return;
    }
    state.dead = true;
    let _ = state.child.kill();
    let _ = state.child.wait();
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserSessionReference {
    browser_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserNavigateInput {
    browser_session_id: String,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserClickInput {
    browser_session_id: String,
    locator: BrowserLocator,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserFillInput {
    browser_session_id: String,
    locator: BrowserLocator,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum BrowserLocator {
    Role {
        role: String,
        name: String,
        #[serde(default)]
        exact: bool,
        #[serde(default)]
        index: Option<u8>,
    },
    Label {
        value: String,
        #[serde(default)]
        exact: bool,
        #[serde(default)]
        index: Option<u8>,
    },
    Text {
        value: String,
        #[serde(default)]
        exact: bool,
        #[serde(default)]
        index: Option<u8>,
    },
    Placeholder {
        value: String,
        #[serde(default)]
        exact: bool,
        #[serde(default)]
        index: Option<u8>,
    },
    TestId {
        value: String,
        #[serde(default)]
        index: Option<u8>,
    },
}

fn validate_browser_arguments(request: &CommandRequest) -> Result<(), TelechirError> {
    match request.operation {
        CommandOperation::BrowserSessionOpen => {
            if !request.arguments.is_empty() {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    "open_browser_session does not accept adapter arguments",
                ));
            }
            Ok(())
        }
        CommandOperation::BrowserSnapshot | CommandOperation::BrowserSessionClose => {
            let input: BrowserSessionReference = parse_arguments(request)?;
            validate_session_id(&input.browser_session_id)
        }
        CommandOperation::BrowserNavigate => {
            let input: BrowserNavigateInput = parse_arguments(request)?;
            validate_session_id(&input.browser_session_id)?;
            validate_navigation_url(&input.url)
        }
        CommandOperation::BrowserClick => {
            let input: BrowserClickInput = parse_arguments(request)?;
            validate_session_id(&input.browser_session_id)?;
            validate_locator(&input.locator)
        }
        CommandOperation::BrowserFill => {
            let input: BrowserFillInput = parse_arguments(request)?;
            validate_session_id(&input.browser_session_id)?;
            validate_locator(&input.locator)?;
            validate_bounded_text("fill text", &input.text, MAX_FILL_TEXT_CHARS)
        }
        _ => Ok(()),
    }
}

fn validate_session_id(value: &str) -> Result<(), TelechirError> {
    let count = value.chars().count();
    if !(8..=MAX_BROWSER_SESSION_ID_CHARS).contains(&count)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(error(
            ErrorCode::InvalidArgument,
            "browser_session_id must be a bounded opaque identifier",
        ));
    }
    Ok(())
}

fn validate_navigation_url(value: &str) -> Result<(), TelechirError> {
    let parsed = url::Url::parse(value).map_err(|_| {
        error(
            ErrorCode::InvalidArgument,
            "browser navigation requires an absolute http(s) URL",
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(error(
            ErrorCode::PolicyDenied,
            "browser navigation allows only http and https URLs",
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(error(
            ErrorCode::PolicyDenied,
            "browser navigation forbids credentials embedded in URLs",
        ));
    }
    if parsed.host_str().is_none() {
        return Err(error(
            ErrorCode::InvalidArgument,
            "browser navigation URL must include a host",
        ));
    }
    Ok(())
}

fn validate_locator(locator: &BrowserLocator) -> Result<(), TelechirError> {
    match locator {
        BrowserLocator::Role {
            role,
            name,
            exact,
            index,
        } => {
            let _ = exact;
            const ROLES: &[&str] = &[
                "button",
                "link",
                "textbox",
                "checkbox",
                "radio",
                "combobox",
                "option",
                "menuitem",
                "tab",
                "heading",
                "listitem",
                "row",
                "cell",
                "switch",
                "slider",
                "spinbutton",
            ];
            if !ROLES.contains(&role.as_str()) {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    "browser role locator is outside the Phase 14 role allowlist",
                ));
            }
            validate_bounded_text("locator name", name, MAX_LOCATOR_VALUE_CHARS)?;
            validate_locator_index(*index)
        }
        BrowserLocator::Label {
            value,
            exact,
            index,
        }
        | BrowserLocator::Text {
            value,
            exact,
            index,
        }
        | BrowserLocator::Placeholder {
            value,
            exact,
            index,
        } => {
            let _ = exact;
            validate_bounded_text("locator value", value, MAX_LOCATOR_VALUE_CHARS)?;
            validate_locator_index(*index)
        }
        BrowserLocator::TestId { value, index } => {
            validate_bounded_text("test id", value, MAX_LOCATOR_VALUE_CHARS)?;
            validate_locator_index(*index)
        }
    }
}

fn validate_locator_index(index: Option<u8>) -> Result<(), TelechirError> {
    if index.is_some_and(|value| value > 9) {
        return Err(error(
            ErrorCode::InvalidArgument,
            "browser locator index must be between 0 and 9",
        ));
    }
    Ok(())
}

fn validate_bounded_text(field: &str, value: &str, max: usize) -> Result<(), TelechirError> {
    let count = value.chars().count();
    if count == 0 || count > max || value.chars().any(|character| character.is_control()) {
        return Err(error(
            ErrorCode::InvalidArgument,
            format!("{field} must contain 1..={max} non-control characters"),
        ));
    }
    Ok(())
}

fn require_exact_browser_permission(request: &CommandRequest) -> Result<(), TelechirError> {
    if request.requested_permissions.as_slice() != [PermissionDomain::Browser] {
        return Err(error(
            ErrorCode::PolicyDenied,
            "browser operations require exactly permission BROWSER",
        ));
    }
    Ok(())
}

fn parse_arguments<T>(request: &CommandRequest) -> Result<T, TelechirError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(Value::Object(request.arguments.clone())).map_err(|_| {
        error(
            ErrorCode::InvalidArgument,
            "browser arguments do not match the typed Phase 14 contract",
        )
    })
}

pub const fn is_browser_operation(operation: CommandOperation) -> bool {
    matches!(
        operation,
        CommandOperation::BrowserSessionOpen
            | CommandOperation::BrowserSnapshot
            | CommandOperation::BrowserNavigate
            | CommandOperation::BrowserClick
            | CommandOperation::BrowserFill
            | CommandOperation::BrowserSessionClose
    )
}

pub const fn browser_operations() -> [CommandOperation; 6] {
    [
        CommandOperation::BrowserSessionOpen,
        CommandOperation::BrowserSnapshot,
        CommandOperation::BrowserNavigate,
        CommandOperation::BrowserClick,
        CommandOperation::BrowserFill,
        CommandOperation::BrowserSessionClose,
    ]
}

fn map_sidecar_error(code: &str) -> ErrorCode {
    match code {
        "INVALID_ARGUMENT" => ErrorCode::InvalidArgument,
        "POLICY_DENIED" => ErrorCode::PolicyDenied,
        "NOT_FOUND" => ErrorCode::NotFound,
        "CONFLICT" => ErrorCode::Conflict,
        "TIMEOUT" => ErrorCode::Timeout,
        "DEADLINE_EXCEEDED" => ErrorCode::DeadlineExceeded,
        "OUTPUT_TRUNCATED" => ErrorCode::OutputTruncated,
        "RATE_LIMITED" => ErrorCode::RateLimited,
        "UNSUPPORTED_CAPABILITY" => ErrorCode::UnsupportedCapability,
        _ => ErrorCode::InternalError,
    }
}

fn sanitize_sidecar_message(message: &str) -> String {
    let mut clean = message
        .chars()
        .filter(|character| !character.is_control())
        .take(300)
        .collect::<String>();
    if clean.is_empty() {
        clean = "browser adapter operation failed".to_owned();
    }
    clean
}

fn error(code: ErrorCode, message: impl Into<String>) -> TelechirError {
    TelechirError {
        code,
        message: message.into(),
        retryable: matches!(code, ErrorCode::Timeout | ErrorCode::RateLimited),
        retry_after_ms: None,
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Arc;

    use super::*;
    use crate::protocol::RiskLevel;

    struct FakeBrowser {
        responses: Arc<Mutex<VecDeque<Value>>>,
    }

    impl BrowserPlatform for FakeBrowser {
        fn execute(
            &self,
            _operation: CommandOperation,
            _arguments: &Map<String, Value>,
        ) -> Result<Value, TelechirError> {
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| error(ErrorCode::InternalError, "missing fake response"))
        }
    }

    fn request(operation: CommandOperation, arguments: Value) -> CommandRequest {
        CommandRequest {
            command_id: "cmd_phase14_browser".to_owned(),
            idempotency_key: operation
                .has_side_effect()
                .then(|| "idem_phase14_browser".to_owned()),
            operation,
            arguments: arguments.as_object().unwrap().clone(),
            requested_permissions: vec![PermissionDomain::Browser],
            risk: RiskLevel::High,
            workspace_id: None,
            approval_id: None,
        }
    }

    #[test]
    fn browser_contract_rejects_raw_selectors_scripts_and_credentials_in_urls() {
        let executor = BrowserExecutor::with_test_platform(Box::new(FakeBrowser {
            responses: Arc::new(Mutex::new(VecDeque::new())),
        }));

        let raw_selector = request(
            CommandOperation::BrowserClick,
            json!({
                "browser_session_id":"browser_12345678",
                "locator":{"kind":"css","value":"#danger"}
            }),
        );
        assert_eq!(
            executor.preflight(&raw_selector).unwrap_err().code,
            ErrorCode::InvalidArgument
        );

        let credential_url = request(
            CommandOperation::BrowserNavigate,
            json!({
                "browser_session_id":"browser_12345678",
                "url":"https://user:secret@example.com/"
            }),
        );
        assert_eq!(
            executor.preflight(&credential_url).unwrap_err().code,
            ErrorCode::PolicyDenied
        );
    }

    #[test]
    fn browser_permission_is_exact_and_separate_from_input_control() {
        let executor = BrowserExecutor::with_test_platform(Box::new(FakeBrowser {
            responses: Arc::new(Mutex::new(VecDeque::new())),
        }));
        let mut wrong = request(CommandOperation::BrowserSessionOpen, json!({}));
        wrong.requested_permissions = vec![PermissionDomain::InputControl];
        assert_eq!(
            executor.preflight(&wrong).unwrap_err().code,
            ErrorCode::PolicyDenied
        );
    }

    #[test]
    fn typed_locator_and_fill_are_bounded_before_adapter_execution() {
        let responses = Arc::new(Mutex::new(VecDeque::from([json!({
            "accepted":true,
            "browser_session_id":"browser_12345678"
        })])));
        let executor = BrowserExecutor::with_test_platform(Box::new(FakeBrowser { responses }));

        let valid = request(
            CommandOperation::BrowserFill,
            json!({
                "browser_session_id":"browser_12345678",
                "locator":{"kind":"label","value":"Email","exact":true},
                "text":"person@example.com"
            }),
        );
        assert_eq!(executor.execute(&valid).unwrap()["accepted"], true);

        let oversized = request(
            CommandOperation::BrowserFill,
            json!({
                "browser_session_id":"browser_12345678",
                "locator":{"kind":"label","value":"Email"},
                "text":"x".repeat(MAX_FILL_TEXT_CHARS + 1)
            }),
        );
        assert_eq!(
            executor.preflight(&oversized).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn snapshot_result_is_bounded() {
        let responses = Arc::new(Mutex::new(VecDeque::from([json!({
            "browser_session_id":"browser_12345678",
            "url":"https://example.com/",
            "title":"Example",
            "snapshot":"x".repeat(MAX_BROWSER_RESULT_BYTES + 1),
            "captured_at":"2026-10-06T00:00:00Z",
            "untrusted":true,
            "truncated":false
        })])));
        let executor = BrowserExecutor::with_test_platform(Box::new(FakeBrowser { responses }));
        let snapshot = request(
            CommandOperation::BrowserSnapshot,
            json!({"browser_session_id":"browser_12345678"}),
        );
        assert_eq!(
            executor.execute(&snapshot).unwrap_err().code,
            ErrorCode::OutputTruncated
        );
    }

    #[test]
    fn disabled_browser_fails_closed() {
        let executor = BrowserExecutor::disabled();
        let open = request(CommandOperation::BrowserSessionOpen, json!({}));
        assert_eq!(
            executor.preflight(&open).unwrap_err().code,
            ErrorCode::UnsupportedCapability
        );
    }
}
