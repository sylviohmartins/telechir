#![deny(unsafe_op_in_unsafe_fn)]

use std::ffi::c_void;
use std::mem::{size_of, zeroed};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    UnsupportedCapability,
    PolicyDenied,
    InternalError,
    OutputTruncated,
    InvalidArgument,
    Conflict,
}

#[derive(Debug, Clone)]
pub struct TelechirError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
    pub details: Option<()>,
}

#[derive(Debug, Clone)]
pub struct ScreenCapture {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub media_type: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyModifier {
    Ctrl,
    Alt,
    Shift,
    Meta,
}

#[derive(Debug, Clone)]
pub enum ComputerAction {
    MovePointer {
        x: i32,
        y: i32,
    },
    Click {
        x: i32,
        y: i32,
        button: MouseButton,
        click_count: u8,
    },
    Scroll {
        x: i32,
        y: i32,
        delta_y: i32,
    },
    Key {
        key: String,
        modifiers: Vec<KeyModifier>,
    },
    TypeText {
        text: String,
    },
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

fn action_summary(action: &ComputerAction) -> String {
    match action {
        ComputerAction::MovePointer { x, y } => format!("Mover ponteiro para ({x}, {y})"),
        ComputerAction::Click {
            x,
            y,
            button,
            click_count,
        } => format!("Clique {button:?} x{click_count} em ({x}, {y})"),
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

type Bool = i32;
type Handle = isize;
type Hdc = isize;
type Hgdiobj = isize;
type Hbitmap = isize;

const SM_XVIRTUALSCREEN: i32 = 76;
const SM_YVIRTUALSCREEN: i32 = 77;
const SM_CXVIRTUALSCREEN: i32 = 78;
const SM_CYVIRTUALSCREEN: i32 = 79;

const SRCCOPY: u32 = 0x00CC0020;
const CAPTUREBLT: u32 = 0x40000000;
const HALFTONE: i32 = 4;
const DIB_RGB_COLORS: u32 = 0;
const BI_RGB: u32 = 0;

const INPUT_MOUSE: u32 = 0;
const INPUT_KEYBOARD: u32 = 1;
const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;
const MOUSEEVENTF_WHEEL: u32 = 0x0800;
const KEYEVENTF_KEYUP: u32 = 0x0002;
const KEYEVENTF_UNICODE: u32 = 0x0004;

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;
const VK_LWIN: u16 = 0x5B;

const MB_YESNO: u32 = 0x0000_0004;
const MB_ICONWARNING: u32 = 0x0000_0030;
const MB_DEFBUTTON2: u32 = 0x0000_0100;
const MB_SETFOREGROUND: u32 = 0x0001_0000;
const MB_TOPMOST: u32 = 0x0004_0000;
const IDYES: u32 = 6;
const WTS_CURRENT_SERVER_HANDLE: Handle = 0;
const NO_ACTIVE_CONSOLE_SESSION: u32 = 0xffff_ffff;

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
#[allow(non_snake_case)]
struct BitmapInfoHeader {
    biSize: u32,
    biWidth: i32,
    biHeight: i32,
    biPlanes: u16,
    biBitCount: u16,
    biCompression: u32,
    biSizeImage: u32,
    biXPelsPerMeter: i32,
    biYPelsPerMeter: i32,
    biClrUsed: u32,
    biClrImportant: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct RgbQuad {
    blue: u8,
    green: u8,
    red: u8,
    reserved: u8,
}

#[repr(C)]
struct BitmapInfo {
    header: BitmapInfoHeader,
    colors: [RgbQuad; 1],
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(non_snake_case)]
struct MouseInput {
    dx: i32,
    dy: i32,
    mouseData: u32,
    dwFlags: u32,
    time: u32,
    dwExtraInfo: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(non_snake_case)]
struct KeyboardInput {
    wVk: u16,
    wScan: u16,
    dwFlags: u32,
    time: u32,
    dwExtraInfo: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
union InputData {
    mouse: MouseInput,
    keyboard: KeyboardInput,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Input {
    kind: u32,
    data: InputData,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn GetDC(window: Handle) -> Hdc;
    fn ReleaseDC(window: Handle, dc: Hdc) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn SetCursorPos(x: i32, y: i32) -> Bool;
    fn GetCursorPos(point: *mut Point) -> Bool;
    fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateCompatibleDC(dc: Hdc) -> Hdc;
    fn DeleteDC(dc: Hdc) -> Bool;
    fn CreateCompatibleBitmap(dc: Hdc, width: i32, height: i32) -> Hbitmap;
    fn SelectObject(dc: Hdc, object: Hgdiobj) -> Hgdiobj;
    fn DeleteObject(object: Hgdiobj) -> Bool;
    fn SetStretchBltMode(dc: Hdc, mode: i32) -> i32;
    fn StretchBlt(
        dest: Hdc,
        x_dest: i32,
        y_dest: i32,
        width_dest: i32,
        height_dest: i32,
        source: Hdc,
        x_source: i32,
        y_source: i32,
        width_source: i32,
        height_source: i32,
        operation: u32,
    ) -> Bool;
    fn GetDIBits(
        dc: Hdc,
        bitmap: Hbitmap,
        start: u32,
        lines: u32,
        bits: *mut c_void,
        info: *mut BitmapInfo,
        usage: u32,
    ) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn WTSGetActiveConsoleSessionId() -> u32;
}

#[link(name = "wtsapi32")]
unsafe extern "system" {
    fn WTSSendMessageW(
        server: Handle,
        session_id: u32,
        title: *mut u16,
        title_length: u32,
        message: *mut u16,
        message_length: u32,
        style: u32,
        timeout: u32,
        response: *mut u32,
        wait: Bool,
    ) -> Bool;
}

pub struct WindowsComputerPlatform;

impl WindowsComputerPlatform {
    pub fn new() -> Result<Self, TelechirError> {
        let desktop = virtual_desktop()?;
        if desktop.width <= 0 || desktop.height <= 0 {
            return Err(error(
                ErrorCode::UnsupportedCapability,
                "Windows virtual desktop is unavailable",
            ));
        }
        Ok(Self)
    }
}

impl ComputerPlatform for WindowsComputerPlatform {
    fn capture_screen(
        &self,
        max_width: u32,
        max_height: u32,
        max_bytes: usize,
    ) -> Result<ScreenCapture, TelechirError> {
        capture_virtual_desktop(max_width, max_height, max_bytes)
    }

    fn confirm_critical_input(
        &self,
        action: &ComputerAction,
        argument_digest: &str,
        timeout_seconds: u32,
    ) -> Result<bool, TelechirError> {
        let session_id = unsafe { WTSGetActiveConsoleSessionId() };
        if session_id == NO_ACTIVE_CONSOLE_SESSION {
            return Err(error(
                ErrorCode::PolicyDenied,
                "no active local console session is available for CRITICAL confirmation",
            ));
        }

        let digest = argument_digest.chars().take(16).collect::<String>();
        let title = wide("Telechir — confirmação local CRITICAL");
        let message = wide(&format!(
            "Uma IA autorizada solicitou controle do computador.\n\nAção: {}\nDigest: {}…\n\nAprovar esta única ação?\n\nExpira em {} segundos.",
            action_summary(action),
            digest,
            timeout_seconds
        ));
        let mut response = 0u32;
        let style = MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST;
        let ok = unsafe {
            WTSSendMessageW(
                WTS_CURRENT_SERVER_HANDLE,
                session_id,
                title.as_ptr() as *mut u16,
                ((title.len().saturating_sub(1)) * 2) as u32,
                message.as_ptr() as *mut u16,
                ((message.len().saturating_sub(1)) * 2) as u32,
                style,
                timeout_seconds,
                &mut response,
                1,
            )
        };
        if ok == 0 {
            return Err(error(
                ErrorCode::PolicyDenied,
                "Windows could not present the local CRITICAL confirmation prompt",
            ));
        }
        Ok(response == IDYES)
    }

    fn control(&self, action: &ComputerAction) -> Result<(), TelechirError> {
        match action {
            ComputerAction::MovePointer { x, y } => set_pointer(*x, *y),
            ComputerAction::Click {
                x,
                y,
                button,
                click_count,
            } => {
                set_pointer(*x, *y)?;
                let (down, up) = mouse_button_flags(*button);
                let mut inputs = Vec::with_capacity((*click_count as usize) * 2);
                for _ in 0..*click_count {
                    inputs.push(mouse_input(0, down));
                    inputs.push(mouse_input(0, up));
                }
                send_inputs_with_cleanup(&inputs, &[mouse_input(0, up)])
            }
            ComputerAction::Scroll { x, y, delta_y } => {
                set_pointer(*x, *y)?;
                send_inputs(&[mouse_input(*delta_y as u32, MOUSEEVENTF_WHEEL)])
            }
            ComputerAction::Key { key, modifiers } => {
                let virtual_key = virtual_key(key)?;
                let modifier_keys = modifiers
                    .iter()
                    .copied()
                    .map(modifier_virtual_key)
                    .collect::<Vec<_>>();
                let mut inputs = Vec::with_capacity(modifier_keys.len() * 2 + 2);
                for key in &modifier_keys {
                    inputs.push(key_input(*key, 0, 0));
                }
                inputs.push(key_input(virtual_key, 0, 0));
                inputs.push(key_input(virtual_key, 0, KEYEVENTF_KEYUP));
                for key in modifier_keys.iter().rev() {
                    inputs.push(key_input(*key, 0, KEYEVENTF_KEYUP));
                }

                let mut cleanup = Vec::with_capacity(modifier_keys.len() + 1);
                cleanup.push(key_input(virtual_key, 0, KEYEVENTF_KEYUP));
                for key in modifier_keys.iter().rev() {
                    cleanup.push(key_input(*key, 0, KEYEVENTF_KEYUP));
                }
                send_inputs_with_cleanup(&inputs, &cleanup)
            }
            ComputerAction::TypeText { text } => {
                let mut inputs = Vec::with_capacity(text.encode_utf16().count() * 2);
                let units = text.encode_utf16().collect::<Vec<_>>();
                for unit in &units {
                    inputs.push(key_input(0, *unit, KEYEVENTF_UNICODE));
                    inputs.push(key_input(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
                let cleanup = units
                    .iter()
                    .rev()
                    .map(|unit| key_input(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
                    .collect::<Vec<_>>();
                send_inputs_with_cleanup(&inputs, &cleanup)
            }
        }
    }
}

#[derive(Clone, Copy)]
struct DesktopBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn virtual_desktop() -> Result<DesktopBounds, TelechirError> {
    let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 0 || height <= 0 {
        return Err(error(
            ErrorCode::UnsupportedCapability,
            "Windows virtual desktop metrics are unavailable",
        ));
    }
    Ok(DesktopBounds {
        x,
        y,
        width,
        height,
    })
}

fn capture_virtual_desktop(
    max_width: u32,
    max_height: u32,
    max_bytes: usize,
) -> Result<ScreenCapture, TelechirError> {
    let source = virtual_desktop()?;
    let (width, height) = bounded_capture_dimensions(
        source.width as u32,
        source.height as u32,
        max_width,
        max_height,
        max_bytes,
    )?;
    let source_dc = unsafe { GetDC(0) };
    if source_dc == 0 {
        return Err(error(
            ErrorCode::UnsupportedCapability,
            "Windows screen device context is unavailable",
        ));
    }
    let memory_dc = unsafe { CreateCompatibleDC(source_dc) };
    if memory_dc == 0 {
        unsafe {
            ReleaseDC(0, source_dc);
        }
        return Err(error(
            ErrorCode::InternalError,
            "Windows could not create the screen capture memory context",
        ));
    }
    let bitmap = unsafe { CreateCompatibleBitmap(source_dc, width as i32, height as i32) };
    if bitmap == 0 {
        unsafe {
            DeleteDC(memory_dc);
            ReleaseDC(0, source_dc);
        }
        return Err(error(
            ErrorCode::InternalError,
            "Windows could not allocate the bounded screen bitmap",
        ));
    }

    let previous = unsafe { SelectObject(memory_dc, bitmap) };
    let _ = unsafe { SetStretchBltMode(memory_dc, HALFTONE) };
    let copied = unsafe {
        StretchBlt(
            memory_dc,
            0,
            0,
            width as i32,
            height as i32,
            source_dc,
            source.x,
            source.y,
            source.width,
            source.height,
            SRCCOPY | CAPTUREBLT,
        )
    };

    let result = if copied == 0 {
        Err(error(
            ErrorCode::InternalError,
            "Windows failed to capture the virtual desktop",
        ))
    } else {
        bitmap_to_png(memory_dc, bitmap, width, height, max_bytes)
    };

    unsafe {
        if previous != 0 && previous != -1 {
            SelectObject(memory_dc, previous);
        }
        DeleteObject(bitmap);
        DeleteDC(memory_dc);
        ReleaseDC(0, source_dc);
    }
    result
}

fn bounded_capture_dimensions(
    source_width: u32,
    source_height: u32,
    max_width: u32,
    max_height: u32,
    max_bytes: usize,
) -> Result<(u32, u32), TelechirError> {
    let width_ratio = max_width as f64 / source_width as f64;
    let height_ratio = max_height as f64 / source_height as f64;
    let ratio = width_ratio.min(height_ratio).min(1.0);
    let mut width = ((source_width as f64 * ratio).floor() as u32).max(1);
    let mut height = ((source_height as f64 * ratio).floor() as u32).max(1);

    while raw_capture_budget(width, height) > max_bytes {
        if width <= 1 || height <= 1 {
            return Err(error(
                ErrorCode::OutputTruncated,
                "screen capture cannot fit the bounded realtime result",
            ));
        }
        width = (width * 95 / 100).max(1);
        height = (height * 95 / 100).max(1);
    }
    Ok((width, height))
}

fn raw_capture_budget(width: u32, height: u32) -> usize {
    // Reserve headroom for PNG filter/deflate framing so the encoded result
    // remains safely below the realtime binary budget.
    row_bytes(width) * height as usize + 8 * 1024
}

fn row_bytes(width: u32) -> usize {
    ((width as usize * 3) + 3) & !3
}

fn bitmap_to_png(
    dc: Hdc,
    bitmap: Hbitmap,
    width: u32,
    height: u32,
    max_bytes: usize,
) -> Result<ScreenCapture, TelechirError> {
    let stride = row_bytes(width);
    let image_size = stride * height as usize;
    if raw_capture_budget(width, height) > max_bytes {
        return Err(error(
            ErrorCode::OutputTruncated,
            "screen capture exceeds the bounded realtime result budget",
        ));
    }

    let mut pixels = vec![0u8; image_size];
    let mut info = BitmapInfo {
        header: BitmapInfoHeader {
            biSize: size_of::<BitmapInfoHeader>() as u32,
            biWidth: width as i32,
            biHeight: height as i32,
            biPlanes: 1,
            biBitCount: 24,
            biCompression: BI_RGB,
            biSizeImage: image_size as u32,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        colors: [RgbQuad {
            blue: 0,
            green: 0,
            red: 0,
            reserved: 0,
        }],
    };
    let lines = unsafe {
        GetDIBits(
            dc,
            bitmap,
            0,
            height,
            pixels.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    if lines != height as i32 {
        return Err(error(
            ErrorCode::InternalError,
            "Windows failed to materialize the bounded screen bitmap",
        ));
    }

    let packed_row_bytes = width as usize * 3;
    let mut rgb = vec![0u8; packed_row_bytes * height as usize];
    for output_y in 0..height as usize {
        let source_y = height as usize - 1 - output_y;
        let source_row = source_y * stride;
        let output_row = output_y * packed_row_bytes;
        for x in 0..width as usize {
            let source = source_row + x * 3;
            let output = output_row + x * 3;
            rgb[output] = pixels[source + 2];
            rgb[output + 1] = pixels[source + 1];
            rgb[output + 2] = pixels[source];
        }
    }

    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|_| {
            error(
                ErrorCode::InternalError,
                "Windows screen capture PNG encoder could not initialize",
            )
        })?;
        writer.write_image_data(&rgb).map_err(|_| {
            error(
                ErrorCode::InternalError,
                "Windows screen capture PNG encoder failed",
            )
        })?;
    }

    if bytes.len() > max_bytes {
        return Err(error(
            ErrorCode::OutputTruncated,
            "encoded screen capture exceeds the bounded realtime result",
        ));
    }

    Ok(ScreenCapture {
        bytes,
        width,
        height,
        media_type: "image/png",
    })
}

fn set_pointer(x: i32, y: i32) -> Result<(), TelechirError> {
    let desktop = virtual_desktop()?;
    if x < desktop.x
        || y < desktop.y
        || x >= desktop.x.saturating_add(desktop.width)
        || y >= desktop.y.saturating_add(desktop.height)
    {
        return Err(error(
            ErrorCode::InvalidArgument,
            "pointer coordinates are outside the current Windows virtual desktop",
        ));
    }
    if unsafe { SetCursorPos(x, y) } == 0 {
        return Err(error(
            ErrorCode::PolicyDenied,
            "Windows rejected pointer movement on the current desktop",
        ));
    }

    let mut point: Point = unsafe { zeroed() };
    if unsafe { GetCursorPos(&mut point) } == 0 || point.x != x || point.y != y {
        return Err(error(
            ErrorCode::Conflict,
            "pointer position changed before the requested action could be verified",
        ));
    }
    Ok(())
}

fn mouse_button_flags(button: MouseButton) -> (u32, u32) {
    match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}

fn mouse_input(data: u32, flags: u32) -> Input {
    Input {
        kind: INPUT_MOUSE,
        data: InputData {
            mouse: MouseInput {
                dx: 0,
                dy: 0,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_input(virtual_key: u16, scan: u16, flags: u32) -> Input {
    Input {
        kind: INPUT_KEYBOARD,
        data: InputData {
            keyboard: KeyboardInput {
                wVk: virtual_key,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_inputs(inputs: &[Input]) -> Result<(), TelechirError> {
    send_inputs_with_cleanup(inputs, &[])
}

fn send_inputs_with_cleanup(inputs: &[Input], cleanup: &[Input]) -> Result<(), TelechirError> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = raw_send_inputs(inputs);
    if sent != inputs.len() as u32 {
        if !cleanup.is_empty() {
            let _ = raw_send_inputs(cleanup);
        }
        return Err(error(
            ErrorCode::PolicyDenied,
            "Windows rejected all or part of the input sequence; a best-effort release cleanup was attempted because UIPI, secure desktop, or focus state may block injection",
        ));
    }
    Ok(())
}

fn raw_send_inputs(inputs: &[Input]) -> u32 {
    if inputs.is_empty() {
        return 0;
    }
    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<Input>() as i32,
        )
    }
}

fn modifier_virtual_key(modifier: KeyModifier) -> u16 {
    match modifier {
        KeyModifier::Ctrl => VK_CONTROL,
        KeyModifier::Alt => VK_MENU,
        KeyModifier::Shift => VK_SHIFT,
        KeyModifier::Meta => VK_LWIN,
    }
}

fn virtual_key(key: &str) -> Result<u16, TelechirError> {
    let normalized = key.trim().to_ascii_uppercase();
    let value = match normalized.as_str() {
        "ENTER" => 0x0D,
        "TAB" => 0x09,
        "ESCAPE" => 0x1B,
        "BACKSPACE" => 0x08,
        "DELETE" => 0x2E,
        "SPACE" => 0x20,
        "ARROWUP" => 0x26,
        "ARROWDOWN" => 0x28,
        "ARROWLEFT" => 0x25,
        "ARROWRIGHT" => 0x27,
        "HOME" => 0x24,
        "END" => 0x23,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        "F1" => 0x70,
        "F2" => 0x71,
        "F3" => 0x72,
        "F4" => 0x73,
        "F5" => 0x74,
        "F6" => 0x75,
        "F7" => 0x76,
        "F8" => 0x77,
        "F9" => 0x78,
        "F10" => 0x79,
        "F11" => 0x7A,
        "F12" => 0x7B,
        _ if normalized.len() == 1 => normalized.as_bytes()[0] as u16,
        _ => {
            return Err(error(
                ErrorCode::InvalidArgument,
                "unsupported Windows key name",
            ));
        }
    };
    Ok(value)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_dimensions_fit_wire_budget() {
        let (width, height) = bounded_capture_dimensions(3840, 2160, 320, 240, 180 * 1024).unwrap();
        assert!(width <= 320);
        assert!(height <= 240);
        assert!(raw_capture_budget(width, height) <= 180 * 1024);
    }

    #[test]
    fn dib_row_size_is_four_byte_aligned() {
        assert_eq!(row_bytes(1), 4);
        assert_eq!(row_bytes(2), 8);
        assert_eq!(row_bytes(320), 960);
    }
}
