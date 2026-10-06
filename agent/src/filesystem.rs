use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::{DateTime, Utc};
use diffy::Patch;
use globset::Glob;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use crate::ports::{CommandExecutor, ExecutionOutcome};
use crate::protocol::{
    CommandOperation, CommandRequest, ErrorCode, PermissionDomain, RiskLevel, TelechirError,
};

pub const PUBLIC_MAX_READ_BYTES: usize = 262_144;
pub const FILESYSTEM_CAPABILITIES: [&str; 6] = [
    "fs.list",
    "fs.stat",
    "fs.read",
    "fs.write",
    "fs.patch",
    "fs.search",
];
pub const MAX_INLINE_READ_BYTES: usize = 176 * 1024;
pub const DEFAULT_READ_BYTES: usize = 131_072;
pub const MAX_WRITE_BYTES: usize = 176 * 1024;
pub const MAX_PATCH_BYTES: usize = 192 * 1024;
pub const MAX_SEARCH_RESULTS: usize = 1_000;
pub const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_SEARCH_SCAN_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SEARCH_ENTRIES: usize = 10_000;
pub const SEARCH_TIMEOUT: Duration = Duration::from_secs(2);
pub const MAX_HASH_BYTES: u64 = 64 * 1024 * 1024;
const IDEMPOTENCY_CACHE_SIZE: usize = 1024;

#[derive(Debug, Clone)]
pub struct FilesystemPolicy {
    roots: Vec<PathBuf>,
}

impl FilesystemPolicy {
    pub fn new<I, P>(roots: I) -> Result<Self, TelechirError>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let mut canonical = Vec::new();
        for root in roots {
            let root = fs::canonicalize(root.as_ref()).map_err(|error| {
                fs_error(
                    ErrorCode::InvalidArgument,
                    "allowed filesystem root cannot be canonicalized",
                    Some(error),
                )
            })?;
            if !root.is_dir() {
                return Err(error(
                    ErrorCode::InvalidArgument,
                    "allowed filesystem root must be a directory",
                ));
            }
            if contains_sensitive_component(&root) {
                return Err(error(
                    ErrorCode::PolicyDenied,
                    "allowed filesystem root is blocked by local sensitive-path policy",
                ));
            }
            if !canonical.contains(&root) {
                canonical.push(root);
            }
        }

        Ok(Self { roots: canonical })
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    fn base_for_input(&self, input: &Path) -> Result<PathBuf, TelechirError> {
        if input.is_absolute() {
            return Ok(input.to_path_buf());
        }
        if self.roots.len() != 1 {
            return Err(error(
                ErrorCode::PolicyDenied,
                "relative filesystem paths require exactly one allowed root",
            ));
        }
        Ok(self.roots[0].join(input))
    }

    fn root_for(&self, path: &Path) -> Option<&PathBuf> {
        self.roots.iter().find(|root| path.starts_with(root))
    }

    fn check_sensitive(&self, canonical: &Path) -> Result<(), TelechirError> {
        let Some(root) = self.root_for(canonical) else {
            return Err(error(
                ErrorCode::PolicyDenied,
                "filesystem path is outside every allowed root",
            ));
        };
        let relative = canonical.strip_prefix(root).unwrap_or(canonical);
        if contains_sensitive_component(relative) {
            return Err(error(
                ErrorCode::PolicyDenied,
                "filesystem path is blocked by local sensitive-path policy",
            ));
        }
        Ok(())
    }

    pub(crate) fn resolve_existing(&self, input: &str) -> Result<PathBuf, TelechirError> {
        if self.roots.is_empty() {
            return Err(error(
                ErrorCode::PolicyDenied,
                "filesystem access is disabled because no allowed roots are configured",
            ));
        }
        let requested = self.base_for_input(Path::new(input))?;
        let canonical = fs::canonicalize(&requested).map_err(|error| {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::NotFound
            } else {
                ErrorCode::InvalidArgument
            };
            fs_error(code, "filesystem path cannot be resolved", Some(error))
        })?;
        if self.root_for(&canonical).is_none() {
            return Err(error(
                ErrorCode::PolicyDenied,
                "filesystem path escapes the allowed root",
            ));
        }
        self.check_sensitive(&canonical)?;
        Ok(canonical)
    }

    fn resolve_entry_without_following(&self, input: &str) -> Result<PathBuf, TelechirError> {
        if self.roots.is_empty() {
            return Err(error(
                ErrorCode::PolicyDenied,
                "filesystem access is disabled because no allowed roots are configured",
            ));
        }
        let requested = self.base_for_input(Path::new(input))?;
        let parent = requested.parent().ok_or_else(|| {
            error(
                ErrorCode::InvalidArgument,
                "filesystem path must have a parent directory",
            )
        })?;
        let canonical_parent = fs::canonicalize(parent).map_err(|error| {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::NotFound
            } else {
                ErrorCode::InvalidArgument
            };
            fs_error(code, "filesystem parent cannot be resolved", Some(error))
        })?;
        if self.root_for(&canonical_parent).is_none() {
            return Err(error(
                ErrorCode::PolicyDenied,
                "filesystem parent escapes the allowed root",
            ));
        }
        self.check_sensitive(&canonical_parent)?;
        let name = requested.file_name().ok_or_else(|| {
            error(
                ErrorCode::InvalidArgument,
                "filesystem path must include an entry name",
            )
        })?;
        let candidate = canonical_parent.join(name);
        if contains_sensitive_component(Path::new(name)) {
            return Err(error(
                ErrorCode::PolicyDenied,
                "filesystem path is blocked by local sensitive-path policy",
            ));
        }
        Ok(candidate)
    }

    fn resolve_write_target(&self, input: &str) -> Result<PathBuf, TelechirError> {
        let candidate = self.resolve_entry_without_following(input)?;
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) => {
                if is_link_or_reparse(&metadata) {
                    return Err(error(
                        ErrorCode::PolicyDenied,
                        "write target must not be a symlink or reparse link",
                    ));
                }
                let canonical = fs::canonicalize(&candidate).map_err(|error| {
                    fs_error(
                        ErrorCode::InvalidArgument,
                        "write target cannot be canonicalized",
                        Some(error),
                    )
                })?;
                if self.root_for(&canonical).is_none() {
                    return Err(error(
                        ErrorCode::PolicyDenied,
                        "write target escapes the allowed root",
                    ));
                }
                self.check_sensitive(&canonical)?;
                Ok(canonical)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(candidate),
            Err(error) => Err(fs_error(
                ErrorCode::InvalidArgument,
                "write target metadata cannot be read",
                Some(error),
            )),
        }
    }
}

fn contains_sensitive_component(path: &Path) -> bool {
    path.components().any(|component| {
        let Component::Normal(value) = component else {
            return false;
        };
        let value = value.to_string_lossy().to_ascii_lowercase();
        matches!(
            value.as_str(),
            ".ssh"
                | ".aws"
                | ".gnupg"
                | ".azure"
                | ".kube"
                | ".docker"
                | ".password-store"
                | ".env"
                | ".netrc"
                | ".npmrc"
                | ".pypirc"
                | "id_rsa"
                | "id_dsa"
                | "id_ecdsa"
                | "id_ed25519"
        )
    })
}
#[derive(Debug, Clone)]
struct CachedOutcome {
    digest: String,
    outcome: ExecutionOutcome,
}

#[derive(Debug)]
pub struct FilesystemExecutor {
    policy: FilesystemPolicy,
    idempotency: HashMap<String, CachedOutcome>,
    idempotency_order: VecDeque<String>,
}

impl FilesystemExecutor {
    pub fn new(policy: FilesystemPolicy) -> Self {
        Self {
            policy,
            idempotency: HashMap::new(),
            idempotency_order: VecDeque::new(),
        }
    }

    pub fn policy(&self) -> &FilesystemPolicy {
        &self.policy
    }

    fn execute_request(&mut self, request: &CommandRequest) -> Result<Value, TelechirError> {
        match request.operation {
            CommandOperation::FsList => {
                require_permission(request, PermissionDomain::FsRead)?;
                self.list_files(parse_arguments(&request.arguments)?)
            }
            CommandOperation::FsStat => {
                require_permission(request, PermissionDomain::FsRead)?;
                self.stat_file(parse_arguments(&request.arguments)?)
            }
            CommandOperation::FsRead => {
                require_permission(request, PermissionDomain::FsRead)?;
                self.read_file(parse_arguments(&request.arguments)?)
            }
            CommandOperation::FsWrite => {
                require_permission(request, PermissionDomain::FsWrite)?;
                require_write_risk(request)?;
                self.with_idempotency(request, |this| {
                    this.write_file(parse_arguments(&request.arguments)?)
                })
            }
            CommandOperation::FsPatch => {
                require_permission(request, PermissionDomain::FsWrite)?;
                require_write_risk(request)?;
                self.with_idempotency(request, |this| {
                    this.patch_file(parse_arguments(&request.arguments)?)
                })
            }
            CommandOperation::FsSearch => {
                require_permission(request, PermissionDomain::FsRead)?;
                self.search_files(parse_arguments(&request.arguments)?)
            }
            _ => Err(error(
                ErrorCode::UnsupportedCapability,
                "filesystem executor does not implement this operation",
            )),
        }
    }

    fn with_idempotency<F>(
        &mut self,
        request: &CommandRequest,
        operation: F,
    ) -> Result<Value, TelechirError>
    where
        F: FnOnce(&mut Self) -> Result<Value, TelechirError>,
    {
        let key = request.idempotency_key.as_deref().ok_or_else(|| {
            error(
                ErrorCode::InvalidArgument,
                "side-effect filesystem operation requires idempotency_key",
            )
        })?;
        let digest = request_digest(request)?;
        if let Some(cached) = self.idempotency.get(key) {
            if cached.digest != digest {
                return Err(error(
                    ErrorCode::IdempotencyConflict,
                    "idempotency key was already used with different arguments",
                ));
            }
            return match &cached.outcome {
                ExecutionOutcome::Completed(value) => Ok(value.clone()),
                ExecutionOutcome::Failed(error) => Err(error.clone()),
            };
        }

        let result = operation(self);
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

    fn list_files(&self, input: ListFilesInput) -> Result<Value, TelechirError> {
        let path = self.policy.resolve_existing(&input.path)?;
        let metadata = fs::metadata(&path).map_err(|error| {
            fs_error(
                ErrorCode::NotFound,
                "filesystem directory metadata cannot be read",
                Some(error),
            )
        })?;
        if !metadata.is_dir() {
            return Err(error(
                ErrorCode::InvalidArgument,
                "list_files path must be a directory",
            ));
        }

        let limit = input.limit.unwrap_or(100);
        if !(1..=500).contains(&limit) {
            return Err(error(
                ErrorCode::InvalidArgument,
                "list_files limit must be between 1 and 500",
            ));
        }
        let start = decode_cursor(input.cursor.as_deref())?;

        let mut entries = Vec::new();
        for entry in fs::read_dir(&path).map_err(|error| {
            fs_error(
                ErrorCode::InvalidArgument,
                "filesystem directory cannot be listed",
                Some(error),
            )
        })? {
            let entry = entry.map_err(|error| {
                fs_error(
                    ErrorCode::InvalidArgument,
                    "filesystem directory entry cannot be read",
                    Some(error),
                )
            })?;
            let entry_path = entry.path();
            if contains_sensitive_component(
                entry_path
                    .strip_prefix(&path)
                    .unwrap_or(entry_path.as_path()),
            ) {
                continue;
            }
            let metadata = fs::symlink_metadata(&entry_path).map_err(|error| {
                fs_error(
                    ErrorCode::InvalidArgument,
                    "filesystem entry metadata cannot be read",
                    Some(error),
                )
            })?;
            entries.push(DirectoryEntryView::from_path(entry_path, metadata));
        }
        entries.sort_by(|left, right| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.path.cmp(&right.path))
        });

        if start > entries.len() {
            return Err(error(
                ErrorCode::InvalidArgument,
                "list_files cursor is outside the current result set",
            ));
        }
        let end = start.saturating_add(limit).min(entries.len());
        let next_cursor = (end < entries.len()).then(|| encode_cursor(end));

        Ok(json!({
            "path": display_path(&path),
            "entries": entries[start..end],
            "next_cursor": next_cursor
        }))
    }
    fn stat_file(&self, input: StatFileInput) -> Result<Value, TelechirError> {
        let path = self.policy.resolve_entry_without_following(&input.path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::NotFound
            } else {
                ErrorCode::InvalidArgument
            };
            fs_error(
                code,
                "filesystem entry metadata cannot be read",
                Some(error),
            )
        })?;
        let kind = file_kind(&metadata);
        let hash = if input.include_hash.unwrap_or(true) && metadata.is_file() {
            let canonical = self.policy.resolve_existing(&input.path)?;
            Some(hash_file(&canonical)?)
        } else {
            None
        };

        Ok(json!({
            "path": display_path(&path),
            "kind": kind,
            "size": metadata.len(),
            "modified_at": modified_at(&metadata),
            "sha256": hash
        }))
    }

    fn read_file(&self, input: ReadFileInput) -> Result<Value, TelechirError> {
        let path = self.policy.resolve_existing(&input.path)?;
        let link_metadata =
            fs::symlink_metadata(self.policy.resolve_entry_without_following(&input.path)?)
                .map_err(|error| {
                    fs_error(
                        ErrorCode::InvalidArgument,
                        "filesystem entry metadata cannot be read",
                        Some(error),
                    )
                })?;
        if is_link_or_reparse(&link_metadata) {
            return Err(error(
                ErrorCode::PolicyDenied,
                "read_file does not follow symlink or reparse targets",
            ));
        }
        let metadata = fs::metadata(&path).map_err(|error| {
            fs_error(
                ErrorCode::NotFound,
                "file metadata cannot be read",
                Some(error),
            )
        })?;
        if !metadata.is_file() {
            return Err(error(
                ErrorCode::InvalidArgument,
                "read_file path must be a regular file",
            ));
        }

        let offset = input.offset.unwrap_or(0);
        let requested_max_bytes = input.max_bytes.unwrap_or(DEFAULT_READ_BYTES as u64);
        if requested_max_bytes == 0 || requested_max_bytes > PUBLIC_MAX_READ_BYTES as u64 {
            return Err(error(
                ErrorCode::InvalidArgument,
                "read_file max_bytes must be between 1 and 262144",
            ));
        }
        let max_bytes = requested_max_bytes.min(MAX_INLINE_READ_BYTES as u64);
        if offset > metadata.len() {
            return Err(error(
                ErrorCode::InvalidArgument,
                "read_file offset is past end of file",
            ));
        }

        let mut file = File::open(&path)
            .map_err(|error| fs_error(ErrorCode::NotFound, "file cannot be opened", Some(error)))?;
        file.seek(SeekFrom::Start(offset)).map_err(|error| {
            fs_error(
                ErrorCode::InvalidArgument,
                "file offset cannot be selected",
                Some(error),
            )
        })?;

        let mut bytes = vec![0_u8; max_bytes as usize + 1];
        let read = file.read(&mut bytes).map_err(|error| {
            fs_error(
                ErrorCode::InvalidArgument,
                "file cannot be read",
                Some(error),
            )
        })?;
        bytes.truncate(read);
        let truncated = bytes.len() > max_bytes as usize;
        if truncated {
            bytes.truncate(max_bytes as usize);
        }

        let encoding = input.encoding.unwrap_or(FileEncoding::Utf8);
        let content = match encoding {
            FileEncoding::Utf8 => String::from_utf8(bytes.clone()).map_err(|_| {
                error(
                    ErrorCode::InvalidArgument,
                    "file bytes are not valid UTF-8; request base64 encoding",
                )
            })?,
            FileEncoding::Base64 => STANDARD.encode(&bytes),
        };
        let next_offset = truncated.then(|| offset + bytes.len() as u64);
        let hash = if metadata.len() <= MAX_HASH_BYTES {
            Some(hash_file(&path)?)
        } else {
            None
        };

        Ok(json!({
            "path": display_path(&path),
            "content": content,
            "encoding": encoding.as_str(),
            "offset": offset,
            "next_offset": next_offset,
            "truncated": truncated,
            "sha256": hash
        }))
    }

    fn write_file(&self, input: WriteFileInput) -> Result<Value, TelechirError> {
        let path = self.policy.resolve_write_target(&input.path)?;
        let existed = path.exists();
        if !existed && !input.create_if_missing.unwrap_or(true) {
            return Err(error(
                ErrorCode::NotFound,
                "write target does not exist and create_if_missing is false",
            ));
        }
        if existed
            && !fs::metadata(&path)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false)
        {
            return Err(error(
                ErrorCode::InvalidArgument,
                "write_file target must be a regular file",
            ));
        }

        if let Some(expected) = input.expected_hash.as_deref() {
            if !existed {
                return Err(error(
                    ErrorCode::Conflict,
                    "expected_hash was supplied for a missing file",
                ));
            }
            if hash_file(&path)? != expected {
                return Err(error(
                    ErrorCode::Conflict,
                    "write_file expected_hash does not match current file",
                ));
            }
        }

        let bytes = decode_content(&input.content, input.encoding.unwrap_or(FileEncoding::Utf8))?;
        if bytes.len() > MAX_WRITE_BYTES {
            return Err(error(
                ErrorCode::InvalidArgument,
                "write_file content exceeds the Phase 6 inline write limit",
            ));
        }

        atomic_write(&path, &bytes, existed)?;
        Ok(json!({
            "path": display_path(&path),
            "bytes_written": bytes.len(),
            "sha256": hash_bytes(&bytes),
            "created": !existed
        }))
    }

    fn patch_file(&self, input: PatchFileInput) -> Result<Value, TelechirError> {
        if input.patch.len() > MAX_PATCH_BYTES {
            return Err(error(
                ErrorCode::InvalidArgument,
                "patch_file patch exceeds the Phase 6 inline patch limit",
            ));
        }
        if input.format.as_deref().unwrap_or("unified_diff") != "unified_diff" {
            return Err(error(
                ErrorCode::InvalidArgument,
                "patch_file format must be unified_diff",
            ));
        }

        let path = self.policy.resolve_write_target(&input.path)?;
        if !path.exists() {
            return Err(error(ErrorCode::NotFound, "patch target does not exist"));
        }
        let current_bytes = fs::read(&path).map_err(|error| {
            fs_error(
                ErrorCode::NotFound,
                "patch target cannot be read",
                Some(error),
            )
        })?;
        if hash_bytes(&current_bytes) != input.expected_hash {
            return Err(error(
                ErrorCode::Conflict,
                "patch_file expected_hash does not match current file",
            ));
        }
        let current = String::from_utf8(current_bytes).map_err(|_| {
            error(
                ErrorCode::InvalidArgument,
                "patch_file requires a UTF-8 text file",
            )
        })?;
        let patch = Patch::from_str(&input.patch).map_err(|_| {
            error(
                ErrorCode::InvalidArgument,
                "patch_file patch is not valid unified diff",
            )
        })?;
        let updated = diffy::apply(&current, &patch).map_err(|_| {
            error(
                ErrorCode::Conflict,
                "patch_file context does not match the current file",
            )
        })?;
        let changed = updated != current;
        if changed {
            atomic_write(&path, updated.as_bytes(), true)?;
        }

        Ok(json!({
            "path": display_path(&path),
            "sha256": hash_bytes(updated.as_bytes()),
            "changed": changed,
            "summary": if changed { "unified diff applied atomically" } else { "patch produced no content change" }
        }))
    }
    fn search_files(&self, input: SearchFilesInput) -> Result<Value, TelechirError> {
        let root = self.policy.resolve_existing(&input.root)?;
        if !fs::metadata(&root)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false)
        {
            return Err(error(
                ErrorCode::InvalidArgument,
                "search_files root must be a directory",
            ));
        }
        let max_results = input.max_results.unwrap_or(100);
        if max_results == 0 || max_results > MAX_SEARCH_RESULTS {
            return Err(error(
                ErrorCode::InvalidArgument,
                "search_files max_results must be between 1 and 1000",
            ));
        }
        if input.query.len() > 2048 {
            return Err(error(
                ErrorCode::InvalidArgument,
                "search_files query is too large",
            ));
        }

        let mode = input.mode.unwrap_or(SearchMode::Text);
        let regex =
            match mode {
                SearchMode::Regex => Some(Regex::new(&input.query).map_err(|_| {
                    error(ErrorCode::InvalidArgument, "search_files regex is invalid")
                })?),
                _ => None,
            };
        let glob = match mode {
            SearchMode::Glob => Some(
                Glob::new(&input.query)
                    .map_err(|_| error(ErrorCode::InvalidArgument, "search_files glob is invalid"))?
                    .compile_matcher(),
            ),
            _ => None,
        };

        let start = Instant::now();
        let mut stack = vec![root.clone()];
        let mut matches = Vec::new();
        let mut visited = 0_usize;
        let mut scanned_bytes = 0_u64;
        let mut truncated = false;

        while let Some(directory) = stack.pop() {
            if start.elapsed() > SEARCH_TIMEOUT {
                return Err(error(
                    ErrorCode::Timeout,
                    "search_files exceeded its local execution timeout",
                ));
            }
            let mut entries = fs::read_dir(&directory)
                .map_err(|error| {
                    fs_error(
                        ErrorCode::InvalidArgument,
                        "search directory cannot be read",
                        Some(error),
                    )
                })?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| {
                    fs_error(
                        ErrorCode::InvalidArgument,
                        "search directory entry cannot be read",
                        Some(error),
                    )
                })?;
            entries.sort_by_key(|entry| entry.file_name());

            for entry in entries {
                visited += 1;
                if visited > MAX_SEARCH_ENTRIES {
                    truncated = true;
                    break;
                }
                let path = entry.path();
                let relative = path.strip_prefix(&root).unwrap_or(path.as_path());
                if contains_sensitive_component(relative) {
                    continue;
                }
                let metadata = fs::symlink_metadata(&path).map_err(|error| {
                    fs_error(
                        ErrorCode::InvalidArgument,
                        "search entry metadata cannot be read",
                        Some(error),
                    )
                })?;
                if is_link_or_reparse(&metadata) {
                    continue;
                }
                if metadata.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !metadata.is_file() {
                    continue;
                }

                if let Some(glob) = glob.as_ref() {
                    if glob.is_match(relative) {
                        matches.push(json!({
                            "path": display_path(&path),
                            "line": null,
                            "snippet": null
                        }));
                    }
                } else if metadata.len() <= MAX_SEARCH_FILE_BYTES {
                    if scanned_bytes.saturating_add(metadata.len()) > MAX_SEARCH_SCAN_BYTES {
                        truncated = true;
                        break;
                    }
                    scanned_bytes = scanned_bytes.saturating_add(metadata.len());
                    let bytes = fs::read(&path).map_err(|error| {
                        fs_error(
                            ErrorCode::InvalidArgument,
                            "search file cannot be read",
                            Some(error),
                        )
                    })?;
                    let Ok(text) = String::from_utf8(bytes) else {
                        continue;
                    };
                    for (index, line) in text.lines().enumerate() {
                        let found = match mode {
                            SearchMode::Text => line.contains(&input.query),
                            SearchMode::Regex => {
                                regex.as_ref().is_some_and(|regex| regex.is_match(line))
                            }
                            SearchMode::Glob => false,
                        };
                        if found {
                            matches.push(json!({
                                "path": display_path(&path),
                                "line": index + 1,
                                "snippet": truncate_chars(line, 512)
                            }));
                            if matches.len() >= max_results {
                                truncated = true;
                                break;
                            }
                        }
                    }
                }

                if matches.len() >= max_results || truncated {
                    break;
                }
            }

            if matches.len() >= max_results || truncated {
                break;
            }
        }

        Ok(json!({
            "matches": matches,
            "truncated": truncated
        }))
    }
}

impl CommandExecutor for FilesystemExecutor {
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
struct ListFilesInput {
    path: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StatFileInput {
    path: String,
    #[serde(default)]
    include_hash: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
enum FileEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "base64")]
    Base64,
}

impl FileEncoding {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Base64 => "base64",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadFileInput {
    path: String,
    #[serde(default)]
    offset: Option<u64>,
    #[serde(default)]
    max_bytes: Option<u64>,
    #[serde(default)]
    encoding: Option<FileEncoding>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteFileInput {
    path: String,
    content: String,
    #[serde(default)]
    encoding: Option<FileEncoding>,
    #[serde(default)]
    expected_hash: Option<String>,
    #[serde(default)]
    create_if_missing: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PatchFileInput {
    path: String,
    patch: String,
    expected_hash: String,
    #[serde(default)]
    format: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SearchMode {
    Text,
    Regex,
    Glob,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchFilesInput {
    root: String,
    query: String,
    #[serde(default)]
    mode: Option<SearchMode>,
    #[serde(default)]
    max_results: Option<usize>,
}

#[derive(Debug, serde::Serialize)]
struct DirectoryEntryView {
    name: String,
    path: String,
    kind: &'static str,
    size: Option<u64>,
    modified_at: Option<String>,
}

impl DirectoryEntryView {
    fn from_path(path: PathBuf, metadata: fs::Metadata) -> Self {
        let kind = file_kind(&metadata);
        let size = metadata.is_file().then_some(metadata.len());
        Self {
            name: path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: display_path(&path),
            kind,
            size,
            modified_at: modified_at(&metadata),
        }
    }
}
fn parse_arguments<T>(arguments: &Map<String, Value>) -> Result<T, TelechirError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(Value::Object(arguments.clone())).map_err(|_| {
        error(
            ErrorCode::InvalidArgument,
            "filesystem command arguments do not match the operation contract",
        )
    })
}

fn require_permission(
    request: &CommandRequest,
    permission: PermissionDomain,
) -> Result<(), TelechirError> {
    if !request.requested_permissions.contains(&permission) {
        return Err(error(
            ErrorCode::PolicyDenied,
            "required local filesystem permission was not requested",
        ));
    }
    Ok(())
}

fn require_write_risk(request: &CommandRequest) -> Result<(), TelechirError> {
    if request.risk == RiskLevel::Low {
        return Err(error(
            ErrorCode::PolicyDenied,
            "filesystem write operations must be classified at least MEDIUM",
        ));
    }
    Ok(())
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
            "filesystem command digest could not be encoded",
        )
    })?;
    Ok(hash_bytes(&encoded))
}

fn decode_content(content: &str, encoding: FileEncoding) -> Result<Vec<u8>, TelechirError> {
    match encoding {
        FileEncoding::Utf8 => Ok(content.as_bytes().to_vec()),
        FileEncoding::Base64 => STANDARD.decode(content).map_err(|_| {
            error(
                ErrorCode::InvalidArgument,
                "write_file base64 content is invalid",
            )
        }),
    }
}

fn hash_file(path: &Path) -> Result<String, TelechirError> {
    let metadata = fs::metadata(path).map_err(|error| {
        fs_error(
            ErrorCode::NotFound,
            "file metadata cannot be read",
            Some(error),
        )
    })?;
    if metadata.len() > MAX_HASH_BYTES {
        return Err(error(
            ErrorCode::InvalidArgument,
            "file exceeds the Phase 6 hashing limit",
        ));
    }
    let mut file = File::open(path)
        .map_err(|error| fs_error(ErrorCode::NotFound, "file cannot be opened", Some(error)))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            fs_error(
                ErrorCode::InvalidArgument,
                "file cannot be hashed",
                Some(error),
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn atomic_write(
    path: &Path,
    bytes: &[u8],
    preserve_permissions: bool,
) -> Result<(), TelechirError> {
    let parent = path.parent().ok_or_else(|| {
        error(
            ErrorCode::InvalidArgument,
            "write target has no parent directory",
        )
    })?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        fs_error(
            ErrorCode::InternalError,
            "atomic temporary file cannot be created",
            Some(error),
        )
    })?;
    if preserve_permissions && path.exists() {
        let permissions = fs::metadata(path)
            .map_err(|error| {
                fs_error(
                    ErrorCode::InvalidArgument,
                    "existing file permissions cannot be read",
                    Some(error),
                )
            })?
            .permissions();
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(|error| {
                fs_error(
                    ErrorCode::InternalError,
                    "temporary file permissions cannot be set",
                    Some(error),
                )
            })?;
    }
    temporary.write_all(bytes).map_err(|error| {
        fs_error(
            ErrorCode::InternalError,
            "temporary file cannot be written",
            Some(error),
        )
    })?;
    temporary.as_file_mut().sync_all().map_err(|error| {
        fs_error(
            ErrorCode::InternalError,
            "temporary file cannot be synchronized",
            Some(error),
        )
    })?;
    temporary.persist(path).map_err(|error| {
        fs_error(
            ErrorCode::InternalError,
            "atomic file replacement failed",
            Some(error.error),
        )
    })?;
    Ok(())
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    #[cfg(not(windows))]
    false
}

fn file_kind(metadata: &fs::Metadata) -> &'static str {
    if is_link_or_reparse(metadata) {
        "link"
    } else if metadata.is_file() {
        "file"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "other"
    }
}

fn modified_at(metadata: &fs::Metadata) -> Option<String> {
    metadata.modified().ok().and_then(system_time_rfc3339)
}

fn system_time_rfc3339(time: SystemTime) -> Option<String> {
    let timestamp: DateTime<Utc> = time.into();
    Some(timestamp.to_rfc3339())
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn encode_cursor(index: usize) -> String {
    STANDARD.encode(index.to_string())
}

fn decode_cursor(cursor: Option<&str>) -> Result<usize, TelechirError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let decoded = STANDARD
        .decode(cursor)
        .map_err(|_| error(ErrorCode::InvalidArgument, "list_files cursor is invalid"))?;
    let decoded = String::from_utf8(decoded)
        .map_err(|_| error(ErrorCode::InvalidArgument, "list_files cursor is invalid"))?;
    decoded
        .parse::<usize>()
        .map_err(|_| error(ErrorCode::InvalidArgument, "list_files cursor is invalid"))
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
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

fn fs_error(
    code: ErrorCode,
    public_message: &'static str,
    source: Option<std::io::Error>,
) -> TelechirError {
    let retryable = source
        .as_ref()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::Interrupted);
    TelechirError {
        code,
        message: public_message.to_owned(),
        retryable,
        retry_after_ms: None,
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use serde_json::{Map, Value, json};
    use tempfile::TempDir;

    use super::*;

    fn setup() -> (TempDir, FilesystemExecutor) {
        let root = tempfile::tempdir().unwrap();
        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        (root, FilesystemExecutor::new(policy))
    }

    fn request(
        operation: CommandOperation,
        arguments: Value,
        permission: PermissionDomain,
        risk: RiskLevel,
        idempotency_key: Option<&str>,
    ) -> CommandRequest {
        CommandRequest {
            command_id: format!("cmd_{}", uuid::Uuid::new_v4()),
            idempotency_key: idempotency_key.map(str::to_owned),
            operation,
            arguments: arguments.as_object().cloned().unwrap_or_else(Map::new),
            requested_permissions: vec![permission],
            risk,
            workspace_id: None,
            approval_id: None,
        }
    }

    fn outcome(executor: &mut FilesystemExecutor, request: &CommandRequest) -> ExecutionOutcome {
        let result: Result<ExecutionOutcome, Infallible> = executor.execute(request);
        result.unwrap()
    }

    fn completed(executor: &mut FilesystemExecutor, request: &CommandRequest) -> Value {
        match outcome(executor, request) {
            ExecutionOutcome::Completed(value) => value,
            ExecutionOutcome::Failed(error) => panic!("unexpected failure: {error:?}"),
        }
    }

    fn failed(executor: &mut FilesystemExecutor, request: &CommandRequest) -> TelechirError {
        match outcome(executor, request) {
            ExecutionOutcome::Completed(value) => panic!("unexpected success: {value}"),
            ExecutionOutcome::Failed(error) => error,
        }
    }

    #[test]
    fn sensitive_directory_cannot_be_configured_as_an_allowed_root() {
        let parent = tempfile::tempdir().unwrap();
        let sensitive = parent.path().join(".ssh");
        fs::create_dir(&sensitive).unwrap();

        let result = FilesystemPolicy::new([&sensitive]);

        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, ErrorCode::PolicyDenied);
    }

    #[test]
    fn filesystem_is_deny_by_default_without_roots() {
        let policy = FilesystemPolicy::new(std::iter::empty::<&Path>()).unwrap();
        let mut executor = FilesystemExecutor::new(policy);
        let request = request(
            CommandOperation::FsList,
            json!({"path":"."}),
            PermissionDomain::FsRead,
            RiskLevel::Low,
            None,
        );

        assert_eq!(
            failed(&mut executor, &request).code,
            ErrorCode::PolicyDenied
        );
    }

    #[test]
    fn list_files_is_deterministic_and_paginated() {
        let (root, mut executor) = setup();
        fs::write(root.path().join("zeta.txt"), b"z").unwrap();
        fs::write(root.path().join("Alpha.txt"), b"a").unwrap();
        fs::create_dir(root.path().join("beta")).unwrap();

        let first = completed(
            &mut executor,
            &request(
                CommandOperation::FsList,
                json!({"path":".","limit":2}),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );
        let names = first["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["Alpha.txt", "beta"]);
        let cursor = first["next_cursor"].as_str().unwrap();

        let second = completed(
            &mut executor,
            &request(
                CommandOperation::FsList,
                json!({"path":".","limit":2,"cursor":cursor}),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );
        assert_eq!(second["entries"][0]["name"], "zeta.txt");
        assert!(second["next_cursor"].is_null());
    }

    #[test]
    fn metadata_hash_and_bounded_read_follow_public_contract() {
        let (root, mut executor) = setup();
        fs::write(root.path().join("hello.txt"), b"hello telechir").unwrap();

        let metadata = completed(
            &mut executor,
            &request(
                CommandOperation::FsStat,
                json!({"path":"hello.txt","include_hash":true}),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );
        assert_eq!(metadata["kind"], "file");
        assert_eq!(metadata["size"], 14);
        assert_eq!(metadata["sha256"], hash_bytes(b"hello telechir"));

        let read = completed(
            &mut executor,
            &request(
                CommandOperation::FsRead,
                json!({"path":"hello.txt","offset":0,"max_bytes":5,"encoding":"utf-8"}),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );
        assert_eq!(read["content"], "hello");
        assert_eq!(read["next_offset"], 5);
        assert_eq!(read["truncated"], true);
    }

    #[test]
    fn binary_read_requires_explicit_base64() {
        let (root, mut executor) = setup();
        fs::write(root.path().join("binary.bin"), [0xff, 0x00, 0x01]).unwrap();

        let utf8 = request(
            CommandOperation::FsRead,
            json!({"path":"binary.bin","encoding":"utf-8"}),
            PermissionDomain::FsRead,
            RiskLevel::Low,
            None,
        );
        assert_eq!(
            failed(&mut executor, &utf8).code,
            ErrorCode::InvalidArgument
        );

        let base64 = completed(
            &mut executor,
            &request(
                CommandOperation::FsRead,
                json!({"path":"binary.bin","encoding":"base64"}),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );
        assert_eq!(base64["content"], STANDARD.encode([0xff, 0x00, 0x01]));
    }

    #[test]
    fn path_traversal_and_sensitive_paths_are_denied() {
        let (root, mut executor) = setup();
        let outside = root
            .path()
            .parent()
            .unwrap()
            .join(format!("telechir-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"outside").unwrap();
        fs::create_dir(root.path().join(".ssh")).unwrap();
        fs::write(root.path().join(".ssh").join("id_ed25519"), b"secret").unwrap();

        let traversal_path = root
            .path()
            .join("..")
            .join(outside.file_name().unwrap())
            .join("secret.txt")
            .to_string_lossy()
            .into_owned();
        let traversal = request(
            CommandOperation::FsRead,
            json!({"path":traversal_path}),
            PermissionDomain::FsRead,
            RiskLevel::Low,
            None,
        );
        assert_eq!(
            failed(&mut executor, &traversal).code,
            ErrorCode::PolicyDenied
        );

        let sensitive = request(
            CommandOperation::FsRead,
            json!({"path":".ssh/id_ed25519"}),
            PermissionDomain::FsRead,
            RiskLevel::Low,
            None,
        );
        assert_eq!(
            failed(&mut executor, &sensitive).code,
            ErrorCode::PolicyDenied
        );

        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn write_is_atomic_bounded_and_idempotent() {
        let (root, mut executor) = setup();
        let request = request(
            CommandOperation::FsWrite,
            json!({
                "path":"new.txt",
                "content":"first",
                "encoding":"utf-8",
                "create_if_missing":true
            }),
            PermissionDomain::FsWrite,
            RiskLevel::Medium,
            Some("idem_write_0001"),
        );

        let first = completed(&mut executor, &request);
        assert_eq!(first["created"], true);
        assert_eq!(
            fs::read_to_string(root.path().join("new.txt")).unwrap(),
            "first"
        );

        fs::write(root.path().join("new.txt"), b"external-change").unwrap();
        let replay = completed(&mut executor, &request);
        assert_eq!(replay, first);
        assert_eq!(
            fs::read_to_string(root.path().join("new.txt")).unwrap(),
            "external-change"
        );
    }

    #[test]
    fn same_idempotency_key_with_different_arguments_is_rejected() {
        let (_root, mut executor) = setup();
        let first = request(
            CommandOperation::FsWrite,
            json!({"path":"a.txt","content":"one"}),
            PermissionDomain::FsWrite,
            RiskLevel::Medium,
            Some("idem_conflict_01"),
        );
        completed(&mut executor, &first);

        let second = request(
            CommandOperation::FsWrite,
            json!({"path":"a.txt","content":"two"}),
            PermissionDomain::FsWrite,
            RiskLevel::Medium,
            Some("idem_conflict_01"),
        );
        assert_eq!(
            failed(&mut executor, &second).code,
            ErrorCode::IdempotencyConflict
        );
    }

    #[test]
    fn write_expected_hash_conflict_leaves_file_unchanged() {
        let (root, mut executor) = setup();
        fs::write(root.path().join("state.txt"), b"current").unwrap();
        let request = request(
            CommandOperation::FsWrite,
            json!({
                "path":"state.txt",
                "content":"replacement",
                "expected_hash":"deadbeef",
                "create_if_missing":true
            }),
            PermissionDomain::FsWrite,
            RiskLevel::Medium,
            Some("idem_hash_conflict"),
        );
        assert_eq!(failed(&mut executor, &request).code, ErrorCode::Conflict);
        assert_eq!(
            fs::read_to_string(root.path().join("state.txt")).unwrap(),
            "current"
        );
    }
    #[test]
    fn patch_applies_with_hash_precondition_and_conflict_is_atomic() {
        let (root, mut executor) = setup();
        let path = root.path().join("source.txt");
        fs::write(&path, "hello\nworld\n").unwrap();
        let expected = hash_bytes(b"hello\nworld\n");
        let patch =
            "--- a/source.txt\n+++ b/source.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+telechir\n";
        let patch_request = request(
            CommandOperation::FsPatch,
            json!({
                "path":"source.txt",
                "patch":patch,
                "expected_hash":expected,
                "format":"unified_diff"
            }),
            PermissionDomain::FsWrite,
            RiskLevel::Medium,
            Some("idem_patch_0001"),
        );

        let result = completed(&mut executor, &patch_request);
        assert_eq!(result["changed"], true);
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello\ntelechir\n");

        let stale = request(
            CommandOperation::FsPatch,
            json!({
                "path":"source.txt",
                "patch":patch,
                "expected_hash":expected,
                "format":"unified_diff"
            }),
            PermissionDomain::FsWrite,
            RiskLevel::Medium,
            Some("idem_patch_stale"),
        );
        assert_eq!(failed(&mut executor, &stale).code, ErrorCode::Conflict);
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello\ntelechir\n");
    }

    #[test]
    fn invalid_patch_context_leaves_file_unchanged() {
        let (root, mut executor) = setup();
        let path = root.path().join("source.txt");
        fs::write(&path, "hello\nworld\n").unwrap();
        let expected = hash_bytes(b"hello\nworld\n");
        let patch =
            "--- a/source.txt\n+++ b/source.txt\n@@ -1,2 +1,2 @@\n missing\n-world\n+telechir\n";
        let request = request(
            CommandOperation::FsPatch,
            json!({
                "path":"source.txt",
                "patch":patch,
                "expected_hash":expected,
                "format":"unified_diff"
            }),
            PermissionDomain::FsWrite,
            RiskLevel::Medium,
            Some("idem_patch_badctx"),
        );

        assert_eq!(failed(&mut executor, &request).code, ErrorCode::Conflict);
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello\nworld\n");
    }

    #[test]
    fn search_supports_text_regex_and_glob_with_limits() {
        let (root, mut executor) = setup();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(
            root.path().join("src").join("main.rs"),
            "fn main() {\n    println!(\"telechir\");\n}\n",
        )
        .unwrap();
        fs::write(root.path().join("README.md"), "Telechir project\n").unwrap();

        let text = completed(
            &mut executor,
            &request(
                CommandOperation::FsSearch,
                json!({"root":".","query":"telechir","mode":"text","max_results":10}),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );
        assert_eq!(text["matches"].as_array().unwrap().len(), 1);
        assert_eq!(text["matches"][0]["line"], 2);

        let regex = completed(
            &mut executor,
            &request(
                CommandOperation::FsSearch,
                json!({"root":".","query":"Telechir\\s+project","mode":"regex","max_results":10}),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );
        assert_eq!(regex["matches"].as_array().unwrap().len(), 1);

        let glob = completed(
            &mut executor,
            &request(
                CommandOperation::FsSearch,
                json!({"root":".","query":"**/*.rs","mode":"glob","max_results":10}),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );
        assert_eq!(glob["matches"].as_array().unwrap().len(), 1);
        assert!(
            glob["matches"][0]["path"]
                .as_str()
                .unwrap()
                .ends_with("main.rs")
        );
    }

    #[test]
    fn public_max_read_is_chunked_to_wire_safe_size() {
        let (root, mut executor) = setup();
        let bytes = vec![b'x'; PUBLIC_MAX_READ_BYTES];
        fs::write(root.path().join("large.txt"), &bytes).unwrap();

        let read = completed(
            &mut executor,
            &request(
                CommandOperation::FsRead,
                json!({
                    "path":"large.txt",
                    "max_bytes":PUBLIC_MAX_READ_BYTES,
                    "encoding":"utf-8"
                }),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );

        assert_eq!(
            read["content"].as_str().unwrap().len(),
            MAX_INLINE_READ_BYTES
        );
        assert_eq!(read["truncated"], true);
        assert_eq!(
            read["next_offset"].as_u64().unwrap(),
            MAX_INLINE_READ_BYTES as u64
        );
    }

    #[test]
    fn oversized_inline_write_is_rejected_before_side_effect() {
        let (root, mut executor) = setup();
        let write = request(
            CommandOperation::FsWrite,
            json!({
                "path":"too-large.txt",
                "content":"x".repeat(MAX_WRITE_BYTES + 1),
                "encoding":"utf-8"
            }),
            PermissionDomain::FsWrite,
            RiskLevel::Medium,
            Some("idem_oversized_write"),
        );

        assert_eq!(
            failed(&mut executor, &write).code,
            ErrorCode::InvalidArgument
        );
        assert!(!root.path().join("too-large.txt").exists());
    }

    #[test]
    fn filesystem_write_requires_fs_write_and_medium_or_higher_risk() {
        let (_root, mut executor) = setup();
        let wrong_permission = request(
            CommandOperation::FsWrite,
            json!({"path":"denied.txt","content":"x"}),
            PermissionDomain::FsRead,
            RiskLevel::Medium,
            Some("idem_permission"),
        );
        assert_eq!(
            failed(&mut executor, &wrong_permission).code,
            ErrorCode::PolicyDenied
        );

        let low_risk = request(
            CommandOperation::FsWrite,
            json!({"path":"denied.txt","content":"x"}),
            PermissionDomain::FsWrite,
            RiskLevel::Low,
            Some("idem_lowrisk_01"),
        );
        assert_eq!(
            failed(&mut executor, &low_risk).code,
            ErrorCode::PolicyDenied
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_blocked_and_search_does_not_follow_links() {
        use std::os::unix::fs::symlink;

        let (root, mut executor) = setup();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.txt"), b"needle").unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();

        let read = request(
            CommandOperation::FsRead,
            json!({"path":"escape/outside.txt"}),
            PermissionDomain::FsRead,
            RiskLevel::Low,
            None,
        );
        assert_eq!(failed(&mut executor, &read).code, ErrorCode::PolicyDenied);

        let search = completed(
            &mut executor,
            &request(
                CommandOperation::FsSearch,
                json!({"root":".","query":"needle","mode":"text","max_results":10}),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );
        assert!(search["matches"].as_array().unwrap().is_empty());

        let list = completed(
            &mut executor,
            &request(
                CommandOperation::FsList,
                json!({"path":".","limit":100}),
                PermissionDomain::FsRead,
                RiskLevel::Low,
                None,
            ),
        );
        let link = list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "escape")
            .unwrap();
        assert_eq!(link["kind"], "link");
    }

    #[cfg(windows)]
    #[test]
    fn windows_root_boundary_uses_path_components_not_string_prefixes() {
        let root = PathBuf::from(r"C:\workspace");
        let inside = PathBuf::from(r"C:\workspace\src\main.rs");
        let sibling = PathBuf::from(r"C:\workspace-other\secret.txt");

        assert!(inside.starts_with(&root));
        assert!(!sibling.starts_with(&root));
    }
}
