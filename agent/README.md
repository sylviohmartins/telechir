# Telechir Agent

Core local do Telechir implementado em Rust.

## Fases implementadas

### Phase 1 — Local Agent Core

- Device Wire Protocol `0.1`;
- validação de envelope/payload;
- error/permission/risk/command contracts;
- configuração local;
- command lifecycle;
- ports para policy, transport, clock e execution;
- contract-drift tests contra `../specs/`.

### Phase 3 — Device Identity

- `device_key_id` e `device_installation_id` persistentes;
- keypair Ed25519;
- private key atrás de `DeviceIdentityStore`;
- adapter padrão `NativeKeyringIdentityStore`;
- public key raw em Base64 URL-safe sem padding;
- fingerprint SHA-256 da public key;
- payload público `PairingRegistration`;
- assinatura do contrato `../specs/auth/pairing-proof-v1.md`;
- fixture Ed25519 compartilhado com o control plane.

### Phase 4 — Device Realtime Channel

- assinatura Ed25519 do pedido de connection credential curta;
- cliente WebSocket outbound com TLS/rustls;
- `agent.hello -> agent.hello_ack` no protocolo `0.1`;
- validação de `connection_id`, sequence e `message_id`;
- heartbeat;
- frame limit de 256 KiB;
- reconnect backoff exponencial com jitter e teto de 30 s;
- reconnect não reproduz comandos automaticamente;
- contrato compartilhado em `../specs/auth/connection-credential-v1.md`.

### Phase 6 — Filesystem Tools

- `fs.list`, `fs.stat`, `fs.read`, `fs.write`, `fs.patch` e `fs.search`;
- roots explícitos e deny-by-default;
- hard deny local de paths sensíveis, inclusive quando o próprio root configurado é sensível;
- traversal defense por canonicalização/componentes de path;
- symlink e Windows junction/reparse defense;
- leitura chunked para preservar o frame wire de 256 KiB;
- write atômico e bounded;
- patch unified diff com `expected_hash`;
- busca text/regex/glob bounded;
- idempotency para write/patch.

### Phase 7 — Shell/Process Lifecycle

- `shell.exec`, `process.start`, `process.read`, `process.write`, `process.cancel` e `process.list`;
- `SHELL_SAFE` fail-closed, sem fallback para shell irrestrito;
- bloqueio de elevation, nested shells, network/package-management perigoso, chaining/redirection/expansion/globbing e workspace escape;
- `cwd` validado pela mesma `FilesystemPolicy` da Phase 6;
- `env_refs` fail-closed até existir secret/config broker;
- ownership local de processos com handles opacos;
- stdout/stderr em ring buffers bounded com cursor incremental;
- stdin bounded;
- timeout local para comandos curtos;
- idempotência para operações com side effects;
- cancelamento best-effort da árvore de processos;
- limites de concorrência e registros gerenciados.

### Phase 8 — Basic Git

- `git.status` e `git.diff` read-only;
- `LocalCommandExecutor` compondo filesystem, process e Git sem habilitar operações Git mutáveis;
- exatamente `FS_READ` + risco `LOW`;
- worktree, gitdir e common-dir obrigatoriamente dentro de roots autorizados;
- discovery de `.git`/gitdir antes do primeiro subprocesso Git;
- symlink/reparse/gitdir escape fail-closed;
- audit de config local antes de Git executar;
- includes, hooks, fsmonitor, external diff/textconv, filters e credential helpers perigosos recusados;
- environment Git minimizado, prompts/lazy fetch/protocol desabilitados;
- status e diff bounded, com timeout local e truncation explícita;
- staged/unstaged diff e literal path filter;
- nenhuma operação `add/commit/push/fetch/pull/checkout/reset/clean/stash/tag/branch/remote/submodule`.

### Phase 9 — Policy, Approvals and Audit

- `LocalPolicyEngine` com `ALLOW / ASK / DENY` e autoridade final local;
- risk floor local para side effects, sem aceitar redução remota;
- hard denies para permissões fora do teto atual;
- `CRITICAL` fail-closed sem confirmação local dedicada;
- approval binding por command/session/permission/risk/argument digest/TTL;
- `once` consumido na primeira autorização válida;
- `approval.request` / `approval.decision` no realtime channel;
- remote approval nunca substitui approval emitido pelo agent;
- audit local bounded com event IDs imutáveis, policy revision e digests;
- executáveis por path explícito permanecem hard-denied mesmo com approval.

A private key não faz parte de nenhum DTO serializável do agent.

## Native keyring

O adapter padrão usa o crate `keyring` e seleciona o backend nativo suportado pelo target:

- Windows Credential Manager;
- macOS Keychain;
- Secret Service em Unix/Linux suportado.

O `MemoryIdentityStore` existe somente para testes e adapters controlados.

## Limites atuais

O agent já possui realtime outbound, filesystem typed tools, shell/process lifecycle, Basic Git read-only e policy/approvals/audit local com enforcement final no device. Não existe deploy de produção.

Ficam para fases posteriores:

- Dashboard/UX de approvals sem bypass da pipeline local;
- policy editável/persistente do usuário;
- Git mutável permanece fora do MVP atual.

## Build e validação

No diretório `agent/`:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo run
```

As Phases 3–9 também exigem compile checks para:

```text
x86_64-pc-windows-msvc
aarch64-apple-darwin
```

## Windows e antivírus

Se o antivírus do host interceptar repetidamente executáveis temporários `build-script-build.exe` do Cargo, execute os gates em container Linux com `CARGO_TARGET_DIR` em volume Docker.

Não é necessário desativar proteção nem criar exclusão ampla para o repositório.

Evidências:

- `../docs/testing/acceptance/phase1-exit-review-2026-10-02.md`;
- `../docs/testing/acceptance/phase3-exit-review-2026-10-02.md`;
- `../docs/testing/acceptance/phase4-exit-review-2026-10-02.md`;
- `../docs/testing/acceptance/phase6-exit-review-2026-10-03.md`;
- `../docs/testing/acceptance/phase7-exit-review-2026-10-04.md`;
- `../docs/testing/acceptance/phase8-exit-review-2026-10-04.md`;
- `../docs/testing/acceptance/phase9-exit-review-2026-10-05.md`.
