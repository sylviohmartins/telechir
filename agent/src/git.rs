use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::filesystem::FilesystemPolicy;
use crate::ports::{CommandExecutor, ExecutionOutcome};
use crate::protocol::{
    CommandOperation, CommandRequest, ErrorCode, PermissionDomain, RiskLevel, TelechirError,
};

pub const GIT_CAPABILITIES: [&str; 2] = ["git.status", "git.diff"];
pub const PUBLIC_MAX_GIT_DIFF_BYTES: usize = 262_144;
pub const MAX_INLINE_GIT_DIFF_BYTES: usize = 176 * 1024;
pub const DEFAULT_GIT_DIFF_BYTES: usize = 131_072;
pub const MAX_GIT_STATUS_BYTES: usize = 512 * 1024;
pub const MAX_GIT_STATUS_FILES: usize = 10_000;
pub const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug)]
struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
    capacity: usize,
}

impl Capture {
    fn new(capacity: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity.min(64 * 1024)),
            truncated: false,
            capacity,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        let remaining = self.capacity.saturating_sub(self.bytes.len());
        let take = remaining.min(chunk.len());
        self.bytes.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            self.truncated = true;
        }
    }
}

#[derive(Debug)]
struct GitCommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stdout_truncated: bool,
}

#[derive(Debug, Clone)]
struct RepositoryContext {
    worktree: PathBuf,
    _git_dir: PathBuf,
    _common_dir: PathBuf,
}

#[derive(Debug)]
pub struct GitExecutor {
    policy: FilesystemPolicy,
    git_binary: Option<PathBuf>,
    timeout: Duration,
}

impl GitExecutor {
    pub fn new(policy: FilesystemPolicy) -> Self {
        let git_binary = resolve_git_binary(&policy);
        Self {
            policy,
            git_binary,
            timeout: GIT_COMMAND_TIMEOUT,
        }
    }

    pub fn policy(&self) -> &FilesystemPolicy {
        &self.policy
    }

    fn execute_request(&self, request: &CommandRequest) -> Result<Value, TelechirError> {
        if !matches!(
            request.operation,
            CommandOperation::GitStatus | CommandOperation::GitDiff
        ) {
            return Err(error(
                ErrorCode::UnsupportedCapability,
                "Git executor only implements the Phase 8 read-only operations",
            ));
        }

        require_read_only_git_policy(request)?;

        match request.operation {
            CommandOperation::GitStatus => {
                let input: GitStatusInput = parse_arguments(&request.arguments)?;
                self.git_status(input)
            }
            CommandOperation::GitDiff => {
                let input: GitDiffInput = parse_arguments(&request.arguments)?;
                self.git_diff(input)
            }
            _ => unreachable!("operation was guarded above"),
        }
    }

    fn git_status(&self, input: GitStatusInput) -> Result<Value, TelechirError> {
        let repository = self.resolve_repository(&input.repository_path)?;
        let output = self.run_git(
            &repository.worktree,
            &[
                "status",
                "--porcelain=v1",
                "--branch",
                "--ahead-behind",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=all",
            ],
            MAX_GIT_STATUS_BYTES,
        )?;
        if !output.status.success() {
            return Err(error(
                ErrorCode::Conflict,
                "Git status could not be read from the authorized repository",
            ));
        }
        if output.stdout_truncated {
            return Err(error(
                ErrorCode::OutputTruncated,
                "Git status exceeds the Phase 8 bounded output limit",
            ));
        }

        let parsed = parse_status(&output.stdout)?;
        if parsed.files.len() > MAX_GIT_STATUS_FILES {
            return Err(error(
                ErrorCode::OutputTruncated,
                "Git status contains too many file entries",
            ));
        }

        Ok(json!({
            "branch": parsed.branch,
            "ahead": parsed.ahead,
            "behind": parsed.behind,
            "files": parsed.files
        }))
    }

    fn git_diff(&self, input: GitDiffInput) -> Result<Value, TelechirError> {
        let repository = self.resolve_repository(&input.repository_path)?;
        let requested = input.max_bytes.unwrap_or(DEFAULT_GIT_DIFF_BYTES as u64);
        if requested == 0 || requested > PUBLIC_MAX_GIT_DIFF_BYTES as u64 {
            return Err(error(
                ErrorCode::InvalidArgument,
                "git diff max_bytes must be between 1 and 262144",
            ));
        }

        let path = input
            .path
            .as_deref()
            .map(validate_relative_pathspec)
            .transpose()?;
        let effective = (requested as usize).min(MAX_INLINE_GIT_DIFF_BYTES);
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--ignore-submodules=all",
        ];
        if input.staged.unwrap_or(false) {
            args.push("--cached");
        }
        args.push("--");
        if let Some(path) = path.as_deref() {
            args.push(path);
        }

        let output = self.run_git(&repository.worktree, &args, effective)?;
        if !output.status.success() {
            return Err(error(
                ErrorCode::Conflict,
                "Git diff could not be read from the authorized repository",
            ));
        }

        Ok(json!({
            "diff": String::from_utf8_lossy(&output.stdout),
            "truncated": output.stdout_truncated,
            "artifact_id": null
        }))
    }

    fn resolve_repository(&self, input: &str) -> Result<RepositoryContext, TelechirError> {
        let requested = self.policy.resolve_existing(input)?;
        if !requested.is_dir() {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Git repository_path must resolve to a directory",
            ));
        }

        let (worktree, git_dir) = discover_authorized_git_marker(&self.policy, &requested)?;
        let common_dir = resolve_authorized_common_dir(&self.policy, &git_dir)?;
        audit_repository_config(&git_dir, &common_dir)?;

        let reported_git_dir =
            self.run_git(&worktree, &["rev-parse", "--absolute-git-dir"], 16 * 1024)?;
        if !reported_git_dir.status.success() || reported_git_dir.stdout_truncated {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Git metadata directory could not be resolved",
            ));
        }
        let reported_git_dir = output_path(
            &reported_git_dir.stdout,
            "Git metadata directory is invalid",
        )?;
        let reported_git_dir = self
            .policy
            .resolve_existing(reported_git_dir.to_string_lossy().as_ref())?;
        if reported_git_dir != git_dir {
            return Err(error(
                ErrorCode::PolicyDenied,
                "Git metadata resolution changed after local boundary validation",
            ));
        }

        let top = self.run_git(&worktree, &["rev-parse", "--show-toplevel"], 16 * 1024)?;
        if !top.status.success() || top.stdout_truncated {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Git working tree root could not be resolved",
            ));
        }
        let top = output_path(&top.stdout, "Git working tree root is invalid")?;
        let top = self
            .policy
            .resolve_existing(top.to_string_lossy().as_ref())?;
        if top != worktree {
            return Err(error(
                ErrorCode::PolicyDenied,
                "Git working tree root changed after local boundary validation",
            ));
        }

        let common = self.run_git(
            &worktree,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            16 * 1024,
        )?;
        if !common.status.success() || common.stdout_truncated {
            return Err(error(
                ErrorCode::InvalidArgument,
                "Git common metadata directory could not be resolved",
            ));
        }
        let common = output_path(&common.stdout, "Git common metadata directory is invalid")?;
        let reported_common_dir = self
            .policy
            .resolve_existing(common.to_string_lossy().as_ref())?;
        if reported_common_dir != common_dir {
            return Err(error(
                ErrorCode::PolicyDenied,
                "Git common metadata resolution changed after local boundary validation",
            ));
        }

        Ok(RepositoryContext {
            worktree,
            _git_dir: git_dir,
            _common_dir: common_dir,
        })
    }

    fn run_git(
        &self,
        cwd: &Path,
        args: &[&str],
        stdout_limit: usize,
    ) -> Result<GitCommandOutput, TelechirError> {
        let git_binary = self.git_binary.as_ref().ok_or_else(|| {
            error(
                ErrorCode::UnsupportedCapability,
                "Git executable is unavailable outside authorized workspace roots",
            )
        })?;

        let mut command = Command::new(git_binary);
        command
            .current_dir(cwd)
            .env_clear()
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", null_device())
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("LC_ALL", "C")
            .args([
                "--no-pager",
                "--no-optional-locks",
                "--literal-pathspecs",
                "--no-replace-objects",
                "-c",
                "color.ui=false",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                "-c",
                "status.submoduleSummary=false",
                "-c",
                "protocol.allow=never",
                "-c",
                "credential.helper=",
            ])
            .args(["-C", cwd.to_string_lossy().as_ref()])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        copy_required_platform_environment(&mut command);

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        let mut child = command.spawn().map_err(|source| {
            io_error(
                ErrorCode::UnsupportedCapability,
                "Git executable could not be started",
                source,
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            error(
                ErrorCode::InternalError,
                "Git stdout capture could not be created",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            error(
                ErrorCode::InternalError,
                "Git stderr capture could not be created",
            )
        })?;

        let stdout_capture = Arc::new(Mutex::new(Capture::new(stdout_limit)));
        let stderr_capture = Arc::new(Mutex::new(Capture::new(32 * 1024)));
        let stdout_thread = spawn_capture(stdout, Arc::clone(&stdout_capture));
        let stderr_thread = spawn_capture(stderr, Arc::clone(&stderr_capture));

        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10));
                }
                Ok(None) => {
                    terminate_git_tree(&mut child);
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(error(
                        ErrorCode::Timeout,
                        "Git read operation exceeded its local timeout",
                    ));
                }
                Err(source) => {
                    terminate_git_tree(&mut child);
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(io_error(
                        ErrorCode::InternalError,
                        "Git process state could not be read",
                        source,
                    ));
                }
            }
        };

        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        let stdout = stdout_capture
            .lock()
            .map_err(|_| error(ErrorCode::InternalError, "Git stdout lock failed"))?;
        Ok(GitCommandOutput {
            status,
            stdout: stdout.bytes.clone(),
            stdout_truncated: stdout.truncated,
        })
    }

    #[cfg(all(test, unix))]
    #[allow(dead_code)]
    fn with_git_binary_for_tests(
        policy: FilesystemPolicy,
        git_binary: PathBuf,
        timeout: Duration,
    ) -> Self {
        Self {
            policy,
            git_binary: Some(git_binary),
            timeout,
        }
    }
}

fn discover_authorized_git_marker(
    policy: &FilesystemPolicy,
    requested: &Path,
) -> Result<(PathBuf, PathBuf), TelechirError> {
    let boundary = policy
        .roots()
        .iter()
        .filter(|root| requested.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned()
        .ok_or_else(|| {
            error(
                ErrorCode::PolicyDenied,
                "Git repository_path is outside every authorized root",
            )
        })?;

    let mut candidate = requested.to_path_buf();
    loop {
        let marker = candidate.join(".git");
        match fs::symlink_metadata(&marker) {
            Ok(metadata) => {
                if is_link_or_reparse(&metadata) {
                    return Err(error(
                        ErrorCode::PolicyDenied,
                        "Git metadata marker must not be a symlink or reparse point",
                    ));
                }

                let git_dir = if metadata.is_dir() {
                    policy.resolve_existing(marker.to_string_lossy().as_ref())?
                } else if metadata.is_file() {
                    resolve_git_file(policy, &candidate, &marker)?
                } else {
                    return Err(error(
                        ErrorCode::InvalidArgument,
                        "Git metadata marker has an unsupported file type",
                    ));
                };

                if !git_dir.is_dir() {
                    return Err(error(
                        ErrorCode::InvalidArgument,
                        "Git metadata path must resolve to a directory",
                    ));
                }
                return Ok((candidate, git_dir));
            }
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(io_error(
                    ErrorCode::InvalidArgument,
                    "Git metadata marker could not be inspected",
                    source,
                ));
            }
        }

        if candidate == boundary {
            break;
        }
        let parent = candidate.parent().ok_or_else(|| {
            error(
                ErrorCode::PolicyDenied,
                "Git repository discovery reached the authorized root boundary",
            )
        })?;
        if !parent.starts_with(&boundary) {
            break;
        }
        candidate = parent.to_path_buf();
    }

    Err(error(
        ErrorCode::InvalidArgument,
        "Git repository_path is not inside an authorized working tree",
    ))
}

fn resolve_git_file(
    policy: &FilesystemPolicy,
    worktree: &Path,
    marker: &Path,
) -> Result<PathBuf, TelechirError> {
    const MAX_GIT_FILE_BYTES: u64 = 4096;

    let file = File::open(marker).map_err(|source| {
        io_error(
            ErrorCode::InvalidArgument,
            "Git metadata file could not be opened",
            source,
        )
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_GIT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| {
            io_error(
                ErrorCode::InvalidArgument,
                "Git metadata file could not be read",
                source,
            )
        })?;
    if bytes.len() as u64 > MAX_GIT_FILE_BYTES {
        return Err(error(
            ErrorCode::InvalidArgument,
            "Git metadata file exceeds the local boundary limit",
        ));
    }

    let text = std::str::from_utf8(&bytes).map_err(|_| {
        error(
            ErrorCode::InvalidArgument,
            "Git metadata file must be UTF-8",
        )
    })?;
    let line = text.trim();
    let value = line.strip_prefix("gitdir: ").ok_or_else(|| {
        error(
            ErrorCode::InvalidArgument,
            "Git metadata file has an unsupported format",
        )
    })?;
    if value.is_empty() || value.contains('\0') {
        return Err(error(
            ErrorCode::InvalidArgument,
            "Git metadata file contains an invalid gitdir",
        ));
    }

    let path = Path::new(value);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        worktree.join(path)
    };
    policy.resolve_existing(resolved.to_string_lossy().as_ref())
}

fn resolve_authorized_common_dir(
    policy: &FilesystemPolicy,
    git_dir: &Path,
) -> Result<PathBuf, TelechirError> {
    let marker = git_dir.join("commondir");
    let metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(git_dir.to_path_buf());
        }
        Err(source) => {
            return Err(io_error(
                ErrorCode::InvalidArgument,
                "Git common-directory marker could not be inspected",
                source,
            ));
        }
    };

    if is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(error(
            ErrorCode::PolicyDenied,
            "Git common-directory marker must be a regular local file",
        ));
    }

    let value = read_bounded_utf8(&marker, 4096, "Git common-directory marker")?;
    let value = value.trim();
    if value.is_empty() || value.contains('\0') {
        return Err(error(
            ErrorCode::InvalidArgument,
            "Git common-directory marker is invalid",
        ));
    }

    let configured = Path::new(value);
    let resolved = if configured.is_absolute() {
        configured.to_path_buf()
    } else {
        git_dir.join(configured)
    };
    let common = policy.resolve_existing(resolved.to_string_lossy().as_ref())?;
    if !common.is_dir() {
        return Err(error(
            ErrorCode::InvalidArgument,
            "Git common metadata path must resolve to a directory",
        ));
    }
    Ok(common)
}

fn audit_repository_config(git_dir: &Path, common_dir: &Path) -> Result<(), TelechirError> {
    let mut candidates = vec![
        common_dir.join("config"),
        common_dir.join("config.worktree"),
    ];
    if git_dir != common_dir {
        candidates.push(git_dir.join("config"));
        candidates.push(git_dir.join("config.worktree"));
    }

    candidates.sort();
    candidates.dedup();
    for path in candidates {
        audit_git_config_file(&path)?;
    }
    Ok(())
}

fn audit_git_config_file(path: &Path) -> Result<(), TelechirError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(io_error(
                ErrorCode::InvalidArgument,
                "Git config could not be inspected",
                source,
            ));
        }
    };

    if is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(error(
            ErrorCode::PolicyDenied,
            "Git config must be a regular local file",
        ));
    }

    let config = read_bounded_utf8(path, 256 * 1024, "Git config")?;
    let mut section = String::new();

    for raw_line in config.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        if let Some(inner) = line
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
        {
            let name = inner
                .trim()
                .split(|character: char| character.is_ascii_whitespace() || character == '"')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if name == "include" || name == "includeif" {
                return Err(error(
                    ErrorCode::PolicyDenied,
                    "Git config includes are blocked by the Phase 8 local policy",
                ));
            }
            section = name;
            continue;
        }

        let key = line
            .split_once('=')
            .map(|(left, _)| left)
            .unwrap_or_else(|| line.split_ascii_whitespace().next().unwrap_or(line))
            .trim()
            .to_ascii_lowercase();

        let dangerous = match section.as_str() {
            "core" => matches!(
                key.as_str(),
                "fsmonitor" | "hookspath" | "attributesfile" | "excludesfile" | "sshcommand"
            ),
            "diff" => matches!(key.as_str(), "external" | "command" | "textconv"),
            "filter" => matches!(key.as_str(), "clean" | "smudge" | "process"),
            "credential" => key == "helper",
            "include" | "includeif" => true,
            _ => false,
        };

        if dangerous {
            return Err(error(
                ErrorCode::PolicyDenied,
                format!("Git config key {section}.{key} is blocked by the Phase 8 local policy"),
            ));
        }
    }

    Ok(())
}

fn read_bounded_utf8(
    path: &Path,
    max_bytes: u64,
    description: &'static str,
) -> Result<String, TelechirError> {
    let file = File::open(path).map_err(|source| {
        io_error(
            ErrorCode::InvalidArgument,
            "Git metadata file could not be opened",
            source,
        )
    })?;
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| {
            io_error(
                ErrorCode::InvalidArgument,
                "Git metadata file could not be read",
                source,
            )
        })?;

    if bytes.len() as u64 > max_bytes {
        return Err(error(
            ErrorCode::PolicyDenied,
            format!("{description} exceeds the local bounded-read limit"),
        ));
    }

    String::from_utf8(bytes).map_err(|_| {
        error(
            ErrorCode::PolicyDenied,
            format!("{description} must be UTF-8 for safe local auditing"),
        )
    })
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }

    #[cfg(not(windows))]
    false
}

impl CommandExecutor for GitExecutor {
    type Error = std::convert::Infallible;

    fn execute(&mut self, request: &CommandRequest) -> Result<ExecutionOutcome, Self::Error> {
        Ok(match self.execute_request(request) {
            Ok(value) => ExecutionOutcome::Completed(value),
            Err(error) => ExecutionOutcome::Failed(error),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GitStatusInput {
    repository_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GitDiffInput {
    repository_path: String,
    #[serde(default)]
    staged: Option<bool>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    max_bytes: Option<u64>,
}

#[derive(Debug)]
struct ParsedStatus {
    branch: Option<String>,
    ahead: u64,
    behind: u64,
    files: Vec<Value>,
}

fn parse_status(bytes: &[u8]) -> Result<ParsedStatus, TelechirError> {
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut branch = None;
    let mut ahead = 0_u64;
    let mut behind = 0_u64;
    let mut files = Vec::new();

    while let Some(record) = records.next() {
        if record.starts_with(b"## ") {
            let header = String::from_utf8_lossy(&record[3..]);
            let (parsed_branch, parsed_ahead, parsed_behind) = parse_branch_header(&header);
            branch = parsed_branch;
            ahead = parsed_ahead;
            behind = parsed_behind;
            continue;
        }

        if record.len() < 3 || record[2] != b' ' {
            return Err(error(
                ErrorCode::InternalError,
                "Git returned an unsupported status record",
            ));
        }

        let status = String::from_utf8_lossy(&record[..2]).into_owned();
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        files.push(json!({ "path": path, "status": status }));

        if matches!(record[0], b'R' | b'C') || matches!(record[1], b'R' | b'C') {
            let _ = records.next();
        }
    }

    Ok(ParsedStatus {
        branch,
        ahead,
        behind,
        files,
    })
}

fn parse_branch_header(header: &str) -> (Option<String>, u64, u64) {
    let mut ahead = 0_u64;
    let mut behind = 0_u64;

    if let Some(start) = header.rfind(" [")
        && let Some(end) = header.rfind(']')
    {
        for part in header[start + 2..end].split(", ") {
            if let Some(value) = part.strip_prefix("ahead ") {
                ahead = value.parse().unwrap_or(0);
            } else if let Some(value) = part.strip_prefix("behind ") {
                behind = value.parse().unwrap_or(0);
            }
        }
    }

    let name_part = header
        .split("...")
        .next()
        .unwrap_or(header)
        .split(" [")
        .next()
        .unwrap_or(header)
        .trim();

    let branch = if name_part == "HEAD (no branch)" || name_part.starts_with("HEAD ") {
        None
    } else if let Some(name) = name_part.strip_prefix("No commits yet on ") {
        Some(name.to_owned())
    } else if let Some(name) = name_part.strip_prefix("Initial commit on ") {
        Some(name.to_owned())
    } else if name_part.is_empty() {
        None
    } else {
        Some(name_part.to_owned())
    };

    (branch, ahead, behind)
}

fn validate_relative_pathspec(value: &str) -> Result<String, TelechirError> {
    if value.is_empty() || value.contains('\0') {
        return Err(error(
            ErrorCode::InvalidArgument,
            "Git path filter must be a non-empty relative path",
        ));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(error(
            ErrorCode::PolicyDenied,
            "Git path filter cannot escape the authorized repository",
        ));
    }
    Ok(value.to_owned())
}

fn require_read_only_git_policy(request: &CommandRequest) -> Result<(), TelechirError> {
    if request.risk != RiskLevel::Low {
        return Err(error(
            ErrorCode::PolicyDenied,
            "Phase 8 Git read operations must remain LOW risk",
        ));
    }
    if request.requested_permissions != [PermissionDomain::FsRead] {
        return Err(error(
            ErrorCode::PolicyDenied,
            "Phase 8 Git read operations require exactly FS_READ",
        ));
    }
    Ok(())
}

fn resolve_git_binary(policy: &FilesystemPolicy) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        if !directory.is_absolute() {
            continue;
        }

        #[cfg(windows)]
        let candidates = [directory.join("git.exe")];
        #[cfg(not(windows))]
        let candidates = [directory.join("git")];

        for candidate in candidates {
            if !candidate.is_file() {
                continue;
            }
            let Ok(canonical) = std::fs::canonicalize(candidate) else {
                continue;
            };
            if policy
                .roots()
                .iter()
                .any(|root| canonical.starts_with(root))
            {
                continue;
            }
            return Some(canonical);
        }
    }
    None
}

fn output_path(bytes: &[u8], message: &'static str) -> Result<PathBuf, TelechirError> {
    let value = String::from_utf8_lossy(bytes).trim().to_owned();
    if value.is_empty() || value.contains('\0') {
        return Err(error(ErrorCode::InvalidArgument, message));
    }
    Ok(PathBuf::from(value))
}

fn null_device() -> &'static str {
    #[cfg(windows)]
    {
        "NUL"
    }
    #[cfg(not(windows))]
    {
        "/dev/null"
    }
}

fn copy_required_platform_environment(command: &mut Command) {
    #[cfg(windows)]
    const KEYS: &[&str] = &["SystemRoot", "WINDIR", "TEMP", "TMP"];
    #[cfg(not(windows))]
    const KEYS: &[&str] = &["TMPDIR"];

    for key in KEYS {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
}

fn spawn_capture<R>(mut reader: R, target: Arc<Mutex<Capture>>) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let Ok(mut capture) = target.lock() else {
                        break;
                    };
                    capture.push(&buffer[..read]);
                }
                Err(_) => break,
            }
        }
    })
}

#[cfg(unix)]
fn terminate_git_tree(child: &mut Child) {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    if let Ok(pid) = i32::try_from(child.id()) {
        let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(windows)]
fn terminate_git_tree(child: &mut Child) {
    if let Some(system_root) = env::var_os("SystemRoot").or_else(|| env::var_os("WINDIR")) {
        let taskkill = PathBuf::from(system_root)
            .join("System32")
            .join("taskkill.exe");
        let _ = Command::new(taskkill)
            .env_clear()
            .arg("/PID")
            .arg(child.id().to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn parse_arguments<T>(arguments: &Map<String, Value>) -> Result<T, TelechirError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(Value::Object(arguments.clone())).map_err(|_| {
        error(
            ErrorCode::InvalidArgument,
            "Git command arguments do not match the Phase 8 contract",
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

fn io_error(
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

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::fs;
    use std::process::Command;

    use serde_json::Map;
    use tempfile::TempDir;

    use super::*;

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git test setup failed: {args:?}");
    }

    fn init_repo() -> (TempDir, PathBuf, GitExecutor) {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.name", "Telechir Tests"]);
        git(&repo, &["config", "user.email", "telechir@example.invalid"]);
        fs::write(repo.join("tracked.txt"), "base\n").unwrap();
        git(&repo, &["add", "tracked.txt"]);
        git(&repo, &["commit", "-qm", "initial"]);
        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        let executor = GitExecutor::new(policy);
        assert!(executor.git_binary.is_some());
        (root, repo, executor)
    }

    fn request(
        operation: CommandOperation,
        arguments: Value,
        permissions: Vec<PermissionDomain>,
    ) -> CommandRequest {
        CommandRequest {
            command_id: "cmd_git_test".to_owned(),
            idempotency_key: None,
            operation,
            arguments: arguments.as_object().cloned().unwrap_or_else(Map::new),
            requested_permissions: permissions,
            risk: RiskLevel::Low,
            workspace_id: None,
            approval_id: None,
        }
    }

    fn completed(executor: &mut GitExecutor, request: &CommandRequest) -> Value {
        let result: Result<ExecutionOutcome, Infallible> = executor.execute(request);
        match result.unwrap() {
            ExecutionOutcome::Completed(value) => value,
            ExecutionOutcome::Failed(error) => panic!("unexpected Git failure: {error:?}"),
        }
    }

    fn failed(executor: &mut GitExecutor, request: &CommandRequest) -> TelechirError {
        let result: Result<ExecutionOutcome, Infallible> = executor.execute(request);
        match result.unwrap() {
            ExecutionOutcome::Completed(value) => panic!("unexpected Git success: {value}"),
            ExecutionOutcome::Failed(error) => error,
        }
    }

    #[test]
    fn status_reports_dirty_and_untracked_files_without_mutating_index() {
        let (_root, repo, mut executor) = init_repo();
        let index_before = fs::read(repo.join(".git").join("index")).unwrap();
        fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
        fs::write(repo.join("untracked.txt"), "new\n").unwrap();

        let output = completed(
            &mut executor,
            &request(
                CommandOperation::GitStatus,
                json!({"repository_path":repo.to_string_lossy()}),
                vec![PermissionDomain::FsRead],
            ),
        );

        assert!(output["branch"].is_string());
        assert_eq!(output["ahead"], 0);
        assert_eq!(output["behind"], 0);
        let files = output["files"].as_array().unwrap();
        assert!(files.iter().any(|entry| entry["path"] == "tracked.txt"));
        assert!(files.iter().any(|entry| entry["path"] == "untracked.txt"));
        assert_eq!(
            fs::read(repo.join(".git").join("index")).unwrap(),
            index_before
        );
    }

    #[test]
    fn status_from_nested_directory_stays_bound_to_authorized_repository() {
        let (_root, repo, mut executor) = init_repo();
        let nested = repo.join("src").join("nested");
        fs::create_dir_all(&nested).unwrap();

        let output = completed(
            &mut executor,
            &request(
                CommandOperation::GitStatus,
                json!({"repository_path":nested.to_string_lossy()}),
                vec![PermissionDomain::FsRead],
            ),
        );
        assert!(output["branch"].is_string());
    }

    #[test]
    fn linked_worktree_inside_authorized_root_is_supported() {
        let (root, repo, _executor) = init_repo();
        let linked = root.path().join("linked");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "phase8-linked-test",
                linked.to_string_lossy().as_ref(),
            ],
        );

        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        let mut executor = GitExecutor::new(policy);
        let output = completed(
            &mut executor,
            &request(
                CommandOperation::GitStatus,
                json!({"repository_path":linked.to_string_lossy()}),
                vec![PermissionDomain::FsRead],
            ),
        );

        assert_eq!(output["branch"], "phase8-linked-test");
    }

    #[test]
    fn status_reports_ahead_and_behind_against_local_upstream() {
        let (_root, repo, mut executor) = init_repo();
        git(&repo, &["branch", "phase8-baseline", "HEAD"]);
        fs::write(repo.join("tracked.txt"), "ahead\n").unwrap();
        git(&repo, &["add", "tracked.txt"]);
        git(&repo, &["commit", "-qm", "ahead"]);
        git(&repo, &["branch", "--set-upstream-to=phase8-baseline"]);

        let output = completed(
            &mut executor,
            &request(
                CommandOperation::GitStatus,
                json!({"repository_path":repo.to_string_lossy()}),
                vec![PermissionDomain::FsRead],
            ),
        );

        assert_eq!(output["ahead"], 1);
        assert_eq!(output["behind"], 0);
    }

    #[test]
    fn non_repository_and_external_repository_are_denied() {
        let (root, _repo, mut executor) = init_repo();
        let plain = root.path().join("plain");
        fs::create_dir(&plain).unwrap();
        let non_repo = request(
            CommandOperation::GitStatus,
            json!({"repository_path":plain.to_string_lossy()}),
            vec![PermissionDomain::FsRead],
        );
        assert_eq!(
            failed(&mut executor, &non_repo).code,
            ErrorCode::InvalidArgument
        );

        let outside = tempfile::tempdir().unwrap();
        git(outside.path(), &["init", "-q"]);
        let external = request(
            CommandOperation::GitStatus,
            json!({"repository_path":outside.path().to_string_lossy()}),
            vec![PermissionDomain::FsRead],
        );
        assert_eq!(
            failed(&mut executor, &external).code,
            ErrorCode::PolicyDenied
        );
    }

    #[test]
    fn repository_with_git_metadata_outside_root_is_denied() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let worktree = root.path().join("worktree");
        fs::create_dir(&worktree).unwrap();
        let separate = outside.path().join("metadata");
        let status = Command::new("git")
            .args([
                "init",
                "-q",
                "--separate-git-dir",
                separate.to_string_lossy().as_ref(),
                worktree.to_string_lossy().as_ref(),
            ])
            .status()
            .unwrap();
        assert!(status.success());

        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        let mut executor = GitExecutor::new(policy);
        let request = request(
            CommandOperation::GitStatus,
            json!({"repository_path":worktree.to_string_lossy()}),
            vec![PermissionDomain::FsRead],
        );
        assert_eq!(
            failed(&mut executor, &request).code,
            ErrorCode::PolicyDenied
        );
    }

    #[cfg(unix)]
    #[test]
    fn external_gitdir_is_denied_before_any_git_subprocess_runs() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let worktree = root.path().join("worktree");
        fs::create_dir(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", outside.path().display()),
        )
        .unwrap();

        let invocation_marker = root.path().join("git-invoked");
        let fake_git = root.path().join("fake-git");
        fs::write(
            &fake_git,
            format!(
                "#!/bin/sh\necho invoked > '{}'\nexit 0\n",
                invocation_marker.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&fake_git).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_git, permissions).unwrap();

        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        let mut executor =
            GitExecutor::with_git_binary_for_tests(policy, fake_git, Duration::from_secs(1));
        let request = request(
            CommandOperation::GitStatus,
            json!({"repository_path":worktree.to_string_lossy()}),
            vec![PermissionDomain::FsRead],
        );

        assert_eq!(
            failed(&mut executor, &request).code,
            ErrorCode::PolicyDenied
        );
        assert!(!invocation_marker.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_repository_escape_is_denied() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        git(outside.path(), &["init", "-q"]);
        let link = root.path().join("outside-repo");
        symlink(outside.path(), &link).unwrap();

        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        let mut executor = GitExecutor::new(policy);
        let request = request(
            CommandOperation::GitStatus,
            json!({"repository_path":link.to_string_lossy()}),
            vec![PermissionDomain::FsRead],
        );
        assert_eq!(
            failed(&mut executor, &request).code,
            ErrorCode::PolicyDenied
        );
    }

    #[test]
    fn diff_supports_unstaged_staged_and_literal_path_filter() {
        let (_root, repo, mut executor) = init_repo();
        fs::write(repo.join("tracked.txt"), "unstaged\n").unwrap();

        let unstaged = completed(
            &mut executor,
            &request(
                CommandOperation::GitDiff,
                json!({
                    "repository_path":repo.to_string_lossy(),
                    "staged":false,
                    "path":"tracked.txt",
                    "max_bytes":131072
                }),
                vec![PermissionDomain::FsRead],
            ),
        );
        assert!(unstaged["diff"].as_str().unwrap().contains("unstaged"));
        assert_eq!(unstaged["truncated"], false);

        git(&repo, &["add", "tracked.txt"]);
        let staged = completed(
            &mut executor,
            &request(
                CommandOperation::GitDiff,
                json!({
                    "repository_path":repo.to_string_lossy(),
                    "staged":true,
                    "path":"tracked.txt"
                }),
                vec![PermissionDomain::FsRead],
            ),
        );
        assert!(staged["diff"].as_str().unwrap().contains("unstaged"));
    }

    #[test]
    fn diff_path_filter_cannot_escape_repository() {
        let (_root, repo, mut executor) = init_repo();
        let request = request(
            CommandOperation::GitDiff,
            json!({
                "repository_path":repo.to_string_lossy(),
                "path":"../outside.txt"
            }),
            vec![PermissionDomain::FsRead],
        );
        assert_eq!(
            failed(&mut executor, &request).code,
            ErrorCode::PolicyDenied
        );
    }

    #[test]
    fn large_diff_is_bounded_and_marked_truncated() {
        let (_root, repo, mut executor) = init_repo();
        let mut large = String::new();
        for index in 0..40_000 {
            large.push_str(&format!("changed-line-{index:05}\n"));
        }
        fs::write(repo.join("tracked.txt"), large).unwrap();

        let output = completed(
            &mut executor,
            &request(
                CommandOperation::GitDiff,
                json!({
                    "repository_path":repo.to_string_lossy(),
                    "max_bytes":262144
                }),
                vec![PermissionDomain::FsRead],
            ),
        );
        assert_eq!(output["truncated"], true);
        assert!(output["diff"].as_str().unwrap().len() <= MAX_INLINE_GIT_DIFF_BYTES);
    }

    #[test]
    fn git_write_permissions_are_never_accepted_for_phase8_reads() {
        let (_root, repo, mut executor) = init_repo();
        let request = request(
            CommandOperation::GitStatus,
            json!({"repository_path":repo.to_string_lossy()}),
            vec![PermissionDomain::FsRead, PermissionDomain::GitWrite],
        );
        assert_eq!(
            failed(&mut executor, &request).code,
            ErrorCode::PolicyDenied
        );
    }

    #[test]
    fn git_config_audit_blocks_execution_and_external_read_keys() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config");
        let cases = [
            "[include]\npath = ../outside\n",
            "[includeIf \"gitdir:~/work/\"]\npath = ../outside\n",
            "[core]\nfsmonitor = evil\n",
            "[core]\nhooksPath = ../hooks\n",
            "[core]\nattributesFile = ../attrs\n",
            "[core]\nexcludesFile = ../ignore\n",
            "[core]\nsshCommand = evil\n",
            "[diff]\nexternal = evil\n",
            "[diff \"evil\"]\ncommand = evil\n",
            "[diff \"evil\"]\ntextconv = evil\n",
            "[filter \"evil\"]\nclean = evil\n",
            "[filter \"evil\"]\nsmudge = evil\n",
            "[filter \"evil\"]\nprocess = evil\n",
            "[credential]\nhelper = !evil\n",
        ];

        for value in cases {
            fs::write(&config, value).unwrap();
            assert_eq!(
                audit_git_config_file(&config).unwrap_err().code,
                ErrorCode::PolicyDenied,
                "config should be denied: {value}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn malicious_clean_filter_is_denied_before_git_runs() {
        use std::os::unix::fs::PermissionsExt;

        let (_root, repo, mut executor) = init_repo();
        let marker = repo.join("marker.txt");
        let script = repo.join("malicious.sh");
        fs::write(
            &script,
            format!("#!/bin/sh\necho invoked >> '{}'\ncat\n", marker.display()),
        )
        .unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).unwrap();

        git(
            &repo,
            &[
                "config",
                "filter.evil.clean",
                script.to_string_lossy().as_ref(),
            ],
        );
        fs::write(repo.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        fs::write(repo.join("tracked.txt"), "changed\n").unwrap();

        let status = request(
            CommandOperation::GitStatus,
            json!({"repository_path":repo.to_string_lossy()}),
            vec![PermissionDomain::FsRead],
        );
        assert_eq!(failed(&mut executor, &status).code, ErrorCode::PolicyDenied);
        assert!(!marker.exists());
    }

    #[cfg(unix)]
    #[test]
    fn timeout_terminates_unresponsive_git_process_tree() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        fs::create_dir(&repo).unwrap();
        fs::create_dir(repo.join(".git")).unwrap();
        let fake = root.path().join("fake-git");
        fs::write(&fake, "#!/bin/sh\nsleep 5\n").unwrap();
        let mut permissions = fs::metadata(&fake).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake, permissions).unwrap();

        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        let mut executor =
            GitExecutor::with_git_binary_for_tests(policy, fake, Duration::from_millis(50));
        let request = request(
            CommandOperation::GitStatus,
            json!({"repository_path":repo.to_string_lossy()}),
            vec![PermissionDomain::FsRead],
        );
        assert_eq!(failed(&mut executor, &request).code, ErrorCode::Timeout);
    }
}
