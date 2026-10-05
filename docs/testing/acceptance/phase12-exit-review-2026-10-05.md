# Phase 12 Exit Review — Sandbox Mode

**Data:** 2026-10-05

**Branch:** `phase12/sandbox-mode`

**Issue:** #40

**Resultado:** `PHASE_12_COMPLETE` na branch; integração em `main` pendente até merge.

## Objetivo entregue

A Phase 12 adiciona um modo de execução sandbox local e opt-in para as process tools sem alterar o princípio de autoridade do Telechir.

A API pública passa a distinguir:

```text
execution_mode = guarded_host | sandbox
```

`guarded_host` permanece default e preserva o comportamento anterior.

`sandbox` usa Docker CLI local com configuração explícita e profile fail-closed. Ausência/falha do sandbox **nunca** causa fallback para execução no host.

## Contrato público

Alterados sem adicionar nova tool MCP:

- `run_command`;
- `start_process`;
- outputs de process lifecycle relevantes.

Entradas `run_command` e `start_process`:

```text
execution_mode?: guarded_host|sandbox
default: guarded_host
```

Resultados expõem `execution_mode` onde necessário para tornar o boundary observável.

A superfície permanece com **16 tools**.

## Control plane

`ProcessToolsService`:

- normaliza modo ausente/null para `guarded_host`;
- rejeita valor desconhecido;
- exige `sandbox.docker` para `sandbox`;
- falha antes do dispatch se capability não existe;
- inclui modo nos argumentos antes do `GovernanceService.prepareCommand`.

Consequência de segurança:

> `execution_mode` participa do argument digest existente.

Approval concedido para sandbox não autoriza o mesmo command em guarded host.

## Agent configuration

Sandbox é desabilitado por padrão.

Configuração:

```text
TELECHIR_SANDBOX_ENABLED=true
TELECHIR_SANDBOX_DOCKER_BINARY=<absolute docker/docker.exe>
TELECHIR_SANDBOX_IMAGE=sha256:<64hex> | repo@sha256:<64hex>

TELECHIR_SANDBOX_MEMORY_MIB=512
TELECHIR_SANDBOX_CPU_MILLIS=1000
TELECHIR_SANDBOX_PIDS_LIMIT=128
TELECHIR_SANDBOX_TMPFS_MIB=128
```

Controles:

- opções sandbox com enable=false falham fechado;
- docker binary precisa ser absoluto/existente;
- image precisa ser referência imutável;
- recursos têm bounds locais;
- tmpfs não pode exceder memory;
- Telechir não instala Docker;
- não faz pull;
- não escolhe image automaticamente.

Config válida habilita a capability `sandbox.docker` para composição da lista anunciada.

## Docker sandbox provider

Implementado em `agent/src/sandbox.rs`.

O Docker command é construído via `std::process::Command`; não há host shell interpolation.

Perfil:

- `--context default`;
- `run --rm`;
- nome efêmero `telechir-sbx-<uuid>`;
- label `com.telechir.sandbox=true`;
- `--pull never`;
- `--network none`;
- `--read-only`;
- `--cap-drop ALL`;
- `--security-opt no-new-privileges=true`;
- bounded pids/memory/cpu;
- nofile/core ulimits;
- bounded `/tmp` tmpfs;
- bounded shm;
- somente authorized cwd em `/workspace`;
- `bind-propagation=rprivate`;
- `bind-recursive=disabled`;
- `HOME=/tmp`;
- `TMPDIR=/tmp`;
- proxy env vars vazias;
- `--init`;
- `/bin/sh -lc <command>` dentro do container.

Não inclui:

- privileged;
- cap-add;
- Docker socket;
- arbitrary mounts;
- devices;
- host network;
- host secrets/env;
- automatic image pulls.

## Workspace boundary

Antes do Docker, o cwd passa por `FilesystemPolicy.resolve_existing`:

- canonicalização;
- allowed-root enforcement;
- sensitive path deny.

O source do mount também precisa ser absoluto, diretório existente e não pode conter vírgula/aspas/control chars incompatíveis com o `--mount` adotado.

O workspace é gravável por design.

Isso significa:

> sandbox contém o processo, mas não protege arquivos dentro do workspace autorizado contra side effects de um command aprovado.

## Policy e approvals

`guarded_host` não foi relaxado.

No sandbox:

- SHELL_SAFE continua obrigatório;
- SHELL_FULL, NETWORK, SECRET_USE, ELEVATION, ADMIN, GIT_WRITE e GIT_REMOTE_WRITE continuam fora do teto;
- commands já permitidos pela allowlist executam normalmente;
- command/syntax/executable bloqueado no host torna-se `APPROVAL_REQUIRED`, não ALLOW;
- approval verificado permite a execução **dentro do sandbox**;
- mode swap altera digest e não reutiliza approval.

Testes cobrem:

- sandbox desabilitado;
- host hard deny vs sandbox ask;
- replay após mode swap;
- permission widening.

## Process lifecycle

O modo sandbox funciona com:

- `run_command`;
- `start_process`;
- `read_process_output`;
- `write_process_input`;
- `cancel_process`;
- `list_managed_processes`.

O `ManagedProcess` guarda:

- execution mode;
- nome interno do container somente internamente;
- Docker CLI child/stdin/stdout/stderr.

Outputs públicos não retornam container name.

### Cleanup

Short-command timeout:

- tenta `docker rm -f <name>`;
- encerra process tree do Docker CLI;
- falha de cleanup não vira sucesso.

Force cancel:

- `docker rm -f`.

Graceful cancel:

- `docker stop --time 1`;
- como o container é sempre criado com `--rm`, stop bem-sucedido conclui o lifecycle;
- se stop falha, tenta `rm -f`;
- falha de ambos retorna erro.

Esse fluxo foi corrigido durante o exit review para não executar `rm -f` desnecessário após um stop bem-sucedido, situação em que o `--rm` já removeu o container.

## Revalidação Docker oficial

Documento:

`docs/research/docker/phase12-sandbox-revalidation-2026-10-05.md`

Fontes oficiais revalidadas:

- Docker bind mounts;
- none network driver;
- rootless mode;
- userns-remap;
- docker run reference.

Decisões confirmadas:

- preferir `--mount`;
- source inexistente deve falhar;
- `bind-recursive=disabled`;
- `network none`;
- rootless/userns são hardening do host, não configuração automática do Telechir.

## Docker real — prova 1: isolamento

Host de desenvolvimento:

```text
Docker client: 28.1.1
Docker server: 28.1.1
```

Image local:

```text
node:24-bookworm
sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
```

Nenhum pull foi realizado.

Verificações:

- input do workspace lido;
- output criado no workspace;
- escrita em `/root` falhou com rootfs read-only;
- interface loopback presente;
- `eth0` ausente com network none;
- exit 0;
- nenhum container residual.

Resultado:

```text
RUN_EXIT=0
OUTPUT=sandbox-ok
REMAINING_CONTAINER=
```

A primeira tentativa da prova teve erro de quoting no script PowerShell → Docker → `/bin/sh`; ela foi descartada como evidência de runtime. A segunda versão removeu command substitution e passou.

## Docker real — prova 2: graceful cleanup

Container foi iniciado detached com:

- `--rm`;
- mesmo network/read-only/cap-drop/no-new-privileges profile;
- image local por SHA.

Depois:

```text
docker stop --time 1 <name>
```

Resultado:

```text
STOP_EXIT=0
REMAINING_AFTER_STOP=
```

Isso confirma a semântica usada pela correção de `stop_then_remove`.

## Agent gates

Executados em container Linux com source montado e target em volume Docker.

Como a image Rust não incluía rustfmt/clippy, o certificado **Avast Web/Mail Shield Root** já confiado no Windows foi exportado para `%TEMP%` e montado somente no container efêmero. TLS permaneceu validado; nenhuma proteção foi desabilitada e nenhum certificado entrou no repo.

Gates:

```text
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
```

O primeiro clippy encontrou dois `needless_borrows_for_generic_args`; ambos foram corrigidos sem allow/suppression.

Resultado final:

- fmt: PASS;
- clippy -D warnings: PASS;
- 82 unit tests: PASS;
- connection credential contract: 1 PASS;
- pairing identity contract: 1 PASS;
- protocol contracts: 7 PASS;
- total: **91 testes**, 0 falhas.

Protocol message/envelope baseline continua com 15 message types; nenhum novo envelope foi criado.

## Control-plane gates

```text
npm run format:check
npm run typecheck
npm test
npm run dry-run
npm audit --audit-level=high
```

Resultado:

- format: PASS;
- typecheck: PASS;
- 15 test files: PASS;
- **97 testes**, 0 falhas;
- Wrangler dry-run: PASS;
- bundle: **862,55 KiB / gzip 166,32 KiB**;
- npm audit: **0 vulnerabilidades**.

## D1

Nenhuma migration nova.

Aplicação em base local limpa:

- 0001: PASS — 23 commands;
- 0002: PASS — 12 commands;
- 0003: PASS — 2 commands;
- 0004: PASS — 5 commands.

## Dashboard regression

Nenhuma mudança funcional no Dashboard.

Gates:

- format: PASS;
- typecheck: PASS;
- **2 testes**: PASS;
- production build: PASS;
- JS: 232,41 KiB / gzip 72,35 KiB;
- npm audit: **0 vulnerabilidades**.

## Plugin tooling regression

A superfície MCP continua em 16 tools e a metadata de processo foi evoluída sem adicionar tool nova.

Tooling Phase 11:

- Python compile: PASS;
- **14 testes**: PASS.

## Threat model

Novo delta:

`docs/security/threat-model/phase12-sandbox-mode-2026-10-05.md`

Cobre explicitamente:

- fake sandbox/fallback;
- mode swap;
- permission widening;
- host shell injection;
- socket/privileged/caps;
- host network;
- mutable/missing image;
- resource exhaustion;
- env leakage;
- mount/path escape;
- container escape;
- malicious image;
- orphan containers;
- cleanup failure.

## Riscos residuais aceitos

- Docker não é VM boundary;
- daemon rootful é trust boundary privilegiada;
- container/runtime escape continua possível;
- workspace bind é gravável;
- workspace storage não tem quota;
- image pinned ainda pode ser maliciosa;
- crash abrupto pode deixar orphan;
- rootless/userns/custom seccomp/AppArmor/SELinux não são obrigatórios na Phase 12;
- não existe network-enabled sandbox;
- não existe secret broker;
- não existe startup orphan reconciler.

## Definition of Done

- [x] default continua guarded_host;
- [x] execution_mode público e bounded;
- [x] sandbox não faz fallback para host;
- [x] Docker desabilitado por default;
- [x] image imutável + pull never;
- [x] Docker command sem host shell interpolation;
- [x] network none;
- [x] read-only rootfs;
- [x] all caps dropped;
- [x] no-new-privileges;
- [x] resource limits;
- [x] somente cwd autorizado montado;
- [x] bind-recursive disabled;
- [x] no Docker socket/devices/secrets;
- [x] process lifecycle completo;
- [x] timeout/cancel cleanup;
- [x] mode-bound approval;
- [x] capability gate cloud/device;
- [x] Docker real isolation proof;
- [x] Docker real graceful cleanup proof;
- [x] threat model;
- [x] fmt/clippy/tests Rust;
- [x] control-plane full gates;
- [x] clean D1 migrations;
- [x] Dashboard regression;
- [x] plugin tooling regression;
- [x] nenhum deploy remoto.

## Decisão

A Phase 12 atende a issue #40 e pode ser marcada **`PHASE_12_COMPLETE`** após integração da branch.

A próxima fase de implementação é **Phase 13 — Computer use**.

Phase 13 não deve ser iniciada implicitamente neste PR.
