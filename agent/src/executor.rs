use std::convert::Infallible;

use crate::filesystem::{FilesystemExecutor, FilesystemPolicy};
use crate::ports::{CommandExecutor, ExecutionOutcome};
use crate::process::{ProcessExecutor, ProcessPolicy};
use crate::protocol::{CommandOperation, CommandRequest, ErrorCode, TelechirError};

pub struct LocalCommandExecutor {
    filesystem: FilesystemExecutor,
    process: ProcessExecutor,
}

impl LocalCommandExecutor {
    pub fn new(filesystem_policy: FilesystemPolicy) -> Self {
        let process_policy = ProcessPolicy::new(filesystem_policy.clone());
        Self {
            filesystem: FilesystemExecutor::new(filesystem_policy),
            process: ProcessExecutor::new(process_policy),
        }
    }

    pub fn filesystem(&self) -> &FilesystemExecutor {
        &self.filesystem
    }

    pub fn process(&self) -> &ProcessExecutor {
        &self.process
    }
}

impl CommandExecutor for LocalCommandExecutor {
    type Error = Infallible;

    fn execute(&mut self, request: &CommandRequest) -> Result<ExecutionOutcome, Self::Error> {
        let outcome = match request.operation {
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
            | CommandOperation::ProcessList => self.process.execute(request).unwrap(),
            CommandOperation::GitStatus
            | CommandOperation::GitDiff
            | CommandOperation::SystemMetrics => ExecutionOutcome::Failed(TelechirError {
                code: ErrorCode::UnsupportedCapability,
                message: "operation is not enabled in the current Telechir phase".to_owned(),
                retryable: false,
                retry_after_ms: None,
                details: None,
            }),
        };
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Map;

    use super::*;
    use crate::protocol::{PermissionDomain, RiskLevel};

    #[test]
    fn composite_executor_keeps_phase8_operations_disabled() {
        let root = tempfile::tempdir().unwrap();
        let policy = FilesystemPolicy::new([root.path()]).unwrap();
        let mut executor = LocalCommandExecutor::new(policy);
        let request = CommandRequest {
            command_id: "cmd_phase7_composite".to_owned(),
            idempotency_key: None,
            operation: CommandOperation::GitStatus,
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
}
