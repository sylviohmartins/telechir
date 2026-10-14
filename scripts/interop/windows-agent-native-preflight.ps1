# Phase 16 / Windows native Agent core preflight.
# Validacao exclusiva de build, contratos e bootstrap local.
# Nao registra dispositivo, conecta a cloud, executa input ou desliga o antivirus.
[CmdletBinding()]
param(
    [switch]$Offline,
    [switch]$AllowLocalBuild
)

$ErrorActionPreference = "Stop"

# Cargo compiles and EXECUTES many third-party build-script-build.exe binaries.
# Avast CyberCapture can analyze EACH newly generated binary, producing multiple
# windows on a developer workstation. Default to no local execution so an
# automated agent or accidental script run cannot retrigger the warning storm.
# The Windows CI runner explicitly passes -AllowLocalBuild. To intentionally
# compile on a workstation, the operator must opt in to the same flag.
if (-not $AllowLocalBuild) {
    Write-Output "BLOCKED: AGENT_WINDOWS_LOCAL_CARGO_BUILD_REQUIRES_OPT_IN"
    Write-Output "Default is CI-only: run the 'Phase 16 Windows Agent native preflight' GitHub Actions workflow."
    Write-Output "Compiling locally executes third-party Cargo build scripts that can trigger repeated Avast CyberCapture popups."
    Write-Output "Use -AllowLocalBuild only for an explicitly approved local compilation; do not weaken antivirus protections."
    throw "Native Cargo compilation blocked by default (no -AllowLocalBuild)."
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "Windows host required for native MSVC validation"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$agentDir = Join-Path $repoRoot "agent"
$defaultCargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
$cargo = if (Test-Path -LiteralPath $defaultCargo) {
    $defaultCargo
} else {
    (Get-Command "cargo.exe" -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $cargo)) {
    throw "Native Rust toolchain missing"
}
if (-not $env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = Join-Path ([IO.Path]::GetTempPath()) "telechir-agent-native-validation"
}
$env:CARGO_TERM_COLOR = "never"
$env:CARGO_BUILD_JOBS = "2"
$offlineOption = if ($Offline) { @("--offline") } else { @() }

function Invoke-CargoChecked {
    param([string[]]$CommandArgs, [string]$Gate)
    & $cargo @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Cargo gate failed: $Gate (exit $LASTEXITCODE)"
    }
    Write-Output "PASS: $Gate"
}

function Invoke-AgentBootstrap {
    param([string]$Executable, [switch]$InvalidInput, [string[]]$Arguments = @())
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    # Only static, space-free CLI arguments are used in this safe preflight.
    $start.Arguments = $Arguments -join ' '
    $start.WorkingDirectory = $agentDir
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # Nunca herdar uma configuracao capaz de ativar screen/input/browser ou
    # apontar para endpoint remoto do ambiente pessoal.
    foreach ($key in @($start.EnvironmentVariables.Keys)) {
        if ([string]$key -like "TELECHIR_*") {
            $start.EnvironmentVariables.Remove([string]$key)
        }
    }
    if ($InvalidInput) {
        $start.EnvironmentVariables["TELECHIR_COMPUTER_INPUT_ENABLED"] = "not-a-boolean"
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "Could not start native Agent" }
        if (-not $process.WaitForExit(15000)) {
            $process.Kill()
            throw "Agent bootstrap exceeded 15 s: not an operational runtime test"
        }
        return @{
            ExitCode = $process.ExitCode
            Stdout   = $process.StandardOutput.ReadToEnd()
            Stderr   = $process.StandardError.ReadToEnd()
        }
    } finally {
        $process.Dispose()
    }
}

Push-Location $agentDir
try {
    Invoke-CargoChecked -CommandArgs @("fmt", "--all", "--", "--check") -Gate "AGENT_WINDOWS_RUSTFMT"
    Invoke-CargoChecked -CommandArgs (@("test", "--locked", "--all-features") + $offlineOption) -Gate "AGENT_WINDOWS_NATIVE_TESTS"
    Invoke-CargoChecked -CommandArgs (@("clippy", "--locked", "--all-targets", "--all-features") + $offlineOption + @("--", "-D", "warnings")) -Gate "AGENT_WINDOWS_CLIPPY"
    Invoke-CargoChecked -CommandArgs (@("build", "--locked", "--all-features", "--bin", "telechir-agent") + $offlineOption) -Gate "AGENT_WINDOWS_BINARY_BUILD"
    $exe = Join-Path $env:CARGO_TARGET_DIR "debug\telechir-agent.exe"
    if (-not (Test-Path -LiteralPath $exe)) { throw "Built Windows Agent binary not found" }

    $bootstrap = Invoke-AgentBootstrap -Executable $exe
    if ($bootstrap.ExitCode -ne 0 -or
        $bootstrap.Stdout -notmatch "telechir-agent .* core ready" -or
        $bootstrap.Stdout -notmatch "sandbox=disabled" -or
        $bootstrap.Stdout -notmatch "screen=disabled" -or
        $bootstrap.Stdout -notmatch "input=disabled" -or
        $bootstrap.Stdout -notmatch "browser=disabled") {
        throw "Native Agent baseline bootstrap did not match safe defaults"
    }
    Write-Output "PASS: AGENT_WINDOWS_BOOTSTRAP_SAFE_DEFAULTS"

    $rejected = Invoke-AgentBootstrap -Executable $exe -InvalidInput
    if ($rejected.ExitCode -ne 2 -or
        $rejected.Stderr -notmatch "TELECHIR_COMPUTER_INPUT_ENABLED must be true or false") {
        throw "Native Agent did not fail closed for invalid computer-input enablement"
    }
    Write-Output "PASS: AGENT_WINDOWS_INPUT_CONFIG_FAIL_CLOSED"
    # G1-B validates opt-in CLI parsing WITHOUT contacting a keyring,
    # connecting to any URL, or mutating the host machine.
    $help = Invoke-AgentBootstrap -Executable $exe -Arguments @("--help")
    if ($help.ExitCode -ne 0 -or
        $help.Stdout -notmatch "serve <https-origin>" -or
        $help.Stdout -notmatch "foreground, deny-all") {
        throw "Agent opt-in help does not document safe remote defaults"
    }
    Write-Output "PASS: AGENT_WINDOWS_FOREGROUND_HELP"

    $noOrigin = Invoke-AgentBootstrap -Executable $exe -Arguments @("serve")
    if ($noOrigin.ExitCode -ne 2 -or
        $noOrigin.Stderr -notmatch "invalid Agent command") {
        throw "Agent allowed serve without an explicit trusted origin"
    }
    $plainHttp = Invoke-AgentBootstrap -Executable $exe -Arguments @("serve", "http://example.org")
    if ($plainHttp.ExitCode -ne 2 -or
        $plainHttp.Stderr -notmatch "provisioning") {
        throw "Agent accepted an external plaintext provisioning origin"
    }
    Write-Output "PASS: AGENT_WINDOWS_FOREGROUND_ARGS_FAIL_CLOSED"
    # G1-C does not trigger credential retrieval or remote traffic when
    # the explicitly selected workspace root or TLS origin is invalid.
    $readonlyHelp = Invoke-AgentBootstrap -Executable $exe -Arguments @("--help")
    if ($readonlyHelp.ExitCode -ne 0 -or
        $readonlyHelp.Stdout -notmatch "serve-readonly <https-origin> <absolute-root>") {
        throw "Read-only Agent opt-in command is not documented"
    }
    $missingRoot = Invoke-AgentBootstrap -Executable $exe -Arguments @("serve-readonly", "https://example.invalid")
    if ($missingRoot.ExitCode -ne 2 -or
        $missingRoot.Stderr -notmatch "invalid Agent command") {
        throw "Read-only Agent accepted missing workspace root"
    }
    $relativeRoot = Invoke-AgentBootstrap -Executable $exe -Arguments @("serve-readonly", "https://example.invalid", "relative")
    if ($relativeRoot.ExitCode -ne 2 -or
        $relativeRoot.Stderr -notmatch "invalid read-only workspace root") {
        throw "Read-only Agent accepted implicit relative workspace root"
    }
    $unsafeOrigin = Invoke-AgentBootstrap -Executable $exe -Arguments @("serve-readonly", "http://example.org", "C:\\Windows")
    if ($unsafeOrigin.ExitCode -ne 2 -or
        $unsafeOrigin.Stderr -notmatch "provisioning") {
        throw "Read-only Agent accepted plaintext external control plane"
    }
    Write-Output "PASS: AGENT_WINDOWS_READONLY_ARGS_FAIL_CLOSED"
    Write-Output "RESULT: TELECHIR_AGENT_WINDOWS_NATIVE_PREFLIGHT_PASS"
    Write-Output "NOT_TESTED: device pairing/credential on a physical host, a real remote session, command execution or human approval"

} finally {
    Pop-Location
}
