use super::{ComputerAction, ComputerPlatform, KeyModifier, MouseButton, ScreenCapture};
use crate::protocol::{ErrorCode, TelechirError};
use telechir_windows_computer::{
    ComputerPlatform as NativeComputerPlatform, ErrorCode as NativeErrorCode,
};

pub struct WindowsComputerPlatform {
    inner: telechir_windows_computer::WindowsComputerPlatform,
}

impl WindowsComputerPlatform {
    pub fn new() -> Result<Self, TelechirError> {
        Ok(Self {
            inner: telechir_windows_computer::WindowsComputerPlatform::new().map_err(map_error)?,
        })
    }
}

impl ComputerPlatform for WindowsComputerPlatform {
    fn capture_screen(
        &self,
        max_width: u32,
        max_height: u32,
        max_bytes: usize,
    ) -> Result<ScreenCapture, TelechirError> {
        let capture = self
            .inner
            .capture_screen(max_width, max_height, max_bytes)
            .map_err(map_error)?;
        Ok(ScreenCapture {
            bytes: capture.bytes,
            width: capture.width,
            height: capture.height,
            media_type: capture.media_type,
        })
    }

    fn confirm_critical_input(
        &self,
        action: &ComputerAction,
        argument_digest: &str,
        timeout_seconds: u32,
    ) -> Result<bool, TelechirError> {
        self.inner
            .confirm_critical_input(&native_action(action), argument_digest, timeout_seconds)
            .map_err(map_error)
    }

    fn control(&self, action: &ComputerAction) -> Result<(), TelechirError> {
        self.inner
            .control(&native_action(action))
            .map_err(map_error)
    }
}

fn native_action(action: &ComputerAction) -> telechir_windows_computer::ComputerAction {
    match action {
        ComputerAction::MovePointer { x, y } => {
            telechir_windows_computer::ComputerAction::MovePointer { x: *x, y: *y }
        }
        ComputerAction::Click {
            x,
            y,
            button,
            click_count,
        } => telechir_windows_computer::ComputerAction::Click {
            x: *x,
            y: *y,
            button: match button {
                MouseButton::Left => telechir_windows_computer::MouseButton::Left,
                MouseButton::Right => telechir_windows_computer::MouseButton::Right,
                MouseButton::Middle => telechir_windows_computer::MouseButton::Middle,
            },
            click_count: *click_count,
        },
        ComputerAction::Scroll { x, y, delta_y } => {
            telechir_windows_computer::ComputerAction::Scroll {
                x: *x,
                y: *y,
                delta_y: *delta_y,
            }
        }
        ComputerAction::Key { key, modifiers } => telechir_windows_computer::ComputerAction::Key {
            key: key.clone(),
            modifiers: modifiers
                .iter()
                .copied()
                .map(|modifier| match modifier {
                    KeyModifier::Ctrl => telechir_windows_computer::KeyModifier::Ctrl,
                    KeyModifier::Alt => telechir_windows_computer::KeyModifier::Alt,
                    KeyModifier::Shift => telechir_windows_computer::KeyModifier::Shift,
                    KeyModifier::Meta => telechir_windows_computer::KeyModifier::Meta,
                })
                .collect(),
        },
        ComputerAction::TypeText { text } => {
            telechir_windows_computer::ComputerAction::TypeText { text: text.clone() }
        }
    }
}

fn map_error(error: telechir_windows_computer::TelechirError) -> TelechirError {
    let code = match error.code {
        NativeErrorCode::UnsupportedCapability => ErrorCode::UnsupportedCapability,
        NativeErrorCode::PolicyDenied => ErrorCode::PolicyDenied,
        NativeErrorCode::InternalError => ErrorCode::InternalError,
        NativeErrorCode::OutputTruncated => ErrorCode::OutputTruncated,
        NativeErrorCode::InvalidArgument => ErrorCode::InvalidArgument,
        NativeErrorCode::Conflict => ErrorCode::Conflict,
    };
    TelechirError {
        code,
        message: error.message,
        retryable: false,
        retry_after_ms: None,
        details: None,
    }
}
