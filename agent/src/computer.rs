use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::policy::command_argument_digest;
use crate::protocol::{
    CommandOperation, CommandRequest, ErrorCode, PermissionDomain, TelechirError,
};

pub const SCREEN_CAPTURE_CAPABILITY: &str = "computer.screen.capture";
pub const INPUT_CONTROL_CAPABILITY: &str = "computer.input";
pub const DEFAULT_CAPTURE_MAX_WIDTH: u32 = 256;
pub const DEFAULT_CAPTURE_MAX_HEIGHT: u32 = 144;
pub const MAX_CAPTURE_WIDTH: u32 = 320;
pub const MAX_CAPTURE_HEIGHT: u32 = 240;
pub const MAX_CAPTURE_BINARY_BYTES: usize = 180 * 1024;
pub const MAX_TYPE_TEXT_CHARS: usize = 2_000;
pub const LOCAL_CONFIRMATION_TIMEOUT_SECONDS: u32 = 30;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureScreenInput {
    #[serde(default = "default_capture_width")]
    max_width: u32,
    #[serde(default = "default_capture_height")]
    max_height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ComputerInput {
    action: ComputerAction,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComputerAction {
    MovePointer {
        x: i32,
        y: i32,
    },
    Click {
        x: i32,
        y: i32,
        button: MouseButton,
        #[serde(default = "default_click_count")]
        click_count: u8,
    },
    Scroll {
        x: i32,
        y: i32,
        delta_y: i32,
    },
    Key {
        key: String,
        #[serde(default)]
        modifiers: Vec<KeyModifier>,
    },
    TypeText {
        text: String,
    },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyModifier {
    Ctrl,
    Alt,
    Shift,
    Meta,
}

#[derive(Debug)]
pub struct ScreenCapture {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub media_type: &'static str,
}

pub trait ComputerPlatform {
    fn capture_screen(
        &self,
        max_width: u32,
        max_height: u32,
        max_bytes: usize,
    ) -> Result<ScreenCapture, TelechirError>;

    fn confirm_critical_input(
        &self,
        action: &ComputerAction,
        argument_digest: &str,
        timeout_seconds: u32,
    ) -> Result<bool, TelechirError>;

    fn control(&self, action: &ComputerAction) -> Result<(), TelechirError>;
}

pub struct ComputerExecutor {
    platform: Option<Box<dyn ComputerPlatform>>,
    screen_enabled: bool,
    input_enabled: bool,
}

impl Default for ComputerExecutor {
    fn default() -> Self {
        Self::disabled()
    }
}

impl ComputerExecutor {
    pub fn disabled() -> Self {
        Self {
            platform: None,
            screen_enabled: false,
            input_enabled: false,
        }
    }

    pub fn from_config(screen_enabled: bool, input_enabled: bool) -> Result<Self, TelechirError> {
        if !screen_enabled && !input_enabled {
            return Ok(Self::disabled());
        }

        #[cfg(windows)]
        {
            Ok(Self {
                platform: Some(Box::new(windows::WindowsComputerPlatform::new()?)),
                screen_enabled,
                input_enabled,
            })
        }

        #[cfg(not(windows))]
        {
            let _ = (screen_enabled, input_enabled);
            Err(error(
                ErrorCode::UnsupportedCapability,
                "computer-use adapters are not implemented for this operating system",
            ))
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_platform(
        platform: Box<dyn ComputerPlatform>,
        screen_enabled: bool,
        input_enabled: bool,
    ) -> Self {
        Self {
            platform: Some(platform),
            screen_enabled,
            input_enabled,
        }
    }

    pub fn preflight(&self, request: &CommandRequest) -> Result<(), TelechirError> {
        match request.operation {
            CommandOperation::ScreenCapture => {
                self.require_screen()?;
                require_exact_permission(request, PermissionDomain::ScreenRead)?;
                let input: CaptureScreenInput = parse_arguments(request)?;
                validate_capture_input(&input)
            }
            CommandOperation::ComputerInput => {
                self.require_input()?;
                require_exact_permission(request, PermissionDomain::InputControl)?;
                let input: ComputerInput = parse_arguments(request)?;
                validate_action(&input.action)
            }
            _ => Ok(()),
        }
    }

    pub fn confirm_critical_input(&self, request: &CommandRequest) -> Result<bool, TelechirError> {
        self.require_input()?;
        require_exact_permission(request, PermissionDomain::InputControl)?;
        let input: ComputerInput = parse_arguments(request)?;
        validate_action(&input.action)?;
        let digest = command_argument_digest(request)?;
        self.platform()?.confirm_critical_input(
            &input.action,
            &digest,
            LOCAL_CONFIRMATION_TIMEOUT_SECONDS,
        )
    }

    pub fn execute(&self, request: &CommandRequest) -> Result<Value, TelechirError> {
        match request.operation {
            CommandOperation::ScreenCapture => {
                self.require_screen()?;
                require_exact_permission(request, PermissionDomain::ScreenRead)?;
                let input: CaptureScreenInput = parse_arguments(request)?;
                validate_capture_input(&input)?;
                let capture = self.platform()?.capture_screen(
                    input.max_width,
                    input.max_height,
                    MAX_CAPTURE_BINARY_BYTES,
                )?;
                if capture.bytes.len() > MAX_CAPTURE_BINARY_BYTES {
                    return Err(error(
                        ErrorCode::OutputTruncated,
                        "screen capture exceeds the bounded realtime result size",
                    ));
                }
                Ok(json!({
                    "media_type": capture.media_type,
                    "data_base64": STANDARD.encode(&capture.bytes),
                    "width": capture.width,
                    "height": capture.height,
                    "captured_at": Utc::now().to_rfc3339(),
                    "source": "virtual_desktop",
                    "untrusted": true
                }))
            }
            CommandOperation::ComputerInput => {
                self.require_input()?;
                require_exact_permission(request, PermissionDomain::InputControl)?;
                let input: ComputerInput = parse_arguments(request)?;
                validate_action(&input.action)?;
                self.platform()?.control(&input.action)?;
                Ok(json!({
                    "accepted": true,
                    "action": action_name(&input.action),
                    "completed_at": Utc::now().to_rfc3339()
                }))
            }
            _ => Err(error(
                ErrorCode::UnsupportedCapability,
                "operation is not a computer-use operation",
            )),
        }
    }

    fn require_screen(&self) -> Result<(), TelechirError> {
        if !self.screen_enabled {
            return Err(error(
                ErrorCode::UnsupportedCapability,
                "screen capture is disabled on this device",
            ));
        }
        self.platform().map(|_| ())
    }

    fn require_input(&self) -> Result<(), TelechirError> {
        if !self.input_enabled {
            return Err(error(
                ErrorCode::UnsupportedCapability,
                "computer input control is disabled on this device",
            ));
        }
        self.platform().map(|_| ())
    }

    fn platform(&self) -> Result<&dyn ComputerPlatform, TelechirError> {
        self.platform.as_deref().ok_or_else(|| {
            error(
                ErrorCode::UnsupportedCapability,
                "computer-use platform adapter is unavailable",
            )
        })
    }
}

fn default_capture_width() -> u32 {
    DEFAULT_CAPTURE_MAX_WIDTH
}

fn default_capture_height() -> u32 {
    DEFAULT_CAPTURE_MAX_HEIGHT
}

fn default_click_count() -> u8 {
    1
}

fn validate_capture_input(input: &CaptureScreenInput) -> Result<(), TelechirError> {
    if !(64..=MAX_CAPTURE_WIDTH).contains(&input.max_width)
        || !(64..=MAX_CAPTURE_HEIGHT).contains(&input.max_height)
    {
        return Err(error(
            ErrorCode::InvalidArgument,
            format!(
                "screen capture bounds must be width 64..={MAX_CAPTURE_WIDTH} and height 64..={MAX_CAPTURE_HEIGHT}"
            ),
        ));
    }
    Ok(())
}

fn validate_action(action: &ComputerAction) -> Result<(), TelechirError> {
    match action {
        ComputerAction::MovePointer { x, y } => validate_coordinate_envelope(*x, *y),
        ComputerAction::Click {
            x, y, click_count, ..
        } => {
            validate_coordinate_envelope(*x, *y)?;
            if !(1..=2).contains(click_count) {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    "click_count must be 1 or 2",
                ));
            }
            Ok(())
        }
        ComputerAction::Scroll { x, y, delta_y } => {
            validate_coordinate_envelope(*x, *y)?;
            if *delta_y == 0 || delta_y.unsigned_abs() > 1_200 {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    "scroll delta_y must be non-zero and within -1200..1200",
                ));
            }
            Ok(())
        }
        ComputerAction::Key { key, modifiers } => {
            validate_key_name(key)?;
            if modifiers.len() > 4 {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    "key modifiers cannot contain more than four entries",
                ));
            }
            let unique = modifiers
                .iter()
                .copied()
                .collect::<std::collections::HashSet<_>>();
            if unique.len() != modifiers.len() {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    "key modifiers must be unique",
                ));
            }
            Ok(())
        }
        ComputerAction::TypeText { text } => {
            let count = text.chars().count();
            if count == 0 || count > MAX_TYPE_TEXT_CHARS {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    format!("type_text must contain 1..={MAX_TYPE_TEXT_CHARS} characters"),
                ));
            }
            if text
                .chars()
                .any(|character| character == '\0' || character.is_control())
            {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    "type_text forbids control characters; use the typed key action instead",
                ));
            }
            Ok(())
        }
    }
}

fn validate_coordinate_envelope(x: i32, y: i32) -> Result<(), TelechirError> {
    const LIMIT: i32 = 100_000;
    if !(-LIMIT..=LIMIT).contains(&x) || !(-LIMIT..=LIMIT).contains(&y) {
        return Err(error(
            ErrorCode::InvalidArgument,
            "computer coordinates exceed the bounded validation envelope",
        ));
    }
    Ok(())
}

fn validate_key_name(key: &str) -> Result<(), TelechirError> {
    let normalized = key.trim().to_ascii_uppercase();
    let named = matches!(
        normalized.as_str(),
        "ENTER"
            | "TAB"
            | "ESCAPE"
            | "BACKSPACE"
            | "DELETE"
            | "SPACE"
            | "ARROWUP"
            | "ARROWDOWN"
            | "ARROWLEFT"
            | "ARROWRIGHT"
            | "HOME"
            | "END"
            | "PAGEUP"
            | "PAGEDOWN"
            | "F1"
            | "F2"
            | "F3"
            | "F4"
            | "F5"
            | "F6"
            | "F7"
            | "F8"
            | "F9"
            | "F10"
            | "F11"
            | "F12"
    );
    let single_ascii = normalized.len() == 1
        && normalized
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit());
    if !named && !single_ascii {
        return Err(error(
            ErrorCode::InvalidArgument,
            "key must be a bounded named key, A-Z, 0-9, or F1-F12",
        ));
    }
    Ok(())
}

fn require_exact_permission(
    request: &CommandRequest,
    required: PermissionDomain,
) -> Result<(), TelechirError> {
    if request.requested_permissions.as_slice() != [required] {
        return Err(error(
            ErrorCode::PolicyDenied,
            format!(
                "computer-use operation requires exactly permission {}",
                required.as_str()
            ),
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
            "computer-use arguments do not match the typed contract",
        )
    })
}

pub fn action_name(action: &ComputerAction) -> &'static str {
    match action {
        ComputerAction::MovePointer { .. } => "move_pointer",
        ComputerAction::Click { .. } => "click",
        ComputerAction::Scroll { .. } => "scroll",
        ComputerAction::Key { .. } => "key",
        ComputerAction::TypeText { .. } => "type_text",
    }
}

pub fn action_summary(action: &ComputerAction) -> String {
    match action {
        ComputerAction::MovePointer { x, y } => format!("Mover ponteiro para ({x}, {y})"),
        ComputerAction::Click {
            x,
            y,
            button,
            click_count,
        } => format!("Clique {:?} x{click_count} em ({x}, {y})", button),
        ComputerAction::Scroll { x, y, delta_y } => {
            format!("Scroll vertical {delta_y} em ({x}, {y})")
        }
        ComputerAction::Key { key, modifiers } => {
            format!("Tecla {key} com modificadores {modifiers:?}")
        }
        ComputerAction::TypeText { text } => {
            format!(
                "Digitar {} caracteres (conteúdo oculto; confira o digest)",
                text.chars().count()
            )
        }
    }
}

fn error(code: ErrorCode, message: impl Into<String>) -> TelechirError {
    TelechirError {
        code,
        message: message.into(),
        retryable: false,
        retry_after_ms: None,
        details: None,
    }
}

#[cfg(windows)]
mod windows;

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::protocol::RiskLevel;

    #[derive(Default)]
    struct FakeState {
        confirms: usize,
        controls: usize,
        last_digest: Option<String>,
    }

    struct FakePlatform {
        state: Arc<Mutex<FakeState>>,
        confirm: bool,
    }

    impl ComputerPlatform for FakePlatform {
        fn capture_screen(
            &self,
            max_width: u32,
            max_height: u32,
            _max_bytes: usize,
        ) -> Result<ScreenCapture, TelechirError> {
            Ok(ScreenCapture {
                bytes: vec![0x42, 0x4d, 1, 2, 3],
                width: max_width,
                height: max_height,
                media_type: "image/png",
            })
        }

        fn confirm_critical_input(
            &self,
            _action: &ComputerAction,
            argument_digest: &str,
            _timeout_seconds: u32,
        ) -> Result<bool, TelechirError> {
            let mut state = self.state.lock().unwrap();
            state.confirms += 1;
            state.last_digest = Some(argument_digest.to_owned());
            Ok(self.confirm)
        }

        fn control(&self, _action: &ComputerAction) -> Result<(), TelechirError> {
            self.state.lock().unwrap().controls += 1;
            Ok(())
        }
    }

    fn request(operation: CommandOperation, arguments: Value) -> CommandRequest {
        CommandRequest {
            command_id: "cmd_phase13_computer".to_owned(),
            idempotency_key: operation
                .has_side_effect()
                .then(|| "idem_phase13_computer".to_owned()),
            operation,
            arguments: arguments.as_object().unwrap().clone(),
            requested_permissions: vec![match operation {
                CommandOperation::ScreenCapture => PermissionDomain::ScreenRead,
                CommandOperation::ComputerInput => PermissionDomain::InputControl,
                _ => PermissionDomain::FsRead,
            }],
            risk: match operation {
                CommandOperation::ScreenCapture => RiskLevel::High,
                CommandOperation::ComputerInput => RiskLevel::Critical,
                _ => RiskLevel::Low,
            },
            workspace_id: None,
            approval_id: None,
        }
    }

    #[test]
    fn capture_is_bounded_and_marked_untrusted() {
        let state = Arc::new(Mutex::new(FakeState::default()));
        let executor = ComputerExecutor::with_test_platform(
            Box::new(FakePlatform {
                state,
                confirm: true,
            }),
            true,
            false,
        );
        let value = executor
            .execute(&request(
                CommandOperation::ScreenCapture,
                json!({"max_width":128,"max_height":96}),
            ))
            .unwrap();
        assert_eq!(value["media_type"], "image/png");
        assert_eq!(value["width"], 128);
        assert_eq!(value["untrusted"], true);
    }

    #[test]
    fn computer_input_requires_exact_permission_and_bounded_text() {
        let state = Arc::new(Mutex::new(FakeState::default()));
        let executor = ComputerExecutor::with_test_platform(
            Box::new(FakePlatform {
                state,
                confirm: true,
            }),
            false,
            true,
        );
        let mut wrong = request(
            CommandOperation::ComputerInput,
            json!({"action":{"kind":"click","x":1,"y":2,"button":"left"}}),
        );
        wrong.requested_permissions.push(PermissionDomain::FsRead);
        assert_eq!(
            executor.preflight(&wrong).unwrap_err().code,
            ErrorCode::PolicyDenied
        );

        let oversized = request(
            CommandOperation::ComputerInput,
            json!({"action":{"kind":"type_text","text":"x".repeat(MAX_TYPE_TEXT_CHARS + 1)}}),
        );
        assert_eq!(
            executor.preflight(&oversized).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn confirmation_is_bound_to_argument_digest_and_happens_before_control() {
        let state = Arc::new(Mutex::new(FakeState::default()));
        let executor = ComputerExecutor::with_test_platform(
            Box::new(FakePlatform {
                state: state.clone(),
                confirm: true,
            }),
            false,
            true,
        );
        let request = request(
            CommandOperation::ComputerInput,
            json!({"action":{"kind":"move_pointer","x":10,"y":20}}),
        );
        assert!(executor.confirm_critical_input(&request).unwrap());
        let digest = command_argument_digest(&request).unwrap();
        assert_eq!(
            state.lock().unwrap().last_digest.as_deref(),
            Some(digest.as_str())
        );
        assert_eq!(state.lock().unwrap().controls, 0);
        executor.execute(&request).unwrap();
        assert_eq!(state.lock().unwrap().controls, 1);
    }

    #[test]
    fn disabled_computer_use_fails_closed() {
        let executor = ComputerExecutor::disabled();
        let request = request(CommandOperation::ScreenCapture, json!({}));
        assert_eq!(
            executor.preflight(&request).unwrap_err().code,
            ErrorCode::UnsupportedCapability
        );
    }
}
