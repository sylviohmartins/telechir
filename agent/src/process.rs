use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::filesystem::FilesystemPolicy;
use crate::ports::{CommandExecutor, ExecutionOutcome};
use crate::protocol::{
    CommandOperation, CommandRequest, ErrorCode, PermissionDomain, RiskLevel, TelechirError,
};

pub const PROCESS_CAPABILITIES: [&str; 6] = [
    "shell.exec",
    "process.start",
    "process.read",
    "process.write",
    "process.cancel",
    "process.list",
];

pub const MAX_COMMAND_BYTES: usize = 32_768;
pub const MAX_PROCESS_INPUT_BYTES: usize = 65_536;
pub const PUBLIC_MAX_PROCESS_READ_BYTES: usize = 262_144;
pub const MAX_INLINE_PROCESS_READ_BYTES: usize = 64 * 1024;
pub const DEFAULT_PROCESS_READ_BYTES: usize = 64 * 1024;
pub const MANAGED_STREAM_RING_BYTES: usize = 2 * 1024 * 1024;
pub const SHORT_COMMAND_STREAM_BYTES: usize = 16 * 1024;
pub const DEFAULT_RUN_TIMEOUT_SECONDS: u64 = 30;
pub const MAX_RUN_TIMEOUT_SECONDS: u64 = 120;
pub const MAX_CONCURRENT_PROCESSES: usize = 8;
pub const MAX_PROCESS_RECORDS: usize = 128;

const IDEMPOTENCY_CACHE_SIZE: usize = 1024;
const GRACEFUL_TERMINATION_WAIT: Duration = Duration::from_millis(300);
const WAIT_POLL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone)]
pub struct ProcessPolicy {
    filesystem: FilesystemPolicy,
}

impl ProcessPolicy {
    pub fn new(filesystem: FilesystemPolicy) -> Self {
        Self { filesystem }
    }

    fn resolve_cwd(&self, requested: Option<&str>) -> Result<PathBuf, TelechirError> {
        let path = match requested {
            Some(value) if !value.trim().is_empty() => self.filesystem.resolve_existing(value)?,
            Some(_) => {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    "process cwd must not be empty",
                ));
            }
            None => {
                let roots = self.filesystem.roots();
                if roots.len() != 1 {
                    return Err(error(
                        ErrorCode::PolicyDenied,
                        "process cwd must be explicit when local policy has zero or multiple roots",
                    ));
                }
                roots[0].clone()
            }
        };

        if !path.is_dir() {
            return Err(error(
                ErrorCode::InvalidArgument,
                "process cwd must resolve to an authorized directory",
            ));
        }
        Ok(path)
    }

    fn authorize_shell(
        &self,
        request: &CommandRequest,
        command: &str,
        approval_verified: bool,
    ) -> Result<(), TelechirError> {
        if !request
            .requested_permissions
            .contains(&PermissionDomain::ShellSafe)
        {
            return Err(error(
                ErrorCode::PolicyDenied,
                "shell execution requires SHELL_SAFE",
            ));
        }
        if request.requested_permissions.iter().any(|permission| {
            matches!(
                permission,
                PermissionDomain::ShellFull
                    | PermissionDomain::Elevation
                    | PermissionDomain::Admin
                    | PermissionDomain::Network
                    | PermissionDomain::SecretUse
                    | PermissionDomain::GitWrite
                    | PermissionDomain::GitRemoteWrite
            )
        }) {
            return Err(error(
                ErrorCode::PolicyDenied,
                "local shell policy does not allow shell-full, elevation, admin, network, secret, or Git write permissions",
            ));
        }
        if request.risk == RiskLevel::Low {
            return Err(error(
                ErrorCode::PolicyDenied,
                "shell execution must be classified at least MEDIUM",
            ));
        }
        classify_safe_command(command, approval_verified)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ManagedProcessState {
    Starting,
    Running,
    Exited,
    Failed,
    Cancelled,
}

impl ManagedProcessState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    const fn terminal(self) -> bool {
        matches!(self, Self::Exited | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug)]
struct ByteRing {
    start_offset: u64,
    next_offset: u64,
    bytes: VecDeque<u8>,
    ever_dropped: bool,
    capacity: usize,
}

impl ByteRing {
    fn new(capacity: usize) -> Self {
        Self {
            start_offset: 0,
            next_offset: 0,
            bytes: VecDeque::with_capacity(capacity.min(64 * 1024)),
            ever_dropped: false,
            capacity,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        for byte in chunk {
            self.bytes.push_back(*byte);
            self.next_offset = self.next_offset.saturating_add(1);
            if self.bytes.len() > self.capacity {
                self.bytes.pop_front();
                self.start_offset = self.start_offset.saturating_add(1);
                self.ever_dropped = true;
            }
        }
    }

    fn read_from(&self, requested: u64, max_bytes: usize) -> RingRead {
        let actual = requested.max(self.start_offset).min(self.next_offset);
        let skipped = requested < self.start_offset;
        let index = actual.saturating_sub(self.start_offset) as usize;
        let available = self.bytes.len().saturating_sub(index);
        let take = available.min(max_bytes);
        let data = self
            .bytes
            .iter()
            .skip(index)
            .take(take)
            .copied()
            .collect::<Vec<_>>();
        let next = actual.saturating_add(take as u64);
        RingRead {
            data,
            next_offset: next,
            skipped,
            has_more: next < self.next_offset,
        }
    }

    fn snapshot(&self) -> (Vec<u8>, bool) {
        (self.bytes.iter().copied().collect(), self.ever_dropped)
    }
}

#[derive(Debug)]
struct RingRead {
    data: Vec<u8>,
    next_offset: u64,
    skipped: bool,
    has_more: bool,
}

#[derive(Debug)]
struct ManagedProcess {
    process_id: String,
    cwd: PathBuf,
    started_at: DateTime<Utc>,
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Arc<Mutex<ByteRing>>,
    stderr: Arc<Mutex<ByteRing>>,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
    state: ManagedProcessState,
    exit_code: Option<i32>,
}

impl ManagedProcess {
    fn settle_capture_threads(&mut self, wait: Duration) {
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline {
            let stdout_done = self
                .stdout_thread
                .as_ref()
                .is_none_or(JoinHandle::is_finished);
            let stderr_done = self
                .stderr_thread
                .as_ref()
                .is_none_or(JoinHandle::is_finished);
            if stdout_done && stderr_done {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }

        if self
            .stdout_thread
            .as_ref()
            .is_some_and(JoinHandle::is_finished)
            && let Some(handle) = self.stdout_thread.take()
        {
            let _ = handle.join();
        }
        if self
            .stderr_thread
            .as_ref()
            .is_some_and(JoinHandle::is_finished)
            && let Some(handle) = self.stderr_thread.take()
        {
            let _ = handle.join();
        }
    }

    fn refresh(&mut self) -> Result<(), TelechirError> {
        if self.state.terminal() {
            return Ok(());
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.exit_code = status.code();
                self.state = if status.success() {
                    ManagedProcessState::Exited
                } else {
                    ManagedProcessState::Failed
                };
                self.stdin.take();
                self.settle_capture_threads(Duration::from_millis(20));
                Ok(())
            }
            Ok(None) => {
                self.state = ManagedProcessState::Running;
                Ok(())
            }
            Err(source) => {
                self.state = ManagedProcessState::Failed;
                self.stdin.take();
                Err(process_io_error(
                    ErrorCode::InternalError,
                    "managed process state cannot be refreshed",
                    source,
                ))
            }
        }
    }
}

#[derive(Debug, Clone)]
struct CachedOutcome {
    digest: String,
    outcome: ExecutionOutcome,
}

#[derive(Debug)]
pub struct ProcessExecutor {
    policy: ProcessPolicy,
    processes: HashMap<String, ManagedProcess>,
    process_order: VecDeque<String>,
    idempotency: HashMap<String, CachedOutcome>,
    idempotency_order: VecDeque<String>,
}

impl ProcessExecutor {
    pub fn new(policy: ProcessPolicy) -> Self {
        Self {
            policy,
            processes: HashMap::new(),
            process_order: VecDeque::new(),
            idempotency: HashMap::new(),
            idempotency_order: VecDeque::new(),
        }
    }

    pub fn policy(&self) -> &ProcessPolicy {
        &self.policy
    }

    pub(crate) fn preflight_shell(
        &self,
        request: &CommandRequest,
        approval_verified: bool,
    ) -> Result<(), TelechirError> {
        match request.operation {
            CommandOperation::ShellExec => {
                let input: RunCommandInput = parse_arguments(&request.arguments)?;
                self.policy
                    .authorize_shell(request, &input.command, approval_verified)?;
                reject_env_refs(&input.env_refs)?;
                let _ = self.policy.resolve_cwd(input.cwd.as_deref())?;
                Ok(())
            }
            CommandOperation::ProcessStart => {
                require_permission(request, PermissionDomain::ProcessControl)?;
                let input: StartProcessInput = parse_arguments(&request.arguments)?;
                self.policy
                    .authorize_shell(request, &input.command, approval_verified)?;
                reject_env_refs(&input.env_refs)?;
                let _ = self.policy.resolve_cwd(input.cwd.as_deref())?;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    pub(crate) fn execute_with_verified_approval(
        &mut self,
        request: &CommandRequest,
        approval_verified: bool,
    ) -> ExecutionOutcome {
        match self.execute_request(request, approval_verified) {
            Ok(value) => ExecutionOutcome::Completed(value),
            Err(error) => ExecutionOutcome::Failed(error),
        }
    }

    fn execute_request(
        &mut self,
        request: &CommandRequest,
        approval_verified: bool,
    ) -> Result<Value, TelechirError> {
        if !matches!(
            request.operation,
            CommandOperation::ShellExec
                | CommandOperation::ProcessStart
                | CommandOperation::ProcessRead
                | CommandOperation::ProcessWrite
                | CommandOperation::ProcessCancel
                | CommandOperation::ProcessList
        ) {
            return Err(error(
                ErrorCode::UnsupportedCapability,
                "process executor does not implement this operation",
            ));
        }

        if request.operation.has_side_effect() {
            return self.with_idempotency(request, approval_verified);
        }
        self.execute_uncached(request, approval_verified)
    }

    fn with_idempotency(
        &mut self,
        request: &CommandRequest,
        approval_verified: bool,
    ) -> Result<Value, TelechirError> {
        let key = request.idempotency_key.as_deref().ok_or_else(|| {
            error(
                ErrorCode::InvalidArgument,
                "side-effect process operation requires idempotency_key",
            )
        })?;
        let digest = request_digest(request)?;
        if let Some(cached) = self.idempotency.get(key) {
            if cached.digest != digest {
                return Err(error(
                    ErrorCode::IdempotencyConflict,
                    "idempotency key was already used with different process arguments",
                ));
            }
            return match &cached.outcome {
                ExecutionOutcome::Completed(value) => Ok(value.clone()),
                ExecutionOutcome::Failed(error) => Err(error.clone()),
            };
        }

        let result = self.execute_uncached(request, approval_verified);
        let outcome = match &result {
            Ok(value) => ExecutionOutcome::Completed(value.clone()),
            Err(error) => ExecutionOutcome::Failed(error.clone()),
        };
        self.remember_idempotency(key.to_owned(), digest, outcome);
        result
    }

    fn remember_idempotency(&mut self, key: String, digest: String, outcome: ExecutionOutcome) {
        if self.idempotency.len() >= IDEMPOTENCY_CACHE_SIZE
            && let Some(oldest) = self.idempotency_order.pop_front()
        {
            self.idempotency.remove(&oldest);
        }
        self.idempotency_order.push_back(key.clone());
        self.idempotency
            .insert(key, CachedOutcome { digest, outcome });
    }

    fn execute_uncached(
        &mut self,
        request: &CommandRequest,
        approval_verified: bool,
    ) -> Result<Value, TelechirError> {
        match request.operation {
            CommandOperation::ShellExec => {
                let input: RunCommandInput = parse_arguments(&request.arguments)?;
                self.policy
                    .authorize_shell(request, &input.command, approval_verified)?;
                reject_env_refs(&input.env_refs)?;
                let cwd = self.policy.resolve_cwd(input.cwd.as_deref())?;
                run_short_command(input, &cwd)
            }
            CommandOperation::ProcessStart => {
                require_permission(request, PermissionDomain::ProcessControl)?;
                let input: StartProcessInput = parse_arguments(&request.arguments)?;
                self.policy
                    .authorize_shell(request, &input.command, approval_verified)?;
                reject_env_refs(&input.env_refs)?;
                let cwd = self.policy.resolve_cwd(input.cwd.as_deref())?;
                self.start_process(input.command, cwd)
            }
            CommandOperation::ProcessRead => {
                require_permission(request, PermissionDomain::ProcessControl)?;
                let input: ReadProcessOutputInput = parse_arguments(&request.arguments)?;
                self.read_process_output(input)
            }
            CommandOperation::ProcessWrite => {
                require_permission(request, PermissionDomain::ProcessControl)?;
                require_medium_risk(request)?;
                let input: WriteProcessInput = parse_arguments(&request.arguments)?;
                self.write_process_input(input)
            }
            CommandOperation::ProcessCancel => {
                require_permission(request, PermissionDomain::ProcessControl)?;
                require_medium_risk(request)?;
                let input: CancelProcessInput = parse_arguments(&request.arguments)?;
                self.cancel_process(input)
            }
            CommandOperation::ProcessList => {
                require_permission(request, PermissionDomain::ProcessControl)?;
                let input: ListManagedProcessesInput = parse_arguments(&request.arguments)?;
                self.list_managed_processes(input)
            }
            _ => Err(error(
                ErrorCode::UnsupportedCapability,
                "process executor does not implement this operation",
            )),
        }
    }

    fn refresh_all(&mut self) {
        for process in self.processes.values_mut() {
            let _ = process.refresh();
        }
    }

    fn running_count(&mut self) -> usize {
        self.refresh_all();
        self.processes
            .values()
            .filter(|process| !process.state.terminal())
            .count()
    }

    fn make_record_room(&mut self) -> Result<(), TelechirError> {
        if self.processes.len() < MAX_PROCESS_RECORDS {
            return Ok(());
        }

        let attempts = self.process_order.len();
        for _ in 0..attempts {
            let Some(candidate) = self.process_order.pop_front() else {
                break;
            };
            let removable = self
                .processes
                .get_mut(&candidate)
                .map(|process| {
                    let _ = process.refresh();
                    process.state.terminal()
                })
                .unwrap_or(true);
            if removable {
                self.processes.remove(&candidate);
                return Ok(());
            }
            self.process_order.push_back(candidate);
        }

        Err(error(
            ErrorCode::RateLimited,
            "managed process record limit has been reached",
        ))
    }

    fn start_process(&mut self, command: String, cwd: PathBuf) -> Result<Value, TelechirError> {
        if self.running_count() >= MAX_CONCURRENT_PROCESSES {
            return Err(error(
                ErrorCode::RateLimited,
                "managed process concurrency limit has been reached",
            ));
        }
        self.make_record_room()?;

        let process_id = format!("proc_{}", Uuid::new_v4());
        let started_at = Utc::now();
        let spawned = spawn_command(&command, &cwd, true, MANAGED_STREAM_RING_BYTES)?;
        let record = ManagedProcess {
            process_id: process_id.clone(),
            cwd,
            started_at,
            child: spawned.child,
            stdin: spawned.stdin,
            stdout: spawned.stdout,
            stderr: spawned.stderr,
            stdout_thread: Some(spawned.stdout_thread),
            stderr_thread: Some(spawned.stderr_thread),
            state: ManagedProcessState::Running,
            exit_code: None,
        };
        self.process_order.push_back(process_id.clone());
        self.processes.insert(process_id.clone(), record);

        Ok(json!({
            "process_id": process_id,
            "state": "running",
            "started_at": started_at
        }))
    }

    fn read_process_output(
        &mut self,
        input: ReadProcessOutputInput,
    ) -> Result<Value, TelechirError> {
        let requested = input.max_bytes.unwrap_or(DEFAULT_PROCESS_READ_BYTES as u64);
        if requested == 0 || requested > PUBLIC_MAX_PROCESS_READ_BYTES as u64 {
            return Err(error(
                ErrorCode::InvalidArgument,
                "process max_bytes must be between 1 and 262144",
            ));
        }
        let max_bytes = requested.min(MAX_INLINE_PROCESS_READ_BYTES as u64) as usize;
        let cursor = decode_cursor(input.cursor.as_deref())?;

        let process = self
            .processes
            .get_mut(&input.process_id)
            .ok_or_else(|| error(ErrorCode::NotFound, "managed process was not found"))?;
        process.refresh()?;

        let stdout_budget = max_bytes.div_ceil(2);
        let stderr_budget = max_bytes.saturating_sub(stdout_budget);
        let stdout = process
            .stdout
            .lock()
            .map_err(|_| error(ErrorCode::InternalError, "stdout buffer lock failed"))?
            .read_from(cursor.stdout, stdout_budget);
        let stderr = process
            .stderr
            .lock()
            .map_err(|_| error(ErrorCode::InternalError, "stderr buffer lock failed"))?
            .read_from(cursor.stderr, stderr_budget);

        let truncated = stdout.skipped
            || stderr.skipped
            || stdout.has_more
            || stderr.has_more
            || requested as usize > max_bytes;
        let next_cursor = if process.state.terminal() && !stdout.has_more && !stderr.has_more {
            None
        } else {
            Some(encode_cursor(OutputCursor {
                stdout: stdout.next_offset,
                stderr: stderr.next_offset,
            })?)
        };

        Ok(json!({
            "process_id": process.process_id,
            "state": process.state.as_str(),
            "stdout": String::from_utf8_lossy(&stdout.data),
            "stderr": String::from_utf8_lossy(&stderr.data),
            "next_cursor": next_cursor,
            "exit_code": process.exit_code,
            "truncated": truncated,
            "artifact_id": null
        }))
    }

    fn write_process_input(&mut self, input: WriteProcessInput) -> Result<Value, TelechirError> {
        let mut bytes = input.input.into_bytes();
        if input.append_newline.unwrap_or(false) {
            bytes.push(b'\n');
        }
        if bytes.len() > MAX_PROCESS_INPUT_BYTES {
            return Err(error(
                ErrorCode::InvalidArgument,
                "process input exceeds the bounded input limit",
            ));
        }

        let process = self
            .processes
            .get_mut(&input.process_id)
            .ok_or_else(|| error(ErrorCode::NotFound, "managed process was not found"))?;
        process.refresh()?;
        if process.state.terminal() {
            return Err(error(
                ErrorCode::Conflict,
                "managed process has already finished",
            ));
        }

        let stdin = process
            .stdin
            .as_mut()
            .ok_or_else(|| error(ErrorCode::Conflict, "managed process does not accept stdin"))?;
        stdin.write_all(&bytes).map_err(|source| {
            process_io_error(
                ErrorCode::Conflict,
                "managed process stdin cannot be written",
                source,
            )
        })?;
        stdin.flush().map_err(|source| {
            process_io_error(
                ErrorCode::Conflict,
                "managed process stdin cannot be flushed",
                source,
            )
        })?;

        Ok(json!({ "accepted": true }))
    }

    fn cancel_process(&mut self, input: CancelProcessInput) -> Result<Value, TelechirError> {
        let process = self
            .processes
            .get_mut(&input.process_id)
            .ok_or_else(|| error(ErrorCode::NotFound, "managed process was not found"))?;
        process.refresh()?;
        if process.state.terminal() {
            return Ok(json!({
                "process_id": process.process_id,
                "state": "already_finished"
            }));
        }

        terminate_process_tree(&mut process.child, input.force.unwrap_or(false))?;
        process.stdin.take();
        process.settle_capture_threads(Duration::from_millis(50));
        process.state = ManagedProcessState::Cancelled;
        process.exit_code = process
            .child
            .try_wait()
            .ok()
            .flatten()
            .and_then(|status| status.code());

        Ok(json!({
            "process_id": process.process_id,
            "state": "cancelled"
        }))
    }

    fn list_managed_processes(
        &mut self,
        input: ListManagedProcessesInput,
    ) -> Result<Value, TelechirError> {
        self.refresh_all();
        let mut processes = self
            .processes
            .values()
            .filter(|process| input.state.is_none_or(|state| state == process.state))
            .map(|process| {
                json!({
                    "process_id": process.process_id,
                    "state": process.state.as_str(),
                    "started_at": process.started_at,
                    "cwd": process.cwd.to_string_lossy()
                })
            })
            .collect::<Vec<_>>();
        processes.sort_by(|left, right| {
            left["started_at"]
                .as_str()
                .cmp(&right["started_at"].as_str())
                .then_with(|| {
                    left["process_id"]
                        .as_str()
                        .cmp(&right["process_id"].as_str())
                })
        });
        Ok(json!({ "processes": processes }))
    }
}

impl CommandExecutor for ProcessExecutor {
    type Error = std::convert::Infallible;

    fn execute(&mut self, request: &CommandRequest) -> Result<ExecutionOutcome, Self::Error> {
        Ok(match self.execute_request(request, false) {
            Ok(value) => ExecutionOutcome::Completed(value),
            Err(error) => ExecutionOutcome::Failed(error),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunCommandInput {
    command: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
    #[serde(default)]
    env_refs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StartProcessInput {
    command: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env_refs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadProcessOutputInput {
    process_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    max_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteProcessInput {
    process_id: String,
    input: String,
    #[serde(default)]
    append_newline: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelProcessInput {
    process_id: String,
    #[serde(default)]
    force: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListManagedProcessesInput {
    #[serde(default)]
    state: Option<ManagedProcessState>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct OutputCursor {
    stdout: u64,
    stderr: u64,
}

struct SpawnedCommand {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Arc<Mutex<ByteRing>>,
    stderr: Arc<Mutex<ByteRing>>,
    stdout_thread: JoinHandle<()>,
    stderr_thread: JoinHandle<()>,
}

fn run_short_command(input: RunCommandInput, cwd: &Path) -> Result<Value, TelechirError> {
    let timeout_seconds = input.timeout_seconds.unwrap_or(DEFAULT_RUN_TIMEOUT_SECONDS);
    if !(1..=MAX_RUN_TIMEOUT_SECONDS).contains(&timeout_seconds) {
        return Err(error(
            ErrorCode::InvalidArgument,
            "run command timeout_seconds must be between 1 and 120",
        ));
    }

    let mut spawned = spawn_command(&input.command, cwd, false, SHORT_COMMAND_STREAM_BYTES)?;
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let status = loop {
        match spawned.child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(WAIT_POLL),
            Ok(None) => {
                terminate_process_tree(&mut spawned.child, true)?;
                let _ = spawned.stdout_thread.join();
                let _ = spawned.stderr_thread.join();
                return Err(error(
                    ErrorCode::Timeout,
                    "short command exceeded its local execution timeout",
                ));
            }
            Err(source) => {
                return Err(process_io_error(
                    ErrorCode::InternalError,
                    "short command state cannot be read",
                    source,
                ));
            }
        }
    };

    let capture_deadline = Instant::now() + Duration::from_millis(50);
    while Instant::now() < capture_deadline
        && (!spawned.stdout_thread.is_finished() || !spawned.stderr_thread.is_finished())
    {
        thread::sleep(Duration::from_millis(2));
    }
    let (stdout, stdout_dropped) = spawned
        .stdout
        .lock()
        .map_err(|_| error(ErrorCode::InternalError, "stdout buffer lock failed"))?
        .snapshot();
    let (stderr, stderr_dropped) = spawned
        .stderr
        .lock()
        .map_err(|_| error(ErrorCode::InternalError, "stderr buffer lock failed"))?
        .snapshot();

    Ok(json!({
        "exit_code": status.code(),
        "stdout": String::from_utf8_lossy(&stdout),
        "stderr": String::from_utf8_lossy(&stderr),
        "truncated": stdout_dropped || stderr_dropped,
        "artifact_id": null
    }))
}

fn spawn_command(
    command: &str,
    cwd: &Path,
    interactive: bool,
    stream_capacity: usize,
) -> Result<SpawnedCommand, TelechirError> {
    let mut process = shell_command(command)?;
    process.current_dir(cwd);
    process.env_clear();
    copy_safe_environment(&mut process);
    process.stdin(if interactive {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    process.stdout(Stdio::piped());
    process.stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }

    let mut child = process.spawn().map_err(|source| {
        process_io_error(
            ErrorCode::InternalError,
            "authorized command could not be started",
            source,
        )
    })?;
    let stdin = child.stdin.take();
    let stdout_pipe = child.stdout.take().ok_or_else(|| {
        error(
            ErrorCode::InternalError,
            "managed process stdout pipe was not created",
        )
    })?;
    let stderr_pipe = child.stderr.take().ok_or_else(|| {
        error(
            ErrorCode::InternalError,
            "managed process stderr pipe was not created",
        )
    })?;

    let stdout = Arc::new(Mutex::new(ByteRing::new(stream_capacity)));
    let stderr = Arc::new(Mutex::new(ByteRing::new(stream_capacity)));
    let stdout_thread = spawn_capture(stdout_pipe, Arc::clone(&stdout));
    let stderr_thread = spawn_capture(stderr_pipe, Arc::clone(&stderr));

    Ok(SpawnedCommand {
        child,
        stdin,
        stdout,
        stderr,
        stdout_thread,
        stderr_thread,
    })
}

fn spawn_capture<R>(mut reader: R, target: Arc<Mutex<ByteRing>>) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if let Ok(mut ring) = target.lock() {
                        ring.push(&buffer[..read]);
                    } else {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    })
}

#[cfg(windows)]
fn shell_command(command: &str) -> Result<Command, TelechirError> {
    let system_root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .ok_or_else(|| {
            error(
                ErrorCode::InternalError,
                "Windows system root is unavailable",
            )
        })?;
    let shell = PathBuf::from(system_root).join("System32").join("cmd.exe");
    let mut process = Command::new(shell);
    process.args(["/D", "/S", "/C", command]);
    Ok(process)
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> Result<Command, TelechirError> {
    let mut process = Command::new("/bin/sh");
    process.args(["-c", command]);
    Ok(process)
}

fn copy_safe_environment(command: &mut Command) {
    #[cfg(windows)]
    const SAFE_ENV: &[&str] = &[
        "SystemRoot",
        "WINDIR",
        "PATH",
        "PATHEXT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "JAVA_HOME",
        "MAVEN_HOME",
        "GRADLE_HOME",
    ];

    #[cfg(not(windows))]
    const SAFE_ENV: &[&str] = &[
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "TERM",
        "JAVA_HOME",
        "MAVEN_HOME",
        "GRADLE_HOME",
        "CARGO_HOME",
        "RUSTUP_HOME",
    ];

    for name in SAFE_ENV {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

#[cfg(unix)]
fn terminate_process_tree(child: &mut Child, force: bool) -> Result<(), TelechirError> {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    let pid = i32::try_from(child.id()).map_err(|_| {
        error(
            ErrorCode::InternalError,
            "managed process identifier cannot be represented on this platform",
        )
    })?;
    let group = Pid::from_raw(pid);
    let first = if force {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    let _ = killpg(group, first);

    if !force {
        let deadline = Instant::now() + GRACEFUL_TERMINATION_WAIT;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => thread::sleep(WAIT_POLL),
                Err(source) => {
                    return Err(process_io_error(
                        ErrorCode::InternalError,
                        "managed process termination state cannot be read",
                        source,
                    ));
                }
            }
        }
        let _ = killpg(group, Signal::SIGKILL);
    }

    child.wait().map(|_| ()).map_err(|source| {
        process_io_error(
            ErrorCode::InternalError,
            "managed process could not be reaped after termination",
            source,
        )
    })
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child, force: bool) -> Result<(), TelechirError> {
    let system_root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .ok_or_else(|| {
            error(
                ErrorCode::InternalError,
                "Windows system root is unavailable",
            )
        })?;
    let taskkill = PathBuf::from(system_root)
        .join("System32")
        .join("taskkill.exe");
    let child_pid = child.id().to_string();

    let terminate = |hard: bool| -> std::io::Result<std::process::ExitStatus> {
        let mut command = Command::new(&taskkill);
        command.env_clear();
        copy_safe_environment(&mut command);
        command.arg("/PID").arg(&child_pid).arg("/T");
        if hard {
            command.arg("/F");
        }
        command.status()
    };

    let _ = terminate(force);
    if !force {
        let deadline = Instant::now() + GRACEFUL_TERMINATION_WAIT;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => thread::sleep(WAIT_POLL),
                Err(source) => {
                    return Err(process_io_error(
                        ErrorCode::InternalError,
                        "managed process termination state cannot be read",
                        source,
                    ));
                }
            }
        }
        let _ = terminate(true);
    }

    match child.wait() {
        Ok(_) => Ok(()),
        Err(_) => {
            child.kill().map_err(|source| {
                process_io_error(
                    ErrorCode::InternalError,
                    "managed process could not be terminated",
                    source,
                )
            })?;
            child.wait().map(|_| ()).map_err(|source| {
                process_io_error(
                    ErrorCode::InternalError,
                    "managed process could not be reaped after termination",
                    source,
                )
            })
        }
    }
}

fn classify_safe_command(command: &str, approval_verified: bool) -> Result<(), TelechirError> {
    let trimmed = command.trim();
    if trimmed.is_empty() || command.len() > MAX_COMMAND_BYTES || command.contains('\0') {
        return Err(error(
            ErrorCode::InvalidArgument,
            "shell command must contain 1..32768 bytes without NUL",
        ));
    }

    let lower = trimmed.to_ascii_lowercase();
    const HARD_DENY_FRAGMENTS: &[&str] = &[
        "\n", "\r", "&", "||", ";", "|", ">", "<", "`", "$", "^", "%", "*", "?", "[", "]", "{",
        "}", "(", ")", "~",
    ];
    if HARD_DENY_FRAGMENTS
        .iter()
        .any(|fragment| trimmed.contains(fragment))
    {
        return Err(error(
            ErrorCode::PolicyDenied,
            "SHELL_SAFE forbids chaining, redirection, expansion, and obfuscated shell syntax",
        ));
    }

    let words = lower.split_whitespace().collect::<Vec<_>>();
    let executable = words.first().copied().unwrap_or_default();
    let executable = executable.trim_matches(['"', '\'']);
    if executable.contains('/') || executable.contains('\\') {
        return Err(error(
            ErrorCode::PolicyDenied,
            "command paths require SHELL_FULL, which remains outside the Phase 9 authority ceiling",
        ));
    }
    let executable = executable
        .strip_suffix(".exe")
        .or_else(|| executable.strip_suffix(".cmd"))
        .or_else(|| executable.strip_suffix(".bat"))
        .unwrap_or(executable);

    const HARD_DENY_EXECUTABLES: &[&str] = &[
        "sudo",
        "doas",
        "pkexec",
        "runas",
        "cmd",
        "powershell",
        "pwsh",
        "sh",
        "bash",
        "zsh",
        "fish",
        "curl",
        "wget",
        "ssh",
        "scp",
        "sftp",
        "nc",
        "ncat",
        "netcat",
        "git",
        "pip",
        "pip3",
        "apt",
        "apt-get",
        "dnf",
        "yum",
        "pacman",
        "brew",
        "choco",
        "winget",
    ];
    if HARD_DENY_EXECUTABLES.contains(&executable) {
        return Err(error(
            ErrorCode::PolicyDenied,
            "command is blocked by local shell hard rules",
        ));
    }

    let args = &words[1..];
    validate_safe_arguments(args)?;

    let allowed = match executable {
        "echo" | "sleep" => true,
        "mvn" | "mvnw" => has_allowed_verb(args, &["test", "verify"]),
        "gradle" | "gradlew" => has_allowed_verb(args, &["test", "check"]),
        "cargo" => has_allowed_verb(args, &["test", "check", "clippy", "fmt"]),
        "npm" | "pnpm" | "yarn" => has_allowed_verb(args, &["test"]),
        "go" | "dotnet" => has_allowed_verb(args, &["test"]),
        "pytest" => true,
        _ => false,
    };

    if !allowed && !approval_verified {
        return Err(error(
            ErrorCode::ApprovalRequired,
            "command is outside the default SHELL_SAFE allowlist and requires a bound Phase 9 approval",
        ));
    }
    Ok(())
}

fn validate_safe_arguments(args: &[&str]) -> Result<(), TelechirError> {
    const WORKSPACE_OVERRIDE_FLAGS: &[&str] = &[
        "-f",
        "-p",
        "--file",
        "--settings",
        "--global-settings",
        "--project-dir",
        "--build-file",
        "--manifest-path",
        "--prefix",
        "--cwd",
        "--project",
        "--rootdir",
    ];

    for argument in args {
        let normalized = argument.trim_matches(['"', '\'']).to_ascii_lowercase();
        if WORKSPACE_OVERRIDE_FLAGS.contains(&normalized.as_str())
            || WORKSPACE_OVERRIDE_FLAGS
                .iter()
                .any(|flag| normalized.starts_with(&format!("{flag}=")))
        {
            return Err(error(
                ErrorCode::PolicyDenied,
                "SHELL_SAFE forbids command arguments that override the authorized workspace",
            ));
        }

        let candidate = Path::new(&normalized);
        if candidate.is_absolute()
            || candidate
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
            || looks_like_windows_absolute_path(&normalized)
            || normalized.starts_with(r"\\")
        {
            return Err(error(
                ErrorCode::PolicyDenied,
                "SHELL_SAFE command arguments must remain relative to the authorized workspace",
            ));
        }
    }
    Ok(())
}

fn looks_like_windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

fn has_allowed_verb(args: &[&str], allowed: &[&str]) -> bool {
    args.iter()
        .filter(|arg| !arg.starts_with('-'))
        .any(|arg| allowed.contains(arg))
}

fn reject_env_refs(env_refs: &[String]) -> Result<(), TelechirError> {
    if env_refs.len() > 20 {
        return Err(error(
            ErrorCode::InvalidArgument,
            "env_refs cannot contain more than 20 references",
        ));
    }
    if !env_refs.is_empty() {
        return Err(error(
            ErrorCode::UnsupportedCapability,
            "env_refs require the future local secret/config broker and fail closed",
        ));
    }
    Ok(())
}

fn require_permission(
    request: &CommandRequest,
    permission: PermissionDomain,
) -> Result<(), TelechirError> {
    if !request.requested_permissions.contains(&permission) {
        return Err(error(
            ErrorCode::PolicyDenied,
            format!(
                "required local permission {} was not requested",
                permission.as_str()
            ),
        ));
    }
    Ok(())
}

fn require_medium_risk(request: &CommandRequest) -> Result<(), TelechirError> {
    if request.risk == RiskLevel::Low {
        return Err(error(
            ErrorCode::PolicyDenied,
            "process side effects must be classified at least MEDIUM",
        ));
    }
    Ok(())
}

fn parse_arguments<T>(arguments: &Map<String, Value>) -> Result<T, TelechirError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(Value::Object(arguments.clone())).map_err(|_| {
        error(
            ErrorCode::InvalidArgument,
            "process command arguments do not match the operation contract",
        )
    })
}

fn request_digest(request: &CommandRequest) -> Result<String, TelechirError> {
    let value = json!({
        "operation": request.operation.as_str(),
        "arguments": request.arguments,
        "permissions": request
            .requested_permissions
            .iter()
            .map(|permission| permission.as_str())
            .collect::<Vec<_>>(),
        "risk": request.risk.as_str()
    });
    let encoded = serde_json::to_vec(&value).map_err(|_| {
        error(
            ErrorCode::InternalError,
            "process command digest could not be encoded",
        )
    })?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn encode_cursor(cursor: OutputCursor) -> Result<String, TelechirError> {
    let encoded = serde_json::to_vec(&cursor).map_err(|_| {
        error(
            ErrorCode::InternalError,
            "process output cursor could not be encoded",
        )
    })?;
    Ok(URL_SAFE_NO_PAD.encode(encoded))
}

fn decode_cursor(value: Option<&str>) -> Result<OutputCursor, TelechirError> {
    let Some(value) = value else {
        return Ok(OutputCursor {
            stdout: 0,
            stderr: 0,
        });
    };
    let decoded = URL_SAFE_NO_PAD.decode(value).map_err(|_| {
        error(
            ErrorCode::InvalidArgument,
            "process output cursor is invalid",
        )
    })?;
    serde_json::from_slice(&decoded).map_err(|_| {
        error(
            ErrorCode::InvalidArgument,
            "process output cursor is invalid",
        )
    })
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

fn process_io_error(
    code: ErrorCode,
    public_message: &'static str,
    source: std::io::Error,
) -> TelechirError {
    TelechirError {
        code,
        message: public_message.to_owned(),
        retryable: source.kind() == std::io::ErrorKind::Interrupted,
        retry_after_ms: None,
        details: None,
    }
}

impl Drop for ProcessExecutor {
    fn drop(&mut self) {
        for process in self.processes.values_mut() {
            let _ = process.refresh();
            if !process.state.terminal() {
                let _ = terminate_process_tree(&mut process.child, true);
                process.settle_capture_threads(Duration::from_millis(50));
                process.state = ManagedProcessState::Cancelled;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::fs;

    use serde_json::{Map, Value, json};
    use tempfile::TempDir;

    use super::*;

    fn setup() -> (TempDir, ProcessExecutor) {
        let root = tempfile::tempdir().unwrap();
        let filesystem = FilesystemPolicy::new([root.path()]).unwrap();
        (root, ProcessExecutor::new(ProcessPolicy::new(filesystem)))
    }

    #[cfg(unix)]
    fn wait_until_terminal(executor: &mut ProcessExecutor, process_id: &str) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let terminal = {
                let process = executor
                    .processes
                    .get_mut(process_id)
                    .expect("managed process must exist");
                process.refresh().expect("managed process must refresh");
                process.state.terminal()
            };
            if terminal {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "managed process did not reach a terminal state before the test deadline"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(target_os = "linux")]
    fn unix_test_process_is_running(pid: i32) -> bool {
        use nix::sys::signal::kill;
        use nix::unistd::Pid;

        if kill(Pid::from_raw(pid), None).is_err() {
            return false;
        }

        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        let Some((_, tail)) = stat.rsplit_once(") ") else {
            return true;
        };
        !tail.starts_with("Z ")
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    fn unix_test_process_is_running(pid: i32) -> bool {
        use nix::sys::signal::kill;
        use nix::unistd::Pid;

        kill(Pid::from_raw(pid), None).is_ok()
    }

    fn request(
        operation: CommandOperation,
        arguments: Value,
        permissions: &[PermissionDomain],
        risk: RiskLevel,
        idempotency_key: Option<&str>,
    ) -> CommandRequest {
        CommandRequest {
            command_id: format!("cmd_{}", Uuid::new_v4()),
            idempotency_key: idempotency_key.map(str::to_owned),
            operation,
            arguments: arguments.as_object().cloned().unwrap_or_else(Map::new),
            requested_permissions: permissions.to_vec(),
            risk,
            workspace_id: None,
            approval_id: None,
        }
    }

    fn outcome(executor: &mut ProcessExecutor, request: &CommandRequest) -> ExecutionOutcome {
        let result: Result<ExecutionOutcome, Infallible> = executor.execute(request);
        result.unwrap()
    }

    #[cfg(unix)]
    fn completed(executor: &mut ProcessExecutor, request: &CommandRequest) -> Value {
        match outcome(executor, request) {
            ExecutionOutcome::Completed(value) => value,
            ExecutionOutcome::Failed(error) => panic!("unexpected failure: {error:?}"),
        }
    }

    fn failed(executor: &mut ProcessExecutor, request: &CommandRequest) -> TelechirError {
        match outcome(executor, request) {
            ExecutionOutcome::Completed(value) => panic!("unexpected success: {value}"),
            ExecutionOutcome::Failed(error) => error,
        }
    }

    #[test]
    fn shell_safe_classifier_is_fail_closed_and_approval_bounded() {
        assert!(classify_safe_command("echo telechir", false).is_ok());
        assert!(classify_safe_command("cargo test --all-features", false).is_ok());
        assert_eq!(
            classify_safe_command("echo ok && whoami", false)
                .unwrap_err()
                .code,
            ErrorCode::PolicyDenied
        );
        assert_eq!(
            classify_safe_command("echo ok & sleep 30", false)
                .unwrap_err()
                .code,
            ErrorCode::PolicyDenied
        );
        assert_eq!(
            classify_safe_command("echo /*", false).unwrap_err().code,
            ErrorCode::PolicyDenied
        );
        assert_eq!(
            classify_safe_command("cargo test --manifest-path ../outside/Cargo.toml", false,)
                .unwrap_err()
                .code,
            ErrorCode::PolicyDenied
        );
        assert_eq!(
            classify_safe_command("mvn -f /tmp/outside.xml test", false)
                .unwrap_err()
                .code,
            ErrorCode::PolicyDenied
        );
        assert_eq!(
            classify_safe_command("sudo echo ok", false)
                .unwrap_err()
                .code,
            ErrorCode::PolicyDenied
        );
        assert_eq!(
            classify_safe_command("python tool.py", false)
                .unwrap_err()
                .code,
            ErrorCode::ApprovalRequired
        );
        assert!(classify_safe_command("python tool.py", true).is_ok());
        assert_eq!(
            classify_safe_command("git status", true).unwrap_err().code,
            ErrorCode::PolicyDenied
        );
        assert_eq!(
            classify_safe_command("./tool", true).unwrap_err().code,
            ErrorCode::PolicyDenied
        );
    }

    #[test]
    fn env_refs_fail_closed_until_secret_broker_exists() {
        assert_eq!(
            reject_env_refs(&["secret://example".to_owned()])
                .unwrap_err()
                .code,
            ErrorCode::UnsupportedCapability
        );
    }

    #[test]
    fn byte_ring_is_bounded_and_reports_dropped_prefix() {
        let mut ring = ByteRing::new(4);
        ring.push(b"abcdef");
        let read = ring.read_from(0, 10);
        assert_eq!(read.data, b"cdef");
        assert!(read.skipped);
        assert_eq!(read.next_offset, 6);
        assert!(ring.ever_dropped);
    }

    #[test]
    fn cwd_outside_local_root_is_denied() {
        let (root, mut executor) = setup();
        let outside = tempfile::tempdir().unwrap();
        let req = request(
            CommandOperation::ProcessStart,
            json!({
                "command":"sleep 1",
                "cwd":outside.path().to_string_lossy()
            }),
            &[
                PermissionDomain::ShellSafe,
                PermissionDomain::ProcessControl,
            ],
            RiskLevel::Medium,
            Some("idem_outside_cwd"),
        );
        assert_eq!(failed(&mut executor, &req).code, ErrorCode::PolicyDenied);
        assert!(root.path().exists());
    }

    #[test]
    fn sensitive_cwd_is_denied() {
        let (root, mut executor) = setup();
        fs::create_dir(root.path().join(".ssh")).unwrap();
        let req = request(
            CommandOperation::ProcessStart,
            json!({"command":"sleep 1","cwd":".ssh"}),
            &[
                PermissionDomain::ShellSafe,
                PermissionDomain::ProcessControl,
            ],
            RiskLevel::Medium,
            Some("idem_sensitive_cwd"),
        );
        assert_eq!(failed(&mut executor, &req).code, ErrorCode::PolicyDenied);
    }

    #[cfg(unix)]
    #[test]
    fn short_command_completes_and_timeout_is_structured() {
        let (_root, mut executor) = setup();
        let echo = request(
            CommandOperation::ShellExec,
            json!({"command":"echo telechir","timeout_seconds":2}),
            &[PermissionDomain::ShellSafe],
            RiskLevel::Medium,
            Some("idem_run_echo"),
        );
        let output = completed(&mut executor, &echo);
        assert_eq!(output["exit_code"], 0);
        assert!(output["stdout"].as_str().unwrap().contains("telechir"));

        let timeout = request(
            CommandOperation::ShellExec,
            json!({"command":"sleep 2","timeout_seconds":1}),
            &[PermissionDomain::ShellSafe],
            RiskLevel::Medium,
            Some("idem_run_timeout"),
        );
        assert_eq!(failed(&mut executor, &timeout).code, ErrorCode::Timeout);
    }

    #[cfg(unix)]
    #[test]
    fn process_start_is_non_blocking_idempotent_and_listed() {
        let (_root, mut executor) = setup();
        let req = request(
            CommandOperation::ProcessStart,
            json!({"command":"sleep 2"}),
            &[
                PermissionDomain::ShellSafe,
                PermissionDomain::ProcessControl,
            ],
            RiskLevel::Medium,
            Some("idem_start_process"),
        );

        let started_at = Instant::now();
        let first = completed(&mut executor, &req);
        assert!(started_at.elapsed() < Duration::from_secs(1));
        assert_eq!(first["state"], "running");

        let replay = completed(&mut executor, &req);
        assert_eq!(replay, first);

        let list = completed(
            &mut executor,
            &request(
                CommandOperation::ProcessList,
                json!({}),
                &[PermissionDomain::ProcessControl],
                RiskLevel::Low,
                None,
            ),
        );
        assert_eq!(list["processes"].as_array().unwrap().len(), 1);

        let conflict = request(
            CommandOperation::ProcessStart,
            json!({"command":"sleep 3"}),
            &[
                PermissionDomain::ShellSafe,
                PermissionDomain::ProcessControl,
            ],
            RiskLevel::Medium,
            Some("idem_start_process"),
        );
        assert_eq!(
            failed(&mut executor, &conflict).code,
            ErrorCode::IdempotencyConflict
        );
    }

    #[cfg(unix)]
    #[test]
    fn process_output_cursor_and_terminal_state_survive_original_request() {
        let (_root, mut executor) = setup();
        let spawned =
            spawn_command("echo first; echo second", Path::new("/tmp"), false, 1024).unwrap();
        let process_id = format!("proc_{}", Uuid::new_v4());
        let started_at = Utc::now();
        executor.process_order.push_back(process_id.clone());
        executor.processes.insert(
            process_id.clone(),
            ManagedProcess {
                process_id: process_id.clone(),
                cwd: PathBuf::from("/tmp"),
                started_at,
                child: spawned.child,
                stdin: spawned.stdin,
                stdout: spawned.stdout,
                stderr: spawned.stderr,
                stdout_thread: Some(spawned.stdout_thread),
                stderr_thread: Some(spawned.stderr_thread),
                state: ManagedProcessState::Running,
                exit_code: None,
            },
        );
        wait_until_terminal(&mut executor, &process_id);

        let first = completed(
            &mut executor,
            &request(
                CommandOperation::ProcessRead,
                json!({"process_id":process_id,"max_bytes":5}),
                &[PermissionDomain::ProcessControl],
                RiskLevel::Low,
                None,
            ),
        );
        assert!(first["next_cursor"].is_string() || first["next_cursor"].is_null());

        let second = completed(
            &mut executor,
            &request(
                CommandOperation::ProcessRead,
                json!({
                    "process_id":process_id,
                    "cursor":first["next_cursor"].as_str(),
                    "max_bytes":65536
                }),
                &[PermissionDomain::ProcessControl],
                RiskLevel::Low,
                None,
            ),
        );
        let combined = format!(
            "{}{}{}{}",
            first["stdout"].as_str().unwrap_or_default(),
            first["stderr"].as_str().unwrap_or_default(),
            second["stdout"].as_str().unwrap_or_default(),
            second["stderr"].as_str().unwrap_or_default()
        );
        assert!(combined.contains("first"));
        assert!(combined.contains("second"));
    }

    #[cfg(unix)]
    #[test]
    fn stdin_is_bounded_and_cancel_is_idempotent() {
        let (_root, mut executor) = setup();
        let spawned = spawn_command(
            "read value; echo got:$value; sleep 5",
            Path::new("/tmp"),
            true,
            1024,
        )
        .unwrap();
        let process_id = format!("proc_{}", Uuid::new_v4());
        executor.process_order.push_back(process_id.clone());
        executor.processes.insert(
            process_id.clone(),
            ManagedProcess {
                process_id: process_id.clone(),
                cwd: PathBuf::from("/tmp"),
                started_at: Utc::now(),
                child: spawned.child,
                stdin: spawned.stdin,
                stdout: spawned.stdout,
                stderr: spawned.stderr,
                stdout_thread: Some(spawned.stdout_thread),
                stderr_thread: Some(spawned.stderr_thread),
                state: ManagedProcessState::Running,
                exit_code: None,
            },
        );

        let write = request(
            CommandOperation::ProcessWrite,
            json!({"process_id":process_id,"input":"hello","append_newline":true}),
            &[PermissionDomain::ProcessControl],
            RiskLevel::Medium,
            Some("idem_stdin_write"),
        );
        assert_eq!(completed(&mut executor, &write)["accepted"], true);
        assert_eq!(completed(&mut executor, &write)["accepted"], true);

        let too_large = request(
            CommandOperation::ProcessWrite,
            json!({"process_id":process_id,"input":"x".repeat(MAX_PROCESS_INPUT_BYTES + 1)}),
            &[PermissionDomain::ProcessControl],
            RiskLevel::Medium,
            Some("idem_stdin_large"),
        );
        assert_eq!(
            failed(&mut executor, &too_large).code,
            ErrorCode::InvalidArgument
        );

        let cancel = request(
            CommandOperation::ProcessCancel,
            json!({"process_id":process_id,"force":true}),
            &[PermissionDomain::ProcessControl],
            RiskLevel::Medium,
            Some("idem_cancel_process"),
        );
        assert_eq!(completed(&mut executor, &cancel)["state"], "cancelled");
        assert_eq!(completed(&mut executor, &cancel)["state"], "cancelled");

        let cancel_again = request(
            CommandOperation::ProcessCancel,
            json!({"process_id":process_id,"force":true}),
            &[PermissionDomain::ProcessControl],
            RiskLevel::Medium,
            Some("idem_cancel_again"),
        );
        assert_eq!(
            completed(&mut executor, &cancel_again)["state"],
            "already_finished"
        );
    }

    #[cfg(unix)]
    #[test]
    fn concurrency_ceiling_prevents_unbounded_children() {
        let (_root, mut executor) = setup();
        for index in 0..MAX_CONCURRENT_PROCESSES {
            let request = request(
                CommandOperation::ProcessStart,
                json!({"command":"sleep 5"}),
                &[
                    PermissionDomain::ShellSafe,
                    PermissionDomain::ProcessControl,
                ],
                RiskLevel::Medium,
                Some(&format!("idem_concurrency_{index:02}")),
            );
            completed(&mut executor, &request);
        }

        let overflow = request(
            CommandOperation::ProcessStart,
            json!({"command":"sleep 5"}),
            &[
                PermissionDomain::ShellSafe,
                PermissionDomain::ProcessControl,
            ],
            RiskLevel::Medium,
            Some("idem_concurrency_overflow"),
        );
        assert_eq!(
            failed(&mut executor, &overflow).code,
            ErrorCode::RateLimited
        );
    }

    #[cfg(unix)]
    #[test]
    fn short_command_output_is_bounded_and_truncated() {
        let (_root, mut executor) = setup();
        let command = format!("echo {}", "x".repeat(SHORT_COMMAND_STREAM_BYTES + 4096));
        let req = request(
            CommandOperation::ShellExec,
            json!({"command":command,"timeout_seconds":2}),
            &[PermissionDomain::ShellSafe],
            RiskLevel::Medium,
            Some("idem_run_large_output"),
        );

        let output = completed(&mut executor, &req);
        assert_eq!(output["exit_code"], 0);
        assert_eq!(output["truncated"], true);
        assert!(output["stdout"].as_str().unwrap().len() <= SHORT_COMMAND_STREAM_BYTES);
    }

    #[cfg(unix)]
    #[test]
    fn process_input_after_terminal_state_is_rejected() {
        let (_root, mut executor) = setup();
        let spawned = spawn_command("echo done", Path::new("/tmp"), true, 1024).unwrap();
        let process_id = format!("proc_{}", Uuid::new_v4());
        executor.process_order.push_back(process_id.clone());
        executor.processes.insert(
            process_id.clone(),
            ManagedProcess {
                process_id: process_id.clone(),
                cwd: PathBuf::from("/tmp"),
                started_at: Utc::now(),
                child: spawned.child,
                stdin: spawned.stdin,
                stdout: spawned.stdout,
                stderr: spawned.stderr,
                stdout_thread: Some(spawned.stdout_thread),
                stderr_thread: Some(spawned.stderr_thread),
                state: ManagedProcessState::Running,
                exit_code: None,
            },
        );
        wait_until_terminal(&mut executor, &process_id);

        let write = request(
            CommandOperation::ProcessWrite,
            json!({"process_id":process_id,"input":"late","append_newline":true}),
            &[PermissionDomain::ProcessControl],
            RiskLevel::Medium,
            Some("idem_late_stdin"),
        );
        assert_eq!(failed(&mut executor, &write).code, ErrorCode::Conflict);
    }

    #[test]
    fn permission_widening_is_denied_locally() {
        let (_root, mut executor) = setup();
        let req = request(
            CommandOperation::ShellExec,
            json!({"command":"echo safe"}),
            &[PermissionDomain::ShellSafe, PermissionDomain::Network],
            RiskLevel::Medium,
            Some("idem_network_widening"),
        );
        assert_eq!(failed(&mut executor, &req).code, ErrorCode::PolicyDenied);
    }

    #[cfg(unix)]
    #[test]
    fn force_cancel_terminates_descendants_in_the_managed_process_group() {
        let (_root, mut executor) = setup();
        let spawned = spawn_command(
            "sleep 30 & child=$!; echo $child; wait",
            Path::new("/tmp"),
            true,
            1024,
        )
        .unwrap();
        let process_id = format!("proc_{}", Uuid::new_v4());
        let stdout = Arc::clone(&spawned.stdout);
        executor.process_order.push_back(process_id.clone());
        executor.processes.insert(
            process_id.clone(),
            ManagedProcess {
                process_id: process_id.clone(),
                cwd: PathBuf::from("/tmp"),
                started_at: Utc::now(),
                child: spawned.child,
                stdin: spawned.stdin,
                stdout: spawned.stdout,
                stderr: spawned.stderr,
                stdout_thread: Some(spawned.stdout_thread),
                stderr_thread: Some(spawned.stderr_thread),
                state: ManagedProcessState::Running,
                exit_code: None,
            },
        );

        let child_pid = {
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                let text = stdout.lock().unwrap().snapshot().0;
                if let Ok(value) = String::from_utf8_lossy(&text).trim().parse::<i32>() {
                    break value;
                }
                assert!(Instant::now() < deadline, "child pid was not captured");
                thread::sleep(Duration::from_millis(10));
            }
        };

        let cancel = request(
            CommandOperation::ProcessCancel,
            json!({"process_id":process_id,"force":true}),
            &[PermissionDomain::ProcessControl],
            RiskLevel::Medium,
            Some("idem_tree_cancel"),
        );
        assert_eq!(completed(&mut executor, &cancel)["state"], "cancelled");

        let deadline = Instant::now() + Duration::from_secs(1);
        while unix_test_process_is_running(child_pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!unix_test_process_is_running(child_pid));
    }

    #[test]
    fn phase8_git_operations_remain_unavailable() {
        let (_root, mut executor) = setup();
        let req = request(
            CommandOperation::GitStatus,
            json!({}),
            &[PermissionDomain::ProcessControl],
            RiskLevel::Low,
            None,
        );
        assert_eq!(
            failed(&mut executor, &req).code,
            ErrorCode::UnsupportedCapability
        );
    }
}
