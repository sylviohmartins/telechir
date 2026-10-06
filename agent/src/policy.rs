use std::collections::{HashMap, VecDeque};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::ports::{AuthorizationOutcome, PolicyDecision};
use crate::protocol::{
    ApprovalDecision, ApprovalDecisionKind, ApprovalRequest, ApprovalScope, CommandOperation,
    CommandRequest, ErrorCode, PermissionDomain, RiskLevel, TelechirError,
};

pub const LOCAL_POLICY_REVISION: &str = "phase9-default-v1";
pub const APPROVAL_TTL_SECONDS: i64 = 60;
const LOCAL_CRITICAL_TTL_SECONDS: i64 = 30;
const MAX_LOCAL_AUDIT_EVENTS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocalPolicyAuditEvent {
    pub event_id: String,
    pub event_type: String,
    pub command_id: String,
    pub policy_revision: String,
    pub decision: String,
    pub risk: String,
    pub approval_id: Option<String>,
    pub argument_digest: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct ApprovalBinding {
    approval_id: String,
    command_id: String,
    session_id: String,
    permission: PermissionDomain,
    risk: RiskLevel,
    argument_digest: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct ApprovalGrant {
    binding: ApprovalBinding,
    scope: ApprovalScope,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalCriticalAuthorization {
    pub(crate) request: CommandRequest,
    pub(crate) session_id: String,
    pub(crate) argument_digest: String,
    pub(crate) expires_at: DateTime<Utc>,
}

#[derive(Debug, Default)]
pub struct LocalPolicyEngine {
    pending: HashMap<String, ApprovalBinding>,
    grants: HashMap<String, ApprovalGrant>,
    audit: VecDeque<LocalPolicyAuditEvent>,
}

impl LocalPolicyEngine {
    pub fn authorize(
        &mut self,
        request: &CommandRequest,
        session_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> AuthorizationOutcome {
        let mut prepared = request.clone();
        let effective_risk = max_risk(request.risk, minimum_risk(request.operation));
        prepared.risk = effective_risk;
        let digest = match command_argument_digest(&prepared) {
            Ok(value) => value,
            Err(error) => {
                return AuthorizationOutcome::Deny(error);
            }
        };

        if let Err(error) = validate_phase_permission_operation(&prepared) {
            self.record(
                "POLICY_DENIED",
                &prepared,
                PolicyDecision::Deny,
                prepared.approval_id.as_deref(),
                &digest,
                now,
            );
            return AuthorizationOutcome::Deny(error);
        }

        if let Some(permission) = prepared
            .requested_permissions
            .iter()
            .copied()
            .find(|permission| hard_denied_permission(*permission))
        {
            let error = policy_error(format!(
                "permission {} is outside the Phase 9 local authority ceiling",
                permission.as_str()
            ));
            self.record(
                "POLICY_DENIED",
                &prepared,
                PolicyDecision::Deny,
                prepared.approval_id.as_deref(),
                &digest,
                now,
            );
            return AuthorizationOutcome::Deny(error);
        }

        if effective_risk == RiskLevel::Critical {
            let error = policy_error(
                "CRITICAL operations require local-only confirmation and are denied without a local confirmation surface",
            );
            self.record(
                "POLICY_DENIED",
                &prepared,
                PolicyDecision::Deny,
                prepared.approval_id.as_deref(),
                &digest,
                now,
            );
            return AuthorizationOutcome::Deny(error);
        }

        if let Some(approval_id) = prepared.approval_id.clone() {
            return self.authorize_with_grant(prepared, session_id, &approval_id, digest, now);
        }

        if effective_risk == RiskLevel::High {
            let Some(session_id) = valid_session_id(session_id) else {
                let error = policy_error("HIGH-risk approval requires a bounded session identity");
                self.record(
                    "POLICY_DENIED",
                    &prepared,
                    PolicyDecision::Deny,
                    None,
                    &digest,
                    now,
                );
                return AuthorizationOutcome::Deny(error);
            };
            let approval = self.create_approval(
                &prepared,
                session_id,
                approval_permission(&prepared),
                effective_risk,
                "Operação HIGH requer aprovação explícita do Telechir.",
                now,
            );
            return AuthorizationOutcome::Ask(approval);
        }

        self.record(
            "POLICY_ALLOWED",
            &prepared,
            PolicyDecision::Allow,
            None,
            &digest,
            now,
        );
        AuthorizationOutcome::Allow {
            request: prepared,
            approval_verified: false,
        }
    }

    pub(crate) fn prepare_local_critical(
        &mut self,
        request: &CommandRequest,
        session_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<LocalCriticalAuthorization, TelechirError> {
        let mut prepared = request.clone();
        prepared.risk = max_risk(request.risk, minimum_risk(request.operation));
        let digest = command_argument_digest(&prepared)?;

        if let Err(error) = validate_phase_permission_operation(&prepared) {
            self.record(
                "POLICY_DENIED",
                &prepared,
                PolicyDecision::Deny,
                prepared.approval_id.as_deref(),
                &digest,
                now,
            );
            return Err(error);
        }

        if let Some(permission) = prepared
            .requested_permissions
            .iter()
            .copied()
            .find(|permission| hard_denied_permission(*permission))
        {
            let error = policy_error(format!(
                "permission {} is outside the local authority ceiling",
                permission.as_str()
            ));
            self.record(
                "POLICY_DENIED",
                &prepared,
                PolicyDecision::Deny,
                prepared.approval_id.as_deref(),
                &digest,
                now,
            );
            return Err(error);
        }

        if prepared.risk != RiskLevel::Critical {
            let error = policy_error(
                "local critical confirmation path is reserved for CRITICAL operations",
            );
            self.record(
                "POLICY_DENIED",
                &prepared,
                PolicyDecision::Deny,
                prepared.approval_id.as_deref(),
                &digest,
                now,
            );
            return Err(error);
        }
        if prepared.approval_id.is_some() {
            let error =
                policy_error("CRITICAL local confirmation cannot be substituted by an approval_id");
            self.record(
                "POLICY_DENIED",
                &prepared,
                PolicyDecision::Deny,
                prepared.approval_id.as_deref(),
                &digest,
                now,
            );
            return Err(error);
        }
        let Some(session_id) = valid_session_id(session_id) else {
            let error = policy_error("CRITICAL computer input requires a bounded session identity");
            self.record(
                "POLICY_DENIED",
                &prepared,
                PolicyDecision::Deny,
                None,
                &digest,
                now,
            );
            return Err(error);
        };

        Ok(LocalCriticalAuthorization {
            request: prepared,
            session_id: session_id.to_owned(),
            argument_digest: digest,
            expires_at: now + Duration::seconds(LOCAL_CRITICAL_TTL_SECONDS),
        })
    }

    pub(crate) fn finish_local_critical(
        &mut self,
        authorization: LocalCriticalAuthorization,
        confirmed: bool,
        session_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> AuthorizationOutcome {
        if valid_session_id(session_id) != Some(authorization.session_id.as_str()) {
            return AuthorizationOutcome::Deny(policy_error(
                "CRITICAL local confirmation session binding changed before execution",
            ));
        }
        if now > authorization.expires_at {
            return AuthorizationOutcome::Deny(policy_error(
                "CRITICAL local confirmation expired before execution",
            ));
        }
        let digest = match command_argument_digest(&authorization.request) {
            Ok(value) => value,
            Err(error) => return AuthorizationOutcome::Deny(error),
        };
        if digest != authorization.argument_digest {
            let error =
                policy_error("CRITICAL local confirmation binding changed before execution");
            self.record(
                "POLICY_DENIED",
                &authorization.request,
                PolicyDecision::Deny,
                None,
                &digest,
                now,
            );
            return AuthorizationOutcome::Deny(error);
        }

        if !confirmed {
            let error = policy_error("CRITICAL operation was not approved on the local device");
            self.record(
                "LOCAL_CONFIRMATION_DENIED",
                &authorization.request,
                PolicyDecision::Deny,
                None,
                &digest,
                now,
            );
            return AuthorizationOutcome::Deny(error);
        }

        self.record(
            "LOCAL_CONFIRMATION_APPROVED",
            &authorization.request,
            PolicyDecision::Allow,
            None,
            &digest,
            now,
        );
        AuthorizationOutcome::Allow {
            request: authorization.request,
            approval_verified: false,
        }
    }

    pub fn request_approval(
        &mut self,
        request: &CommandRequest,
        session_id: Option<&str>,
        permission: PermissionDomain,
        risk: RiskLevel,
        human_summary: &str,
        now: DateTime<Utc>,
    ) -> Result<ApprovalRequest, TelechirError> {
        let session_id = valid_session_id(session_id).ok_or_else(|| {
            policy_error("approval-required operation has no bounded session identity")
        })?;
        Ok(self.create_approval(request, session_id, permission, risk, human_summary, now))
    }

    pub fn apply_decision(
        &mut self,
        decision: &ApprovalDecision,
        session_id: Option<&str>,
        now: DateTime<Utc>,
    ) {
        let Some(binding) = self.pending.remove(&decision.approval_id) else {
            return;
        };
        let session_matches =
            valid_session_id(session_id).is_some_and(|id| id == binding.session_id);
        let valid_time = now <= binding.expires_at && decision.decided_at <= binding.expires_at;

        if !session_matches || !valid_time {
            self.record_binding("APPROVAL_REJECTED", &binding, PolicyDecision::Deny, now);
            return;
        }

        match decision.decision {
            ApprovalDecisionKind::Approve => {
                self.grants.insert(
                    binding.approval_id.clone(),
                    ApprovalGrant {
                        binding: binding.clone(),
                        scope: decision.scope,
                    },
                );
                self.record_binding("APPROVAL_APPROVED", &binding, PolicyDecision::Allow, now);
            }
            ApprovalDecisionKind::Deny => {
                self.record_binding("APPROVAL_DENIED", &binding, PolicyDecision::Deny, now);
            }
        }
    }

    pub fn audit_events(&self) -> &VecDeque<LocalPolicyAuditEvent> {
        &self.audit
    }

    fn authorize_with_grant(
        &mut self,
        prepared: CommandRequest,
        session_id: Option<&str>,
        approval_id: &str,
        digest: String,
        now: DateTime<Utc>,
    ) -> AuthorizationOutcome {
        let Some(grant) = self.grants.get(approval_id).cloned() else {
            let error = policy_error("approval_id is not backed by an agent-issued approval");
            self.record(
                "POLICY_DENIED",
                &prepared,
                PolicyDecision::Deny,
                Some(approval_id),
                &digest,
                now,
            );
            return AuthorizationOutcome::Deny(error);
        };

        let session_matches =
            valid_session_id(session_id).is_some_and(|id| id == grant.binding.session_id);
        let permission_matches = prepared
            .requested_permissions
            .contains(&grant.binding.permission);
        let risk_matches = risk_rank(prepared.risk) <= risk_rank(grant.binding.risk);
        let valid = session_matches
            && permission_matches
            && risk_matches
            && digest == grant.binding.argument_digest
            && prepared.command_id == grant.binding.command_id
            && now <= grant.binding.expires_at;

        if !valid {
            let error = policy_error(
                "approval binding does not match command, session, permission, risk, digest, or TTL",
            );
            self.record(
                "POLICY_DENIED",
                &prepared,
                PolicyDecision::Deny,
                Some(approval_id),
                &digest,
                now,
            );
            return AuthorizationOutcome::Deny(error);
        }

        if grant.scope == ApprovalScope::Once {
            self.grants.remove(approval_id);
        }

        self.record(
            "POLICY_ALLOWED_WITH_APPROVAL",
            &prepared,
            PolicyDecision::Allow,
            Some(approval_id),
            &digest,
            now,
        );
        AuthorizationOutcome::Allow {
            request: prepared,
            approval_verified: true,
        }
    }

    fn create_approval(
        &mut self,
        request: &CommandRequest,
        session_id: &str,
        permission: PermissionDomain,
        risk: RiskLevel,
        human_summary: &str,
        now: DateTime<Utc>,
    ) -> ApprovalRequest {
        let digest = command_argument_digest(request).unwrap_or_else(|_| "invalid".to_owned());

        if let Some(existing) = self
            .pending
            .values()
            .find(|binding| {
                binding.command_id == request.command_id
                    && binding.session_id == session_id
                    && binding.permission == permission
                    && binding.argument_digest == digest
                    && binding.expires_at > now
            })
            .cloned()
        {
            return ApprovalRequest {
                approval_id: existing.approval_id,
                command_id: existing.command_id,
                permission: existing.permission,
                risk: existing.risk,
                argument_digest: existing.argument_digest,
                human_summary: Some(human_summary.to_owned()),
                expires_at: existing.expires_at,
            };
        }

        let approval_id = format!("approval_{}", Uuid::new_v4());
        let expires_at = now + Duration::seconds(APPROVAL_TTL_SECONDS);
        let binding = ApprovalBinding {
            approval_id: approval_id.clone(),
            command_id: request.command_id.clone(),
            session_id: session_id.to_owned(),
            permission,
            risk,
            argument_digest: digest.clone(),
            expires_at,
        };
        self.pending.insert(approval_id.clone(), binding.clone());
        self.record_binding("APPROVAL_REQUESTED", &binding, PolicyDecision::Ask, now);

        ApprovalRequest {
            approval_id,
            command_id: request.command_id.clone(),
            permission,
            risk,
            argument_digest: digest,
            human_summary: Some(human_summary.to_owned()),
            expires_at,
        }
    }

    fn record(
        &mut self,
        event_type: &str,
        request: &CommandRequest,
        decision: PolicyDecision,
        approval_id: Option<&str>,
        argument_digest: &str,
        now: DateTime<Utc>,
    ) {
        self.push_audit(LocalPolicyAuditEvent {
            event_id: format!("audit_{}", Uuid::new_v4()),
            event_type: event_type.to_owned(),
            command_id: request.command_id.clone(),
            policy_revision: LOCAL_POLICY_REVISION.to_owned(),
            decision: decision_name(decision).to_owned(),
            risk: request.risk.as_str().to_owned(),
            approval_id: approval_id.map(str::to_owned),
            argument_digest: argument_digest.to_owned(),
            created_at: now,
        });
    }

    fn record_binding(
        &mut self,
        event_type: &str,
        binding: &ApprovalBinding,
        decision: PolicyDecision,
        now: DateTime<Utc>,
    ) {
        self.push_audit(LocalPolicyAuditEvent {
            event_id: format!("audit_{}", Uuid::new_v4()),
            event_type: event_type.to_owned(),
            command_id: binding.command_id.clone(),
            policy_revision: LOCAL_POLICY_REVISION.to_owned(),
            decision: decision_name(decision).to_owned(),
            risk: binding.risk.as_str().to_owned(),
            approval_id: Some(binding.approval_id.clone()),
            argument_digest: binding.argument_digest.clone(),
            created_at: now,
        });
    }

    fn push_audit(&mut self, event: LocalPolicyAuditEvent) {
        if self.audit.len() >= MAX_LOCAL_AUDIT_EVENTS {
            self.audit.pop_front();
        }
        self.audit.push_back(event);
    }
}

pub fn command_argument_digest(request: &CommandRequest) -> Result<String, TelechirError> {
    #[derive(Serialize)]
    struct Binding<'a> {
        operation: &'a str,
        arguments: &'a serde_json::Map<String, serde_json::Value>,
        requested_permissions: Vec<&'a str>,
    }

    let mut permissions = request
        .requested_permissions
        .iter()
        .map(|permission| permission.as_str())
        .collect::<Vec<_>>();
    permissions.sort_unstable();

    let binding = Binding {
        operation: request.operation.as_str(),
        arguments: &request.arguments,
        requested_permissions: permissions,
    };
    let encoded = serde_json::to_vec(&binding).map_err(|_| TelechirError {
        code: ErrorCode::InternalError,
        message: "approval binding cannot be serialized".to_owned(),
        retryable: false,
        retry_after_ms: None,
        details: None,
    })?;
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(encoded)))
}

pub const fn minimum_risk(operation: CommandOperation) -> RiskLevel {
    match operation {
        CommandOperation::FsWrite
        | CommandOperation::FsPatch
        | CommandOperation::ShellExec
        | CommandOperation::ProcessStart
        | CommandOperation::ProcessWrite
        | CommandOperation::ProcessCancel => RiskLevel::Medium,
        CommandOperation::ScreenCapture => RiskLevel::High,
        CommandOperation::ComputerInput => RiskLevel::Critical,
        _ => RiskLevel::Low,
    }
}

fn approval_permission(request: &CommandRequest) -> PermissionDomain {
    const PRIORITY: [PermissionDomain; 5] = [
        PermissionDomain::ScreenRead,
        PermissionDomain::ShellSafe,
        PermissionDomain::FsWrite,
        PermissionDomain::ProcessControl,
        PermissionDomain::FsRead,
    ];
    PRIORITY
        .into_iter()
        .find(|permission| request.requested_permissions.contains(permission))
        .or_else(|| request.requested_permissions.first().copied())
        .unwrap_or(PermissionDomain::FsRead)
}

fn hard_denied_permission(permission: PermissionDomain) -> bool {
    matches!(
        permission,
        PermissionDomain::FsDelete
            | PermissionDomain::ShellFull
            | PermissionDomain::Network
            | PermissionDomain::GitWrite
            | PermissionDomain::GitRemoteWrite
            | PermissionDomain::Browser
            | PermissionDomain::SecretUse
            | PermissionDomain::Elevation
            | PermissionDomain::Admin
    )
}

fn validate_phase_permission_operation(request: &CommandRequest) -> Result<(), TelechirError> {
    let exact = match request.operation {
        CommandOperation::ScreenCapture => Some(PermissionDomain::ScreenRead),
        CommandOperation::ComputerInput => Some(PermissionDomain::InputControl),
        _ => None,
    };
    if let Some(required) = exact
        && request.requested_permissions.as_slice() != [required]
    {
        return Err(policy_error(format!(
            "operation {} requires exactly permission {}",
            request.operation.as_str(),
            required.as_str()
        )));
    }

    if request
        .requested_permissions
        .contains(&PermissionDomain::ScreenRead)
        && request.operation != CommandOperation::ScreenCapture
    {
        return Err(policy_error(
            "SCREEN_READ is valid only for the screen.capture operation",
        ));
    }
    if request
        .requested_permissions
        .contains(&PermissionDomain::InputControl)
        && request.operation != CommandOperation::ComputerInput
    {
        return Err(policy_error(
            "INPUT_CONTROL is valid only for the computer.input operation",
        ));
    }
    Ok(())
}

const fn max_risk(left: RiskLevel, right: RiskLevel) -> RiskLevel {
    if risk_rank(left) >= risk_rank(right) {
        left
    } else {
        right
    }
}

const fn risk_rank(risk: RiskLevel) -> u8 {
    match risk {
        RiskLevel::Low => 0,
        RiskLevel::Medium => 1,
        RiskLevel::High => 2,
        RiskLevel::Critical => 3,
    }
}

fn valid_session_id(session_id: Option<&str>) -> Option<&str> {
    session_id.filter(|value| (3..=128).contains(&value.len()))
}

const fn decision_name(decision: PolicyDecision) -> &'static str {
    match decision {
        PolicyDecision::Allow => "ALLOW",
        PolicyDecision::Ask => "ASK",
        PolicyDecision::Deny => "DENY",
    }
}

fn policy_error(message: impl Into<String>) -> TelechirError {
    TelechirError {
        code: ErrorCode::PolicyDenied,
        message: message.into(),
        retryable: false,
        retry_after_ms: None,
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn request(operation: CommandOperation, risk: RiskLevel) -> CommandRequest {
        CommandRequest {
            command_id: "cmd_policy_phase9".to_owned(),
            idempotency_key: operation
                .has_side_effect()
                .then(|| "idem_policy_phase9".to_owned()),
            operation,
            arguments: json!({"path": "src/lib.rs"}).as_object().unwrap().clone(),
            requested_permissions: vec![match operation {
                CommandOperation::FsWrite | CommandOperation::FsPatch => PermissionDomain::FsWrite,
                CommandOperation::ShellExec | CommandOperation::ProcessStart => {
                    PermissionDomain::ShellSafe
                }
                _ => PermissionDomain::FsRead,
            }],
            risk,
            workspace_id: None,
            approval_id: None,
        }
    }

    #[test]
    fn cloud_cannot_lower_local_minimum_risk() {
        let mut policy = LocalPolicyEngine::default();
        let authorization = policy.authorize(
            &request(CommandOperation::FsWrite, RiskLevel::Low),
            Some("session_phase9"),
            Utc::now(),
        );
        match authorization {
            AuthorizationOutcome::Allow { request, .. } => {
                assert_eq!(request.risk, RiskLevel::Medium);
            }
            other => panic!("unexpected authorization: {other:?}"),
        }
    }

    #[test]
    fn critical_is_fail_closed_without_local_confirmation_surface() {
        let mut policy = LocalPolicyEngine::default();
        assert!(matches!(
            policy.authorize(
                &request(CommandOperation::FsWrite, RiskLevel::Critical),
                Some("session_phase9"),
                Utc::now(),
            ),
            AuthorizationOutcome::Deny(TelechirError {
                code: ErrorCode::PolicyDenied,
                ..
            })
        ));
    }

    #[test]
    fn approval_is_payload_and_session_bound_and_once_is_consumed() {
        let now = Utc::now();
        let mut policy = LocalPolicyEngine::default();
        let original = request(CommandOperation::ShellExec, RiskLevel::Medium);
        let approval = policy
            .request_approval(
                &original,
                Some("session_phase9"),
                PermissionDomain::ShellSafe,
                RiskLevel::High,
                "approval test",
                now,
            )
            .unwrap();
        policy.apply_decision(
            &ApprovalDecision {
                approval_id: approval.approval_id.clone(),
                decision: ApprovalDecisionKind::Approve,
                decided_at: now,
                scope: ApprovalScope::Once,
            },
            Some("session_phase9"),
            now,
        );

        let mut retry = original.clone();
        retry.approval_id = Some(approval.approval_id.clone());
        assert!(matches!(
            policy.authorize(&retry, Some("session_phase9"), now),
            AuthorizationOutcome::Allow {
                approval_verified: true,
                ..
            }
        ));
        assert!(matches!(
            policy.authorize(&retry, Some("session_phase9"), now),
            AuthorizationOutcome::Deny(_)
        ));

        let mut changed = original;
        changed.command_id = "cmd_policy_phase9_other".to_owned();
        changed.approval_id = Some(approval.approval_id);
        assert!(matches!(
            policy.authorize(&changed, Some("session_phase9"), now),
            AuthorizationOutcome::Deny(_)
        ));
    }

    #[test]
    fn expired_approval_never_grants() {
        let now = Utc::now();
        let mut policy = LocalPolicyEngine::default();
        let original = request(CommandOperation::ShellExec, RiskLevel::Medium);
        let approval = policy
            .request_approval(
                &original,
                Some("session_phase9"),
                PermissionDomain::ShellSafe,
                RiskLevel::High,
                "approval test",
                now,
            )
            .unwrap();
        let after_expiry = now + Duration::seconds(APPROVAL_TTL_SECONDS + 1);
        policy.apply_decision(
            &ApprovalDecision {
                approval_id: approval.approval_id.clone(),
                decision: ApprovalDecisionKind::Approve,
                decided_at: after_expiry,
                scope: ApprovalScope::Once,
            },
            Some("session_phase9"),
            after_expiry,
        );
        let mut retry = original;
        retry.approval_id = Some(approval.approval_id);
        assert!(matches!(
            policy.authorize(&retry, Some("session_phase9"), after_expiry),
            AuthorizationOutcome::Deny(_)
        ));
    }

    fn computer_request(
        operation: CommandOperation,
        permission: PermissionDomain,
        risk: RiskLevel,
        arguments: Value,
    ) -> CommandRequest {
        CommandRequest {
            command_id: "cmd_policy_phase13".to_owned(),
            idempotency_key: operation
                .has_side_effect()
                .then(|| "idem_policy_phase13".to_owned()),
            operation,
            arguments: arguments.as_object().unwrap().clone(),
            requested_permissions: vec![permission],
            risk,
            workspace_id: None,
            approval_id: None,
        }
    }

    #[test]
    fn screen_capture_is_raised_to_high_and_remains_approval_bound() {
        let mut policy = LocalPolicyEngine::default();
        let request = computer_request(
            CommandOperation::ScreenCapture,
            PermissionDomain::ScreenRead,
            RiskLevel::Low,
            json!({"max_width":256,"max_height":144}),
        );
        let authorization = policy.authorize(&request, Some("session_phase13"), Utc::now());
        assert!(matches!(authorization, AuthorizationOutcome::Ask(_)));
    }

    #[test]
    fn computer_input_requires_local_critical_path_and_rejects_remote_approval_id() {
        let now = Utc::now();
        let mut policy = LocalPolicyEngine::default();
        let mut request = computer_request(
            CommandOperation::ComputerInput,
            PermissionDomain::InputControl,
            RiskLevel::Low,
            json!({"action":{"kind":"move_pointer","x":10,"y":20}}),
        );

        assert!(matches!(
            policy.authorize(&request, Some("session_phase13"), now),
            AuthorizationOutcome::Deny(TelechirError {
                code: ErrorCode::PolicyDenied,
                ..
            })
        ));

        request.approval_id = Some("approval_remote_should_not_apply".to_owned());
        assert!(matches!(
            policy.prepare_local_critical(&request, Some("session_phase13"), now),
            Err(TelechirError {
                code: ErrorCode::PolicyDenied,
                ..
            })
        ));
    }

    #[test]
    fn local_critical_confirmation_is_argument_digest_bound() {
        let now = Utc::now();
        let mut policy = LocalPolicyEngine::default();
        let request = computer_request(
            CommandOperation::ComputerInput,
            PermissionDomain::InputControl,
            RiskLevel::Critical,
            json!({"action":{"kind":"click","x":100,"y":200,"button":"left","click_count":1}}),
        );
        let mut prepared = policy
            .prepare_local_critical(&request, Some("session_phase13"), now)
            .unwrap();

        prepared.request.arguments.insert(
            "action".to_owned(),
            json!({"kind":"click","x":101,"y":200,"button":"left","click_count":1}),
        );
        assert!(matches!(
            policy.finish_local_critical(prepared, true, Some("session_phase13"), now),
            AuthorizationOutcome::Deny(TelechirError {
                code: ErrorCode::PolicyDenied,
                ..
            })
        ));
    }

    #[test]
    fn local_critical_confirmation_rejects_session_swap_and_expiry() {
        let now = Utc::now();
        let mut policy = LocalPolicyEngine::default();
        let request = computer_request(
            CommandOperation::ComputerInput,
            PermissionDomain::InputControl,
            RiskLevel::Critical,
            json!({"action":{"kind":"move_pointer","x":10,"y":20}}),
        );

        let wrong_session = policy
            .prepare_local_critical(&request, Some("session_phase13"), now)
            .unwrap();
        assert!(matches!(
            policy.finish_local_critical(wrong_session, true, Some("session_phase13_other"), now,),
            AuthorizationOutcome::Deny(_)
        ));

        let expired = policy
            .prepare_local_critical(&request, Some("session_phase13"), now)
            .unwrap();
        assert!(matches!(
            policy.finish_local_critical(
                expired,
                true,
                Some("session_phase13"),
                now + Duration::seconds(LOCAL_CRITICAL_TTL_SECONDS + 1),
            ),
            AuthorizationOutcome::Deny(_)
        ));
    }

    #[test]
    fn computer_permissions_are_operation_scoped() {
        let now = Utc::now();
        let mut policy = LocalPolicyEngine::default();

        let wrong_screen = computer_request(
            CommandOperation::FsRead,
            PermissionDomain::ScreenRead,
            RiskLevel::High,
            json!({"path":"src/lib.rs"}),
        );
        assert!(matches!(
            policy.authorize(&wrong_screen, Some("session_phase13"), now),
            AuthorizationOutcome::Deny(_)
        ));

        let wrong_input = computer_request(
            CommandOperation::ScreenCapture,
            PermissionDomain::InputControl,
            RiskLevel::Critical,
            json!({}),
        );
        assert!(
            policy
                .prepare_local_critical(&wrong_input, Some("session_phase13"), now)
                .is_err()
        );
    }
}
