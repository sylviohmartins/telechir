use std::path::PathBuf;

use thiserror::Error;

use crate::protocol::{ConnectionLimits, PROTOCOL_VERSION};
use crate::sandbox::{
    DEFAULT_SANDBOX_CPU_MILLIS, DEFAULT_SANDBOX_MEMORY_MIB, DEFAULT_SANDBOX_PIDS_LIMIT,
    DEFAULT_SANDBOX_TMPFS_MIB, DockerSandboxConfig, SANDBOX_CAPABILITY,
};

const SANDBOX_ENABLED_ENV: &str = "TELECHIR_SANDBOX_ENABLED";
const SANDBOX_DOCKER_BINARY_ENV: &str = "TELECHIR_SANDBOX_DOCKER_BINARY";
const SANDBOX_IMAGE_ENV: &str = "TELECHIR_SANDBOX_IMAGE";
const SANDBOX_MEMORY_MIB_ENV: &str = "TELECHIR_SANDBOX_MEMORY_MIB";
const SANDBOX_CPU_MILLIS_ENV: &str = "TELECHIR_SANDBOX_CPU_MILLIS";
const SANDBOX_PIDS_LIMIT_ENV: &str = "TELECHIR_SANDBOX_PIDS_LIMIT";
const SANDBOX_TMPFS_MIB_ENV: &str = "TELECHIR_SANDBOX_TMPFS_MIB";
const COMPUTER_SCREEN_ENABLED_ENV: &str = "TELECHIR_COMPUTER_SCREEN_ENABLED";
const COMPUTER_INPUT_ENABLED_ENV: &str = "TELECHIR_COMPUTER_INPUT_ENABLED";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentConfig {
    pub protocol_version: String,
    pub max_recent_commands: usize,
    pub limits: ConnectionLimits,
    pub sandbox: Option<DockerSandboxConfig>,
    pub computer_screen_enabled: bool,
    pub computer_input_enabled: bool,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            max_recent_commands: 1024,
            limits: ConnectionLimits::default(),
            sandbox: None,
            computer_screen_enabled: false,
            computer_input_enabled: false,
        }
    }
}

impl AgentConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    fn from_lookup<F>(lookup: F) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let enabled = match lookup(SANDBOX_ENABLED_ENV).as_deref() {
            None | Some("") | Some("false") => false,
            Some("true") => true,
            Some(_) => {
                return Err(ConfigError::InvalidSandboxConfig(
                    "TELECHIR_SANDBOX_ENABLED must be true or false".to_owned(),
                ));
            }
        };

        let sandbox_keys = [
            SANDBOX_DOCKER_BINARY_ENV,
            SANDBOX_IMAGE_ENV,
            SANDBOX_MEMORY_MIB_ENV,
            SANDBOX_CPU_MILLIS_ENV,
            SANDBOX_PIDS_LIMIT_ENV,
            SANDBOX_TMPFS_MIB_ENV,
        ];
        if !enabled && sandbox_keys.iter().any(|name| lookup(name).is_some()) {
            return Err(ConfigError::InvalidSandboxConfig(
                "sandbox settings require TELECHIR_SANDBOX_ENABLED=true".to_owned(),
            ));
        }

        let computer_screen_enabled = optional_bool(&lookup, COMPUTER_SCREEN_ENABLED_ENV, false)?;
        let computer_input_enabled = optional_bool(&lookup, COMPUTER_INPUT_ENABLED_ENV, false)?;

        let sandbox = if enabled {
            let docker_binary = required_setting(&lookup, SANDBOX_DOCKER_BINARY_ENV)?;
            let image = required_setting(&lookup, SANDBOX_IMAGE_ENV)?;
            let mut config = DockerSandboxConfig::new(PathBuf::from(docker_binary), image);
            config.memory_mib =
                optional_number(&lookup, SANDBOX_MEMORY_MIB_ENV, DEFAULT_SANDBOX_MEMORY_MIB)?;
            config.cpu_millis =
                optional_number(&lookup, SANDBOX_CPU_MILLIS_ENV, DEFAULT_SANDBOX_CPU_MILLIS)?;
            config.pids_limit =
                optional_number(&lookup, SANDBOX_PIDS_LIMIT_ENV, DEFAULT_SANDBOX_PIDS_LIMIT)?;
            config.tmpfs_mib =
                optional_number(&lookup, SANDBOX_TMPFS_MIB_ENV, DEFAULT_SANDBOX_TMPFS_MIB)?;
            Some(config)
        } else {
            None
        };

        let config = Self {
            sandbox,
            computer_screen_enabled,
            computer_input_enabled,
            ..Self::default()
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ConfigError::UnsupportedProtocol(
                self.protocol_version.clone(),
            ));
        }
        if self.max_recent_commands == 0 {
            return Err(ConfigError::InvalidRecentCommandCapacity);
        }
        self.limits
            .validate()
            .map_err(ConfigError::InvalidConnectionLimits)?;
        if let Some(sandbox) = &self.sandbox {
            sandbox
                .validate()
                .map_err(ConfigError::InvalidSandboxConfig)?;
        }
        if (self.computer_screen_enabled || self.computer_input_enabled) && !cfg!(windows) {
            return Err(ConfigError::InvalidComputerUseConfig(
                "computer use is implemented only for Windows in Phase 13".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn sandbox_enabled(&self) -> bool {
        self.sandbox.is_some()
    }

    pub fn augment_capabilities(&self, capabilities: &mut Vec<String>) {
        if self.sandbox_enabled()
            && !capabilities
                .iter()
                .any(|capability| capability == SANDBOX_CAPABILITY)
        {
            capabilities.push(SANDBOX_CAPABILITY.to_owned());
        }
        if self.computer_screen_enabled
            && cfg!(windows)
            && !capabilities
                .iter()
                .any(|capability| capability == crate::computer::SCREEN_CAPTURE_CAPABILITY)
        {
            capabilities.push(crate::computer::SCREEN_CAPTURE_CAPABILITY.to_owned());
        }
        if self.computer_input_enabled
            && cfg!(windows)
            && !capabilities
                .iter()
                .any(|capability| capability == crate::computer::INPUT_CONTROL_CAPABILITY)
        {
            capabilities.push(crate::computer::INPUT_CONTROL_CAPABILITY.to_owned());
        }
    }
}

fn required_setting<F>(lookup: &F, name: &str) -> Result<String, ConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    lookup(name)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ConfigError::InvalidSandboxConfig(format!("{name} is required when sandbox is enabled"))
        })
}

fn optional_bool<F>(lookup: &F, name: &str, default: bool) -> Result<bool, ConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    match lookup(name).as_deref() {
        None | Some("") => Ok(default),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => Err(ConfigError::InvalidComputerUseConfig(format!(
            "{name} must be true or false"
        ))),
    }
}

fn optional_number<T, F>(lookup: &F, name: &str, default: T) -> Result<T, ConfigError>
where
    T: std::str::FromStr + Copy,
    F: Fn(&str) -> Option<String>,
{
    let Some(value) = lookup(name) else {
        return Ok(default);
    };
    value.parse::<T>().map_err(|_| {
        ConfigError::InvalidSandboxConfig(format!("{name} must be a valid positive integer"))
    })
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("unsupported protocol version: {0}")]
    UnsupportedProtocol(String),
    #[error("max_recent_commands must be greater than zero")]
    InvalidRecentCommandCapacity,
    #[error("invalid connection limits: {0}")]
    InvalidConnectionLimits(String),
    #[error("invalid sandbox configuration: {0}")]
    InvalidSandboxConfig(String),
    #[error("invalid computer-use configuration: {0}")]
    InvalidComputerUseConfig(String),
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;

    use super::*;

    #[test]
    fn defaults_are_valid_and_sandbox_is_disabled() {
        let config = AgentConfig::default();
        config.validate().unwrap();
        assert!(!config.sandbox_enabled());
        assert!(!config.computer_screen_enabled);
        assert!(!config.computer_input_enabled);
    }

    #[test]
    fn zero_recent_command_capacity_is_rejected() {
        let config = AgentConfig {
            max_recent_commands: 0,
            ..AgentConfig::default()
        };

        assert_eq!(
            config.validate(),
            Err(ConfigError::InvalidRecentCommandCapacity)
        );
    }

    #[test]
    fn sandbox_environment_is_explicit_and_fail_closed() {
        let mut settings = HashMap::<String, String>::new();
        settings.insert(
            SANDBOX_DOCKER_BINARY_ENV.to_owned(),
            "/tmp/docker".to_owned(),
        );
        let error = AgentConfig::from_lookup(|name| settings.get(name).cloned()).unwrap_err();
        assert!(matches!(error, ConfigError::InvalidSandboxConfig(_)));

        settings.insert(SANDBOX_ENABLED_ENV.to_owned(), "true".to_owned());
        let error = AgentConfig::from_lookup(|name| settings.get(name).cloned()).unwrap_err();
        assert!(matches!(error, ConfigError::InvalidSandboxConfig(_)));
    }

    #[cfg(not(windows))]
    #[test]
    fn computer_use_configuration_fails_closed_on_unsupported_platform() {
        let settings = HashMap::from([
            (COMPUTER_SCREEN_ENABLED_ENV.to_owned(), "true".to_owned()),
            (COMPUTER_INPUT_ENABLED_ENV.to_owned(), "true".to_owned()),
        ]);

        let error = AgentConfig::from_lookup(|name| settings.get(name).cloned()).unwrap_err();
        assert!(matches!(error, ConfigError::InvalidComputerUseConfig(_)));
    }

    #[test]
    fn enabled_sandbox_validates_and_advertises_capability() {
        let root = tempfile::tempdir().unwrap();
        let docker = root.path().join("docker");
        fs::write(&docker, b"fake docker").unwrap();

        let settings = HashMap::from([
            (SANDBOX_ENABLED_ENV.to_owned(), "true".to_owned()),
            (
                SANDBOX_DOCKER_BINARY_ENV.to_owned(),
                docker.to_string_lossy().into_owned(),
            ),
            (
                SANDBOX_IMAGE_ENV.to_owned(),
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_owned(),
            ),
            (SANDBOX_MEMORY_MIB_ENV.to_owned(), "768".to_owned()),
            (SANDBOX_CPU_MILLIS_ENV.to_owned(), "1500".to_owned()),
            (SANDBOX_PIDS_LIMIT_ENV.to_owned(), "96".to_owned()),
            (SANDBOX_TMPFS_MIB_ENV.to_owned(), "64".to_owned()),
        ]);

        let config = AgentConfig::from_lookup(|name| settings.get(name).cloned()).unwrap();
        let sandbox = config.sandbox.as_ref().unwrap();
        assert_eq!(sandbox.memory_mib, 768);
        assert_eq!(sandbox.cpu_millis, 1500);
        assert_eq!(sandbox.pids_limit, 96);
        assert_eq!(sandbox.tmpfs_mib, 64);

        let mut capabilities = vec!["shell.exec".to_owned()];
        config.augment_capabilities(&mut capabilities);
        config.augment_capabilities(&mut capabilities);
        assert_eq!(
            capabilities
                .iter()
                .filter(|value| value.as_str() == SANDBOX_CAPABILITY)
                .count(),
            1
        );
    }
}
