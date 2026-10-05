#[cfg(test)]
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub const SANDBOX_CAPABILITY: &str = "sandbox.docker";
pub const DEFAULT_SANDBOX_MEMORY_MIB: u64 = 512;
pub const DEFAULT_SANDBOX_CPU_MILLIS: u32 = 1_000;
pub const DEFAULT_SANDBOX_PIDS_LIMIT: u32 = 128;
pub const DEFAULT_SANDBOX_TMPFS_MIB: u64 = 128;

const MIN_MEMORY_MIB: u64 = 128;
const MAX_MEMORY_MIB: u64 = 16 * 1024;
const MIN_CPU_MILLIS: u32 = 100;
const MAX_CPU_MILLIS: u32 = 8_000;
const MIN_PIDS_LIMIT: u32 = 16;
const MAX_PIDS_LIMIT: u32 = 1_024;
const MIN_TMPFS_MIB: u64 = 16;
const MAX_TMPFS_MIB: u64 = 2_048;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    #[default]
    GuardedHost,
    Sandbox,
}

impl ExecutionMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GuardedHost => "guarded_host",
            Self::Sandbox => "sandbox",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerSandboxConfig {
    pub docker_binary: PathBuf,
    pub image: String,
    pub memory_mib: u64,
    pub cpu_millis: u32,
    pub pids_limit: u32,
    pub tmpfs_mib: u64,
}

impl DockerSandboxConfig {
    pub fn new(docker_binary: impl Into<PathBuf>, image: impl Into<String>) -> Self {
        Self {
            docker_binary: docker_binary.into(),
            image: image.into(),
            memory_mib: DEFAULT_SANDBOX_MEMORY_MIB,
            cpu_millis: DEFAULT_SANDBOX_CPU_MILLIS,
            pids_limit: DEFAULT_SANDBOX_PIDS_LIMIT,
            tmpfs_mib: DEFAULT_SANDBOX_TMPFS_MIB,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.docker_binary.is_absolute() {
            return Err("sandbox docker_binary must be an absolute path".to_owned());
        }
        if !self.docker_binary.is_file() {
            return Err("sandbox docker_binary must point to an existing file".to_owned());
        }
        if !immutable_image_ref(&self.image) {
            return Err(
                "sandbox image must be immutable (repo@sha256:<64hex> or sha256:<64hex>)"
                    .to_owned(),
            );
        }
        if !(MIN_MEMORY_MIB..=MAX_MEMORY_MIB).contains(&self.memory_mib) {
            return Err(format!(
                "sandbox memory_mib must be between {MIN_MEMORY_MIB} and {MAX_MEMORY_MIB}"
            ));
        }
        if !(MIN_CPU_MILLIS..=MAX_CPU_MILLIS).contains(&self.cpu_millis) {
            return Err(format!(
                "sandbox cpu_millis must be between {MIN_CPU_MILLIS} and {MAX_CPU_MILLIS}"
            ));
        }
        if !(MIN_PIDS_LIMIT..=MAX_PIDS_LIMIT).contains(&self.pids_limit) {
            return Err(format!(
                "sandbox pids_limit must be between {MIN_PIDS_LIMIT} and {MAX_PIDS_LIMIT}"
            ));
        }
        if !(MIN_TMPFS_MIB..=MAX_TMPFS_MIB).contains(&self.tmpfs_mib)
            || self.tmpfs_mib > self.memory_mib
        {
            return Err(
                "sandbox tmpfs_mib must be bounded and must not exceed memory_mib".to_owned(),
            );
        }
        Ok(())
    }

    pub fn build_run_command(
        &self,
        command: &str,
        workspace: &Path,
        interactive: bool,
        container_name: &str,
    ) -> Result<Command, String> {
        self.validate()?;
        let workspace = sandbox_workspace_path(workspace)?;
        if container_name.is_empty()
            || container_name.len() > 63
            || !container_name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("sandbox container name is invalid".to_owned());
        }

        let mut process = self.base_command();
        process.arg("run");
        process.args(["--rm", "--name", container_name]);
        process.args(["--label", "com.telechir.sandbox=true"]);
        process.args(["--pull", "never"]);
        process.args(["--network", "none"]);
        process.arg("--read-only");
        process.args(["--cap-drop", "ALL"]);
        process.args(["--security-opt", "no-new-privileges=true"]);
        process.args(["--pids-limit", &self.pids_limit.to_string()]);
        process.args(["--memory", &format!("{}m", self.memory_mib)]);
        process.args(["--cpus", &format!("{:.3}", self.cpu_millis as f64 / 1000.0)]);
        process.args(["--ulimit", "nofile=1024:1024"]);
        process.args(["--ulimit", "core=0"]);
        process.args([
            "--tmpfs",
            &format!("/tmp:rw,nosuid,nodev,size={}m", self.tmpfs_mib),
        ]);
        process.args(["--shm-size", "64m"]);
        process.args([
            "--mount",
            &format!(
                "type=bind,source={workspace},target=/workspace,bind-propagation=rprivate,bind-recursive=disabled"
            ),
        ]);
        process.args(["--workdir", "/workspace"]);
        process.args(["--env", "HOME=/tmp"]);
        process.args(["--env", "TMPDIR=/tmp"]);
        for name in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
        ] {
            process.args(["--env", &format!("{name}=")]);
        }
        process.arg("--init");
        if interactive {
            process.arg("-i");
        }
        process.arg(&self.image);
        process.args(["/bin/sh", "-lc", command]);
        Ok(process)
    }

    pub fn force_remove(&self, container_name: &str) -> Result<(), String> {
        self.run_control(["rm", "-f", container_name])
    }

    pub fn stop_then_remove(&self, container_name: &str) -> Result<(), String> {
        match self.run_control(["stop", "--time", "1", container_name]) {
            // Containers are always started with --rm. A successful stop therefore
            // means Docker has completed the container lifecycle and removed it.
            Ok(()) => Ok(()),
            Err(stop_error) => self.force_remove(container_name).map_err(|remove_error| {
                format!(
                    "sandbox container stop failed ({stop_error}); force-remove fallback also failed ({remove_error})"
                )
            }),
        }
    }

    fn base_command(&self) -> Command {
        let mut command = Command::new(&self.docker_binary);
        command.args(["--context", "default"]);
        for key in [
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
        ] {
            command.env_remove(key);
        }
        command
    }

    fn run_control<const N: usize>(&self, args: [&str; N]) -> Result<(), String> {
        self.validate()?;
        let mut command = self.base_command();
        command.args(args);
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|error| format!("sandbox Docker control command could not start: {error}"))?;
        let deadline = Instant::now() + CONTROL_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(status)) => {
                    return Err(format!(
                        "sandbox Docker control command failed with status {status}"
                    ));
                }
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(20));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("sandbox Docker control command timed out".to_owned());
                }
                Err(error) => {
                    return Err(format!(
                        "sandbox Docker control command state could not be read: {error}"
                    ));
                }
            }
        }
    }
}

fn immutable_image_ref(value: &str) -> bool {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return false;
    }
    let digest = if let Some(rest) = value.strip_prefix("sha256:") {
        rest
    } else if let Some((name, digest)) = value.rsplit_once("@sha256:") {
        if name.is_empty() || name.contains('@') {
            return false;
        }
        digest
    } else {
        return false;
    };
    digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sandbox_workspace_path(path: &Path) -> Result<String, String> {
    if !path.is_absolute() || !path.is_dir() {
        return Err("sandbox workspace must be an existing absolute directory".to_owned());
    }
    let value = path
        .to_str()
        .ok_or_else(|| "sandbox workspace path must be valid UTF-8".to_owned())?;
    if value.contains(',') || value.contains('"') || value.chars().any(|ch| ch.is_control()) {
        return Err(
            "sandbox workspace path contains characters unsafe for Docker --mount".to_owned(),
        );
    }
    Ok(value.to_owned())
}

#[cfg(test)]
fn docker_command_args(command: &Command) -> Vec<OsString> {
    command.get_args().map(OsString::from).collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    fn config() -> (tempfile::TempDir, DockerSandboxConfig) {
        let temp = tempdir().unwrap();
        let binary = temp.path().join(if cfg!(windows) {
            "docker.exe"
        } else {
            "docker"
        });
        fs::write(&binary, b"fake docker").unwrap();
        (
            temp,
            DockerSandboxConfig::new(
                binary,
                "telechir/sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
        )
    }

    #[test]
    fn immutable_image_reference_is_required() {
        assert!(immutable_image_ref(
            "telechir/sandbox@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(immutable_image_ref(
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(!immutable_image_ref("telechir/sandbox:latest"));
        assert!(!immutable_image_ref("telechir/sandbox@sha256:abc"));
    }

    #[test]
    fn default_profile_is_bounded() {
        let (_temp, config) = config();
        config.validate().unwrap();
        assert_eq!(config.memory_mib, 512);
        assert_eq!(config.cpu_millis, 1_000);
        assert_eq!(config.pids_limit, 128);
        assert_eq!(config.tmpfs_mib, 128);
    }

    #[test]
    fn docker_command_is_fail_closed_and_does_not_use_host_shell() {
        let (_temp, config) = config();
        let workspace = tempdir().unwrap();
        let command = config
            .build_run_command(
                "printf 'hello' && rm -f generated.txt",
                workspace.path(),
                true,
                "telechir-sbx-0123456789abcdef",
            )
            .unwrap();
        assert_eq!(command.get_program(), config.docker_binary.as_os_str());

        let args = docker_command_args(&command)
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        for expected in [
            "--context",
            "default",
            "--pull",
            "never",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges=true",
            "--pids-limit",
            "--memory",
            "--cpus",
            "--tmpfs",
            "--mount",
            "--workdir",
            "/workspace",
            "--init",
            "-i",
            "/bin/sh",
            "-lc",
            "printf 'hello' && rm -f generated.txt",
        ] {
            assert!(args.iter().any(|arg| arg == expected), "missing {expected}");
        }
        assert!(!args.iter().any(|arg| arg == "--privileged"));
        assert!(!args.iter().any(|arg| arg == "--cap-add"));
        assert!(!args.iter().any(|arg| arg.contains("docker.sock")));
        assert_eq!(
            args.iter()
                .filter(|arg| arg.as_str() == "printf 'hello' && rm -f generated.txt")
                .count(),
            1
        );
    }

    #[test]
    fn unsafe_mount_source_is_rejected() {
        let (_temp, config) = config();
        let workspace = tempdir().unwrap();
        let parent = workspace.path().parent().unwrap();
        let comma = parent.join("telechir,sandbox");
        fs::create_dir_all(&comma).unwrap();
        let error = config
            .build_run_command("echo ok", &comma, false, "telechir-sbx-safe")
            .unwrap_err();
        assert!(error.contains("unsafe for Docker --mount"));
        fs::remove_dir_all(comma).unwrap();
    }
}
