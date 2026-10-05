use std::convert::Infallible;

use chrono::Utc;

use crate::config::AgentConfig;
use crate::filesystem::{FilesystemExecutor, FilesystemPolicy};
use crate::git::GitExecutor;
use crate::policy::LocalPolicyEngine;
use crate::ports::{AuthorizationOutcome, CommandExecutor, ExecutionOutcome};
use crate::process::{ProcessExecutor, ProcessPolicy};
use crate::protocol::{
    ApprovalDecision, CommandOperation, CommandRequest, ErrorCode, PermissionDomain, RiskLevel,
    TelechirError,
};
use crate::sandbox::DockerSandboxConfig;

pub struct LocalCommandExecutor {
    filesystem: FilesystemExecutor,
    process: ProcessExecutor,
    git: GitExecutor,
    policy: LocalPolicyEngine,
}

impl LocalCommandExecutor {
    pub fn new(filesystem_policy: FilesystemPolicy) -> Self {
        let process_policy = ProcessPolicy::new(filesystem_policy.clone());
        let git = GitExecutor::new(filesystem_policy.clone());
        Self {
            filesystem: FilesystemExecutor::new(filesystem_policy),
            process: ProcessExecutor::new(process_policy),
            git,
            policy: LocalPolicyEngine::default(),
        }
    }

    pub fn from_config(
        filesystem_policy: FilesystemPolicy,
        config: &AgentConfig,
    ) -> Result<Self, TelechirError> {
        match config.sandbox.clone() {
            Some(sandbox) => Self::with_docker_sandbox(filesystem_policy, sandbox),
            None => Ok(Self::new(filesystem_policy)),
        }
    }

    pub fn with_docker_sandbox(
        filesystem_policy: FilesystemPolicy,
        sandbox: DockerSandboxConfig,
    ) -> Result<Self, TelechirError> {
        let process_policy = ProcessPolicy::new(filesystem_policy.clone());
        let git = GitExecutor::new(filesystem_policy.clone());
        Ok(Self {
            filesystem: FilesystemExecutor::new(filesystem_policy),
            process: ProcessExecutor::with_docker_sandbox(process_policy, sandbox)?,
            git,
            policy: LocalPolicyEngine::default(),
        })
    }

    pub fn filesystem(&self) -> &FilesystemExecutor {
        &self.filesystem
    }

    pub fn process(&self) -> &ProcessExecutor {
        &self.process
    }

    pub fn git(&self) -> &GitExecutor {
        &self.git
    }

    pub fn policy(&self) -> &LocalPolicyEngine {
        &self.policy
    }

    fn execute_prepared(
        &mut self,
        request: &CommandRequest,
        approval_verified: bool,
    ) -> ExecutionOutcome {
        match request.operation {
            CommandOperation::FsList
            | CommandOperation::FsStat
            | CommandOperation::FsRead
            | CommandOperation::FsWrite
            | CommandOperation::FsPatch
            | CommandOperation::FsSearch => self.filesystem.execute(request).unwrap(),
            CommandOperation::ShellExec
            | CommandOperation::ProcessStart
            | CommandOperation::ProcessRead
            | CommandOperation::ProcessWrite
            | CommandOperation::ProcessCancel
            | CommandOperation::ProcessList => self
                .process
                .execute_with_verified_approval(request, approval_verified),
            CommandOperation::GitStatus | CommandOperation::GitDiff => {
                self.git.execute(request).unwrap()
            }
            CommandOperation::SystemMetrics => ExecutionOutcome::Failed(TelechirError {
                code: ErrorCode::UnsupportedCapability,
                message: "operation is not enabled in the current Telechir phase".to_owned(),
                retryable: false,
                retry_after_ms: None,
                details: None,
            }),
        }
    }
}

impl CommandExecutor for LocalCommandExecutor {
    type Error = Infallible;

    fn authorize(
        &mut self,
        request: &CommandRequest,
        session_id: Option<&str>,
    ) -> AuthorizationOutcome {
        let authorization = self.policy.authorize(request, session_id, Utc::now());
        let AuthorizationOutcome::Allow {
            request: prepared,
            approval_verified,
        } = authorization
        else {
            return authorization;
        };

        if matches!(
            prepared.operation,
            CommandOperation::ShellExec | CommandOperation::ProcessStart
        ) {
            match self.process.preflight_shell(&prepared, approval_verified) {
                Ok(()) => {}
                Err(error) if error.code == ErrorCode::ApprovalRequired => {
                    return match self.policy.request_approval(
                        &prepared,
                        session_id,
                        PermissionDomain::ShellSafe,
                        RiskLevel::High,
                        "Comando SHELL_SAFE fora da allowlist padrão requer aprovação explícita.",
                        Utc::now(),
                    ) {
                        Ok(approval) => AuthorizationOutcome::Ask(approval),
                        Err(error) => AuthorizationOutcome::Deny(error),
                    };
                }
                Err(error) => return AuthorizationOutcome::Deny(error),
            }
        }

        AuthorizationOutcome::Allow {
            request: prepared,
            approval_verified,
        }
    }

    fn apply_approval_decision(&mut self, decision: &ApprovalDecision, session_id: Option<&str>) {
        self.policy.apply_decision(decision, session_id, Utc::now());
    }

    fn execute_authorized(
        &mut self,
        request: &CommandRequest,
        approval_verified: bool,
    ) -> Result<ExecutionOutcome, Self::Error> {
        Ok(self.execute_prepared(request, approval_verified))
    }

    fn execute(&mut self, request: &CommandRequest) -> Result<ExecutionOutcome, Self::Error> {
        Ok(self.execute_prepared(request, false))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::{Map, json};

    use crate::protocol::{ApprovalDecisionKind, ApprovalScope};

    use super::*;

    fn sandbox_executor() -> (tempfile::TempDir, LocalCommandExecutor) {
        let root = tempfile::tempdir().unwrap();
        let docker = root.path().join(if cfg!(windows) {
            "docker.exe"
        } else {
            "docker"
        });
        fs::write(&docker, b"fake docker").unwrap();
        let sandbox = DockerSandboxConfig::new(
            docker,
            "telechir/sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        (
            root,
            LocalCommandExecutor::with_docker_sandbox(policy, sandbox).unwrap(),
        )
    }

    #[test]
    fn composite_executor_keeps_later_operations_disabled() {
        let root = tempfile::tempdir().unwrap();
        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        let mut executor = LocalCommandExecutor::new(policy);
        let request = CommandRequest {
            command_id: "cmd_phase9_composite".to_owned(),
            idempotency_key: None,
            operation: CommandOperation::SystemMetrics,
            arguments: Map::new(),
            requested_permissions: vec![PermissionDomain::FsRead],
            risk: RiskLevel::Low,
            workspace_id: None,
            approval_id: None,
        };

        let result = executor.execute(&request).unwrap();
        assert!(matches!(
            result,
            ExecutionOutcome::Failed(TelechirError {
                code: ErrorCode::UnsupportedCapability,
                ..
            })
        ));
    }

    #[test]
    fn unknown_shell_command_requires_agent_issued_approval() {
        let root = tempfile::tempdir().unwrap();
        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        let mut executor = LocalCommandExecutor::new(policy);
        let mut request = CommandRequest {
            command_id: "cmd_phase9_shell_approval".to_owned(),
            idempotency_key: Some("idem_phase9_shell_approval".to_owned()),
            operation: CommandOperation::ShellExec,
            arguments: json!({
                "command": "python tool.py",
                "cwd": root.path().to_string_lossy()
            })
            .as_object()
            .unwrap()
            .clone(),
            requested_permissions: vec![PermissionDomain::ShellSafe],
            risk: RiskLevel::Medium,
            workspace_id: None,
            approval_id: None,
        };

        let approval = match executor.authorize(&request, Some("session_phase9")) {
            AuthorizationOutcome::Ask(approval) => approval,
            other => panic!("expected approval request, got {other:?}"),
        };
        assert_eq!(approval.command_id, request.command_id);
        assert_eq!(approval.risk, RiskLevel::High);

        request.approval_id = Some("approval_forged".to_owned());
        assert!(matches!(
            executor.authorize(&request, Some("session_phase9")),
            AuthorizationOutcome::Deny(_)
        ));
    }

    #[test]
    fn sandbox_request_fails_closed_when_runtime_is_not_configured() {
        let root = tempfile::tempdir().unwrap();
        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        let mut executor = LocalCommandExecutor::new(policy);
        let request = CommandRequest {
            command_id: "cmd_phase12_sandbox_disabled".to_owned(),
            idempotency_key: Some("idem_phase12_sandbox_disabled".to_owned()),
            operation: CommandOperation::ShellExec,
            arguments: json!({
                "command": "echo safe",
                "cwd": root.path().to_string_lossy(),
                "execution_mode": "sandbox"
            })
            .as_object()
            .unwrap()
            .clone(),
            requested_permissions: vec![PermissionDomain::ShellSafe],
            risk: RiskLevel::Medium,
            workspace_id: None,
            approval_id: None,
        };

        match executor.authorize(&request, Some("session_phase12")) {
            AuthorizationOutcome::Deny(error) => {
                assert_eq!(error.code, ErrorCode::UnsupportedCapability);
            }
            other => panic!("expected sandbox fail-closed denial, got {other:?}"),
        }
    }

    #[test]
    fn sandbox_turns_host_hard_deny_into_bound_approval_only() {
        let (root, mut executor) = sandbox_executor();
        let guarded = CommandRequest {
            command_id: "cmd_phase12_guarded_curl".to_owned(),
            idempotency_key: Some("idem_phase12_guarded_curl".to_owned()),
            operation: CommandOperation::ShellExec,
            arguments: json!({
                "command": "curl https://example.invalid",
                "cwd": root.path().to_string_lossy(),
                "execution_mode": "guarded_host"
            })
            .as_object()
            .unwrap()
            .clone(),
            requested_permissions: vec![PermissionDomain::ShellSafe],
            risk: RiskLevel::Medium,
            workspace_id: None,
            approval_id: None,
        };

        match executor.authorize(&guarded, Some("session_phase12")) {
            AuthorizationOutcome::Deny(error) => {
                assert_eq!(error.code, ErrorCode::PolicyDenied);
            }
            other => panic!("expected guarded-host hard deny, got {other:?}"),
        }

        let sandbox = CommandRequest {
            command_id: "cmd_phase12_sandbox_curl".to_owned(),
            idempotency_key: Some("idem_phase12_sandbox_curl".to_owned()),
            arguments: json!({
                "command": "curl https://example.invalid",
                "cwd": root.path().to_string_lossy(),
                "execution_mode": "sandbox"
            })
            .as_object()
            .unwrap()
            .clone(),
            ..guarded
        };

        let approval = match executor.authorize(&sandbox, Some("session_phase12")) {
            AuthorizationOutcome::Ask(approval) => approval,
            other => panic!("expected sandbox approval request, got {other:?}"),
        };
        assert_eq!(approval.command_id, sandbox.command_id);
        assert_eq!(approval.risk, RiskLevel::High);
    }

    #[test]
    fn sandbox_approval_cannot_be_replayed_after_execution_mode_swap() {
        let (root, mut executor) = sandbox_executor();
        let mut request = CommandRequest {
            command_id: "cmd_phase12_mode_bound".to_owned(),
            idempotency_key: Some("idem_phase12_mode_bound".to_owned()),
            operation: CommandOperation::ShellExec,
            arguments: json!({
                "command": "curl https://example.invalid",
                "cwd": root.path().to_string_lossy(),
                "execution_mode": "sandbox"
            })
            .as_object()
            .unwrap()
            .clone(),
            requested_permissions: vec![PermissionDomain::ShellSafe],
            risk: RiskLevel::Medium,
            workspace_id: None,
            approval_id: None,
        };

        let approval = match executor.authorize(&request, Some("session_phase12")) {
            AuthorizationOutcome::Ask(approval) => approval,
            other => panic!("expected sandbox approval request, got {other:?}"),
        };
        executor.apply_approval_decision(
            &ApprovalDecision {
                approval_id: approval.approval_id.clone(),
                decision: ApprovalDecisionKind::Approve,
                decided_at: Utc::now(),
                scope: ApprovalScope::Once,
            },
            Some("session_phase12"),
        );

        request.approval_id = Some(approval.approval_id);
        request.arguments.insert(
            "execution_mode".to_owned(),
            serde_json::Value::String("guarded_host".to_owned()),
        );

        assert!(matches!(
            executor.authorize(&request, Some("session_phase12")),
            AuthorizationOutcome::Deny(_)
        ));
    }
}
