# Phase 7 Exit Review — Shell/Process Lifecycle

**Data:** 2026-10-04  
**Resultado:** `PHASE_7_COMPLETE`

## Escopo validado

A Phase 7 implementa a execução controlada de comandos curtos e o lifecycle de processos gerenciados pelo Telechir sem atravessar para Git, approvals/audit persistente, secret broker, sandbox ou dashboard.

### Agent Rust

Foram materializados:

- `LocalCommandExecutor` para compor os executores de filesystem e process sem habilitar Phase 8;
- `shell.exec` para comandos curtos sob `SHELL_SAFE`;
- `process.start`;
- `process.read`;
- `process.write`;
- `process.cancel`;
- `process.list`;
- handles opacos `process_id`;
- ownership do processo pelo agent, independente do request HTTP/Worker que o iniciou;
- idempotência de `process.start` por key + digest;
- cursor estável para leitura incremental de stdout/stderr;
- buffers circulares bounded;
- stdin bounded;
- limite de processos concorrentes e de registros gerenciados;
- timeout local para comandos curtos;
- cancelamento idempotente e best-effort da árvore de processos;
- cleanup de processos ainda ativos no drop do executor;
- adapter Unix por process group e `killpg`;
- adapter Windows por `taskkill.exe /PID ... /T`, com `/F` no hard kill;
- reutilização da mesma `FilesystemPolicy` da Phase 6 para validar `cwd`.

## Policy local e hard rules

A Phase 7 mantém o agent como autoridade final.

`SHELL_SAFE` é deliberadamente estreito e fail-closed:

- `SHELL_FULL`, `ELEVATION`, `ADMIN`, `NETWORK`, `SECRET_USE`, `GIT_WRITE` e `GIT_REMOTE_WRITE` não ampliam a execução nesta fase;
- não existe elevação implícita;
- shells aninhados, ferramentas de elevation, network e package-management de alto risco são bloqueados;
- chaining, redirection, expansion, globbing e outros metacaracteres de shell são recusados;
- flags que deslocam o workspace, como `-f`, `--manifest-path`, `--project-dir`, `--prefix` e equivalentes, são recusadas;
- argumentos com path absoluto, UNC ou `..` não podem escapar do `cwd` autorizado;
- `cwd` fora do root autorizado ou dentro de path sensível é recusado;
- `env_refs` falham fechado até existir o futuro secret/config broker;
- comandos fora da allowlist `SHELL_SAFE` retornam `APPROVAL_REQUIRED` ou `POLICY_DENIED`, sem fallback para shell irrestrito.

A allowlist atual cobre somente primitives necessárias ao MVP seguro, incluindo builds/tests conhecidos e comandos triviais de teste. Ela não é uma interface `execute anything`.

## Limites de runtime

- command string: 32 KiB;
- input de processo: 64 KiB;
- leitura pública solicitável: até 256 KiB;
- chunk inline efetivo: 64 KiB;
- ring buffer por stream gerenciado: 2 MiB, 4 MiB combinados por processo;
- output de comando curto: 16 KiB por stream;
- timeout de `run_command`: 1–120 s, default 30 s;
- processos concorrentes: 8;
- registros gerenciados: 128;
- cache local de idempotência: 1024 entradas.

## MCP e control plane

A superfície MCP acumulada passa a possuir 14 tools:

- `list_devices`;
- `get_device`;
- seis filesystem tools da Phase 6;
- `run_command`;
- `start_process`;
- `read_process_output`;
- `write_process_input`;
- `cancel_process`;
- `list_managed_processes`.

O dispatch de process exige:

- ownership do device;
- device não revogado;
- presença online;
- capability anunciada;
- scope `telechir:processes:read` ou `telechir:processes:write`;
- `device_id` somente para routing;
- access token nunca encaminhado ao agent;
- deadline bounded;
- idempotency pública de `start_process` preservada até o agent;
- correlação por `command_id` removida após consumo.

Operações comuns usam deadline curto. `run_command` usa o timeout público solicitado mais headroom bounded, e o `DeviceCoordinator` mantém teto de 130 s.

## Casos adversariais exercitados

A suíte cobre:

- short command success;
- timeout estruturado;
- output bounded/truncated;
- start não bloqueante;
- read por cursor após o request original;
- replay idempotente de start;
- conflito de idempotência;
- stdin bounded;
- write após estado terminal;
- cancelamento idempotente;
- list apenas de processos Telechir;
- ceiling de concorrência;
- `cwd` fora do root;
- `cwd` sensível;
- permission widening;
- elevation/shell nesting;
- chaining/redirection/expansion;
- workspace override por argumentos;
- `env_refs` fail-closed;
- descendant process termination;
- reconnect sem replay automático;
- Phase 8 Git ainda indisponível.

No acceptance de árvore de processos em Linux, um descendant morto pode permanecer temporariamente como zombie em runner Docker cujo PID 1 não faz reap de órfãos. O teste considera `Z` como não executando e exige que nenhum descendant permaneça em estado executável.

## Evidência — Agent

Runner Linux em Docker, sem build Cargo nativo no Windows:

- `cargo fmt --all -- --check`: **PASS**;
- `cargo clippy --locked --all-targets --all-features -- -D warnings`: **PASS**;
- `cargo test --locked --all-features`: **PASS**;
- unit tests: **52/52**;
- auth cross-language contracts: **2/2**;
- protocol contracts: **7/7**;
- total Rust: **61 testes, 0 falhas**;
- Windows MSVC compile check (`cargo check --locked --all-targets --all-features --target x86_64-pc-windows-msvc`): **PASS**;
- macOS ARM64 compile check (`cargo check --locked --all-targets --all-features --target aarch64-apple-darwin`): **PASS**.

Nenhuma exclusão de antivírus ou desativação de proteção foi usada.

## Evidência — Control plane

- `npm run format:check`: **PASS**;
- `npm run typecheck`: **PASS**;
- `npm test`: **12 arquivos / 68 testes, 0 falhas**;
- migrations D1 `0001 + 0002 + 0003` em database local limpa: **PASS**;
  - 23 + 12 + 2 comandos executados;
- `npm run dry-run`: **PASS**;
- bundle: **800,95 KiB / gzip 157,38 KiB**;
- `npm audit --audit-level=high`: **0 vulnerabilidades**;
- deploy remoto: **NÃO executado**.

## Boundaries preservados

Não foram implementados nesta fase:

- `git.status` / `git.diff`;
- inventory ou kill arbitrário de processos do SO;
- elevation/admin;
- secret broker;
- approvals/audit persistente;
- sandbox/container execution;
- dashboard;
- deploy de produção.

## Gate de saída

- [x] shell/process lifecycle local implementado;
- [x] hard rules locais fail-closed;
- [x] process ownership pelo agent;
- [x] idempotência;
- [x] output/input/resource limits;
- [x] process-tree cancellation exercitado;
- [x] MCP/process scopes;
- [x] ownership/online/capability gates;
- [x] cross-platform compile checks;
- [x] Phase 8 permanece indisponível;
- [x] nenhum deploy remoto.

> **PHASE_7_COMPLETE**

Próximo gate: **Phase 8 — Basic Git**, somente em execução dedicada de Build, Test & Iterate.
