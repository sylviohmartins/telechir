# Phase 8 Exit Review — Basic Git

**Data:** 2026-10-04  
**Branch:** `phase8/basic-git`  
**Issue:** #32  
**Resultado:** `PHASE_8_COMPLETE` na branch; integração em `main` pendente até o merge.

## Escopo entregue

A Phase 8 adiciona somente leitura Git ao vertical slice Telechir, sem antecipar mutações de repositório ou a Phase 9.

### Agent Rust

- `git.status`;
- `git.diff`;
- `LocalCommandExecutor` roteando Git separadamente de filesystem/process;
- permission contract estrito: exatamente `FS_READ`;
- risco obrigatório `LOW`;
- repository/worktree contido em root local autorizado;
- discovery de `.git`/gitdir antes do primeiro subprocesso Git;
- `.git` symlink/reparse recusado;
- gitdir/common-dir externos ao root recusados;
- linked worktree suportado somente quando metadata também permanece autorizada;
- path filter relativo e literal, sem `..`/absolute escape;
- status porcelain bounded;
- diff staged/unstaged bounded;
- truncation explícita para diff grande;
- timeout local de subprocesso;
- nenhuma operação Git mutável exposta.

## Hardening do subprocesso Git

O executável Git é resolvido por path absoluto fora dos roots de workspace autorizados, evitando que um binário plantado dentro do workspace substitua o Git do host.

O subprocesso usa environment limpo e configurações defensivas:

- `GIT_OPTIONAL_LOCKS=0`;
- `GIT_TERMINAL_PROMPT=0`;
- `GIT_CONFIG_NOSYSTEM=1`;
- `GIT_CONFIG_GLOBAL` apontando para null device;
- `GIT_ATTR_NOSYSTEM=1`;
- `GIT_NO_LAZY_FETCH=1`;
- `--no-pager`;
- `--no-optional-locks`;
- `--literal-pathspecs`;
- `--no-replace-objects`;
- `core.fsmonitor=false`;
- `core.untrackedCache=false`;
- `status.submoduleSummary=false`;
- `protocol.allow=never`;
- `credential.helper=`.

Antes de Git executar, configs locais relevantes são auditadas e falham fechado quando contêm mecanismos que podem executar processos, ler configuração externa ou ampliar autoridade, incluindo:

- `include` / `includeIf`;
- `core.fsmonitor`;
- `core.hooksPath`;
- `core.attributesFile`;
- `core.excludesFile`;
- `core.sshCommand`;
- `diff.external`, diff command e textconv;
- `filter.clean`, `filter.smudge` e `filter.process`;
- credential helper.

## Control plane / MCP

A superfície MCP passa de 14 para **16 tools** e adiciona somente:

- `get_git_status`;
- `get_git_diff`.

Regras:

- scope OAuth: `telechir:git:read`;
- ownership do device obrigatório;
- device revogado/offline falha fechado;
- capability correspondente obrigatória;
- `device_id` usado somente para routing;
- argumentos enviados ao agent não carregam access token;
- requested permission: `FS_READ`;
- risk: `LOW`;
- sem idempotency key, pois as duas operações são read-only;
- deadline bounded;
- correlação por `command_id` removida após consumo.

## Operações deliberadamente ausentes

A Phase 8 não habilita:

- `git add`;
- commit;
- push/fetch/pull;
- checkout/switch;
- merge/rebase;
- reset/restore/clean;
- stash;
- tag;
- branch mutation;
- remote mutation;
- submodule update;
- signing;
- hooks;
- arbitrary Git passthrough.

Os permission domains `GIT_WRITE` e `GIT_REMOTE_WRITE` não são aceitos pelas operações de leitura da Phase 8.

## Evidências — agent

Runner Linux isolado em Docker, sem build Rust nativo no Windows.

```text
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
cargo check --locked --all-targets --all-features --target x86_64-pc-windows-msvc
cargo check --locked --all-targets --all-features --target aarch64-apple-darwin
```

Resultados:

- 67 unit tests: **PASS**;
- 2 auth cross-language contract tests: **PASS**;
- 7 protocol contract tests: **PASS**;
- total Rust: **76 testes, 0 falhas**;
- `fmt`: **PASS**;
- `clippy -D warnings`: **PASS**;
- Windows MSVC compile check: **PASS**;
- macOS ARM64 compile check: **PASS**.

## Cenários Rust exercitados

- non-repository;
- repository autorizado;
- repository fora do root;
- nested working tree;
- symlink escape;
- gitdir externo recusado;
- gitdir externo recusado antes de qualquer subprocesso Git;
- linked worktree autorizado quando metadata permanece dentro do root;
- status dirty/untracked;
- ahead/behind contra upstream local;
- staged e unstaged diff;
- literal path filter;
- traversal por path filter;
- large diff truncation;
- timeout;
- widening para `GIT_WRITE` negado;
- config audit de includes/hooks/fsmonitor/diff/filter/credentials;
- clean filter malicioso negado antes de Git executar;
- index preservado em status read-only.

## Evidências — control plane

```text
npm run format:check
npm run typecheck
npm test
npm run d1:migrate:local
npm run dry-run
npm audit --audit-level=high
```

Resultados:

- 13 test files: **PASS**;
- 74 testes: **PASS**;
- D1 `0001 + 0002 + 0003`: **PASS** em database local limpa;
- migrations: **23 + 12 + 2 comandos executados**;
- Wrangler dry-run: **PASS**;
- bundle: **809,85 KiB / gzip 158,01 KiB**;
- `npm audit`: **0 vulnerabilidades**;
- deploy remoto: **não executado**.

## Cenários control-plane exercitados

- dispatch de `git.status` como `FS_READ / LOW`;
- dispatch de `git.diff` preservando staged/path/max_bytes;
- access token não é encaminhado no command envelope;
- device offline falha antes do dispatch;
- capability ausente falha antes do dispatch;
- cross-user ownership falha;
- argumentos acima do transport limit falham;
- `telechir:git:read` exigido no MCP antes do routing;
- catálogo MCP contém exatamente as 16 tools da Phase 8;
- rota/produto de fase posterior continua indisponível.

## Definition of Done

- [x] `git.status` implementado;
- [x] `git.diff` implementado;
- [x] read-only permission/risk contract;
- [x] repository/worktree containment;
- [x] symlink/reparse/gitdir boundary;
- [x] metadata/config audit antes do subprocesso Git;
- [x] external execution/config surfaces fail-closed;
- [x] timeout/output bounds;
- [x] staged/unstaged/path-filter coverage;
- [x] MCP + OAuth scope `telechir:git:read`;
- [x] ownership/online/capability gates;
- [x] agent fmt/clippy/tests/cross-target;
- [x] control plane format/typecheck/tests/migrations/dry-run/audit;
- [x] nenhuma operação Git mutável;
- [x] nenhum deploy remoto;
- [x] Phase 9 não antecipada.

## Decisão

A Phase 8 atende ao escopo da issue #32 e pode ser marcada como **`PHASE_8_COMPLETE`** após integração desta branch.

O próximo trabalho é **Phase 9 — Policy, Approvals and Audit**, em tarefa dedicada.
