use std::convert::Infallible;

use chrono::Utc;

use crate::filesystem::{FilesystemExecutor, FilesystemPolicy};
use crate::git::GitExecutor;
use crate::policy::LocalPolicyEngine;
use crate::ports::{AuthorizationOutcome, CommandExecutor, ExecutionOutcome};
use crate::process::{ProcessExecutor, ProcessPolicy};
use crate::protocol::{
    ApprovalDecision, CommandOperation, CommandRequest, ErrorCode, PermissionDomain, RiskLevel,
    TelechirError,
};

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
    use serde_json::{Map, json};

    use super::*;

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
}
