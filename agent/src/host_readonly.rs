//! Explicit, workspace-bounded and read-only host authority for G1-C.
//! Never instantiates elevated features, shell or process execution.
use std::collections::{HashSet, VecDeque};
use std::convert::Infallible;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::executor::LocalCommandExecutor;
use crate::filesystem::FilesystemPolicy;
use crate::ports::{AuthorizationOutcome, CommandExecutor, ExecutionOutcome};
use crate::protocol::{
    ApprovalDecision, CommandOperation, CommandRequest, ErrorCode, PermissionDomain, RiskLevel,
    TelechirError,
};

const MAX_AUDIT_EVENTS: usize = 256;
const MAX_RECENT_COMMANDS: usize = 1024;

/// These are the ONLY operations ever allowed by the G1-C read-only host.
/// All writes, process/shell, screen, browser, input and system metrics remain denied.
pub const READ_ONLY_CAPABILITIES: [&str; 6] = [
    "fs.list",
    "fs.stat",
    "fs.read",
    "fs.search",
    "git.status",
    "git.diff",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadOnlyDecision {
    Allowed,
    Denied,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct ReadOnlyAuditEvent {
    pub operation: &'static str,
    pub decision: ReadOnlyDecision,
    pub at: DateTime<Utc>,
    /// Hash of the untrusted command identifier. Never store raw args or paths.
    pub command_digest: String,
}

pub struct ReadOnlyHostExecutor {
    inner: LocalCommandExecutor,
    pending: Option<CommandRequest>,
    observed: HashSet<[u8; 32]>,
    recent: VecDeque<[u8; 32]>,
    audit: VecDeque<ReadOnlyAuditEvent>,
}

fn refused() -> TelechirError {
    TelechirError {
        code: ErrorCode::PolicyDenied,
        message: "the read-only host refused the requested operation".to_owned(),
        retryable: false,
        retry_after_ms: None,
        details: None,
    }
}

fn permitted(request: &CommandRequest) -> bool {
    matches!(
        request.operation,
        CommandOperation::FsList
            | CommandOperation::FsStat
            | CommandOperation::FsRead
            | CommandOperation::FsSearch
            | CommandOperation::GitStatus
            | CommandOperation::GitDiff
    ) && !request.operation.has_side_effect()
        && request.requested_permissions.as_slice() == [PermissionDomain::FsRead]
        && matches!(request.risk, RiskLevel::Low | RiskLevel::Medium)
        && request.workspace_id.is_none()
        && request.approval_id.is_none()
        && request.idempotency_key.is_none()
}

impl ReadOnlyHostExecutor {
    /// The root MUST be explicitly supplied by an opt-in CLI action; no
    /// implicit HOME, cwd, full drive or env-based workspace is trusted.
    pub fn new(root: impl AsRef<Path>) -> Result<Self, TelechirError> {
        if !root.as_ref().is_absolute() {
            return Err(refused());
        }
        let filesystem = FilesystemPolicy::new([root])?;
        Ok(Self {
            inner: LocalCommandExecutor::new(filesystem),
            pending: None,
            observed: HashSet::new(),
            recent: VecDeque::new(),
            audit: VecDeque::new(),
        })
    }

    pub fn audit_events(&self) -> &VecDeque<ReadOnlyAuditEvent> {
        &self.audit
    }

    fn record(&mut self, request: &CommandRequest, decision: ReadOnlyDecision) {
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(request.command_id.as_bytes()));
        if self.audit.len() == MAX_AUDIT_EVENTS {
            self.audit.pop_front();
        }
        self.audit.push_back(ReadOnlyAuditEvent {
            operation: request.operation.as_str(),
            decision,
            at: Utc::now(),
            command_digest: digest,
        });
    }

    fn seen(&mut self, request: &CommandRequest) -> bool {
        let fingerprint: [u8; 32] = Sha256::digest(request.command_id.as_bytes()).into();
        if !self.observed.insert(fingerprint) {
            return true;
        }
        if self.recent.len() == MAX_RECENT_COMMANDS
            && let Some(discarded) = self.recent.pop_front()
        {
            self.observed.remove(&discarded);
        }
        self.recent.push_back(fingerprint);
        false
    }
}

impl CommandExecutor for ReadOnlyHostExecutor {
    type Error = Infallible;

    fn authorize(
        &mut self,
        request: &CommandRequest,
        session_id: Option<&str>,
    ) -> AuthorizationOutcome {
        self.pending = None;
        if !permitted(request) || self.seen(request) {
            self.record(request, ReadOnlyDecision::Denied);
            return AuthorizationOutcome::Deny(refused());
        }
        match self.inner.authorize(request, session_id) {
            AuthorizationOutcome::Allow {
                request: prepared,
                approval_verified: false,
            } if permitted(&prepared) => {
                self.pending = Some(prepared.clone());
                self.record(request, ReadOnlyDecision::Allowed);
                AuthorizationOutcome::Allow {
                    request: prepared,
                    approval_verified: false,
                }
            }
            // No remote approval or critical/elevated operation can increase
            // read-only host authority, even if a previous approval is replayed.
            _ => {
                self.record(request, ReadOnlyDecision::Denied);
                AuthorizationOutcome::Deny(refused())
            }
        }
    }

    fn apply_approval_decision(&mut self, _decision: &ApprovalDecision, _session_id: Option<&str>) {
        // Intentionally ignore remote approval decisions. Read-only host has
        // no interactive confirmation surface and cannot accept a grant.
    }

    fn execute_authorized(
        &mut self,
        request: &CommandRequest,
        approval_verified: bool,
    ) -> Result<ExecutionOutcome, Self::Error> {
        let matched = self
            .pending
            .take()
            .is_some_and(|approved| approved == *request);
        if !matched || approval_verified || !permitted(request) {
            self.record(request, ReadOnlyDecision::Denied);
            return Ok(ExecutionOutcome::Failed(refused()));
        }
        let result = self.inner.execute_authorized(request, false)?;
        self.record(
            request,
            match &result {
                ExecutionOutcome::Completed(_) => ReadOnlyDecision::Completed,
                ExecutionOutcome::Failed(_) => ReadOnlyDecision::Failed,
            },
        );
        Ok(result)
    }

    fn execute(&mut self, request: &CommandRequest) -> Result<ExecutionOutcome, Self::Error> {
        self.record(request, ReadOnlyDecision::Denied);
        Ok(ExecutionOutcome::Failed(refused()))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::{Map, json};

    use super::*;

    fn request(operation: CommandOperation) -> CommandRequest {
        CommandRequest {
            command_id: format!("cmd_readonly_{}", operation.as_str()),
            idempotency_key: None,
            operation,
            arguments: Map::new(),
            requested_permissions: vec![PermissionDomain::FsRead],
            risk: RiskLevel::Low,
            workspace_id: None,
            approval_id: None,
        }
    }

    #[test]
    fn readonly_host_refuses_every_mutating_or_privileged_operation() {
        let root = tempfile::tempdir().unwrap();
        let mut host = ReadOnlyHostExecutor::new(root.path()).unwrap();
        let mut denied = 0;
        for op in CommandOperation::ALL {
            let req = request(op);
            if !READ_ONLY_CAPABILITIES.contains(&op.as_str()) {
                denied += 1;
                assert!(
                    matches!(host.authorize(&req, None), AuthorizationOutcome::Deny(_)),
                    "privileged operation was not denied: {}",
                    op.as_str()
                );
            }
            assert!(matches!(
                host.execute(&req).unwrap(),
                ExecutionOutcome::Failed(TelechirError {
                    code: ErrorCode::PolicyDenied,
                    ..
                })
            ));
        }
        assert_eq!(denied, 17);
        assert!(
            host.audit_events()
                .iter()
                .all(|event| !event.command_digest.is_empty())
        );
    }

    #[test]
    fn readonly_host_requires_explicit_absolute_existing_root() {
        assert!(ReadOnlyHostExecutor::new("relative-root").is_err());
        let root = tempfile::tempdir().unwrap();
        assert!(ReadOnlyHostExecutor::new(root.path().join("missing")).is_err());
    }

    #[test]
    fn readonly_host_reads_only_explicit_root_and_denies_replay() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("visible.txt"), "readonly data").unwrap();
        let mut host = ReadOnlyHostExecutor::new(root.path()).unwrap();
        let mut req = request(CommandOperation::FsList);
        req.arguments = json!({"path": root.path().to_string_lossy()})
            .as_object()
            .unwrap()
            .clone();

        let prepared = match host.authorize(&req, None) {
            AuthorizationOutcome::Allow {
                request,
                approval_verified: false,
            } => request,
            other => panic!("expected read-only authorization, got {other:?}"),
        };
        assert!(matches!(
            host.execute_authorized(&prepared, false).unwrap(),
            ExecutionOutcome::Completed(_)
        ));
        assert!(matches!(
            host.authorize(&req, None),
            AuthorizationOutcome::Deny(_)
        ));
        assert!(matches!(
            host.execute_authorized(&prepared, false).unwrap(),
            ExecutionOutcome::Failed(_)
        ));
        assert_eq!(
            host.audit_events()
                .iter()
                .filter(|e| e.decision == ReadOnlyDecision::Completed)
                .count(),
            1
        );
    }

    #[test]
    fn readonly_host_prevents_read_outside_root_and_bounded_audit_never_leaks_paths() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let private = outside.path().join("sensitive.txt");
        fs::write(&private, "private_secret_content").unwrap();
        let mut host = ReadOnlyHostExecutor::new(root.path()).unwrap();
        let mut req = request(CommandOperation::FsRead);
        req.command_id = "cmd_secrets_should_be_hashed".to_owned();
        req.arguments = json!({"path": private.to_string_lossy()})
            .as_object().unwrap().clone();
        if let AuthorizationOutcome::Allow { request: prepared, .. } = host.authorize(&req, None) {
            assert!(matches!(
                host.execute_authorized(&prepared, false).unwrap(),
                ExecutionOutcome::Failed(_)
            ));
        }
        for i in 0..300 {
            let mut forbidden = request(CommandOperation::ShellExec);
            forbidden.command_id = format!("secret_raw_command_id_{i}");
            assert!(matches!(
                host.authorize(&forbidden, None),
                AuthorizationOutcome::Deny(_)
            ));
        }
        assert_eq!(host.audit_events().len(), MAX_AUDIT_EVENTS);
        let recorded = format!("{:?}", host.audit_events());
        assert!(!recorded.contains("private_secret_content"));
        assert!(!recorded.contains("sensitive.txt"));
        assert!(!recorded.contains("secret_raw_command_id"));
        assert!(!recorded.contains("cmd_secrets_should_be_hashed"));
    }

    #[test]
    fn readonly_host_denies_approval_workspace_and_permission_escalation() {
        let root = tempfile::tempdir().unwrap();
        let mut host = ReadOnlyHostExecutor::new(root.path()).unwrap();
        let original = request(CommandOperation::FsStat);
        let mut forged = original.clone();
        forged.approval_id = Some("approval_forged".to_owned());
        assert!(matches!(
            host.authorize(&forged, None),
            AuthorizationOutcome::Deny(_)
        ));
        let mut workspace = original.clone();
        workspace.workspace_id = Some("workspace_other".to_owned());
        assert!(matches!(
            host.authorize(&workspace, None),
            AuthorizationOutcome::Deny(_)
        ));
        let mut permissions = original.clone();
        permissions
            .requested_permissions
            .push(PermissionDomain::FsWrite);
        assert!(matches!(
            host.authorize(&permissions, None),
            AuthorizationOutcome::Deny(_)
        ));
        let mut high_risk = original;
        high_risk.risk = RiskLevel::High;
        assert!(matches!(
            host.authorize(&high_risk, None),
            AuthorizationOutcome::Deny(_)
        ));
    }
}
