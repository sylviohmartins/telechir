use chrono::{DateTime, Utc};

use crate::protocol::{
    ApprovalDecision, ApprovalRequest, CommandRequest, DeviceMessage, TelechirError,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone)]
pub enum AuthorizationOutcome {
    Allow {
        request: CommandRequest,
        approval_verified: bool,
    },
    Ask(ApprovalRequest),
    Deny(TelechirError),
}

pub trait PolicyEngine {
    fn authorize(&self, request: &CommandRequest) -> PolicyDecision;
}

pub trait Clock {
    fn now(&self) -> DateTime<Utc>;
}

pub trait Transport {
    type Error;

    fn send(&mut self, message: &DeviceMessage) -> Result<(), Self::Error>;
}

pub trait CommandExecutor {
    type Error;

    fn authorize(
        &mut self,
        request: &CommandRequest,
        _session_id: Option<&str>,
    ) -> AuthorizationOutcome {
        AuthorizationOutcome::Allow {
            request: request.clone(),
            approval_verified: false,
        }
    }

    fn apply_approval_decision(&mut self, _decision: &ApprovalDecision, _session_id: Option<&str>) {
    }

    fn execute_authorized(
        &mut self,
        request: &CommandRequest,
        _approval_verified: bool,
    ) -> Result<ExecutionOutcome, Self::Error> {
        self.execute(request)
    }

    fn execute(&mut self, request: &CommandRequest) -> Result<ExecutionOutcome, Self::Error>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExecutionOutcome {
    Completed(serde_json::Value),
    Failed(TelechirError),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_port_remains_object_safe() {
        fn assert_object_safe(_: &dyn PolicyEngine) {}

        struct DenyAll;
        impl PolicyEngine for DenyAll {
            fn authorize(&self, _: &CommandRequest) -> PolicyDecision {
                PolicyDecision::Deny
            }
        }

        let engine = DenyAll;
        assert_object_safe(&engine);
        assert_eq!(
            engine.authorize(&CommandRequest::test_read_only()),
            PolicyDecision::Deny
        );
    }
}
