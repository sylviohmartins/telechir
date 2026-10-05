# Phase 9 Exit Review — Policy, Approvals and Audit

**Data:** 2026-10-05

**Branch:** `phase9/policy-approvals-audit`

**Issue:** #34

**Resultado:** `PHASE_9_COMPLETE` na branch; integração em `main` pendente até o merge.

## Escopo entregue

A Phase 9 materializa policy, approvals e audit no vertical slice já existente sem adicionar Dashboard, Git mutável, shell irrestrito ou outra capability posterior.

### Agent Rust

- `LocalPolicyEngine` com decisões `ALLOW / ASK / DENY`;
- policy local como autoridade final antes do side effect;
- elevação local de risco mínimo;
- hard denies acima de approval/cloud;
- `CRITICAL` fail-closed sem superfície de confirmação local;
- approvals com TTL curto e binding a command/session/permission/risk/argument digest;
- `once` consumido na primeira autorização válida;
- approval remoto não substitui grant emitido pelo agent;
- `approval.request` e `approval.decision` integrados ao realtime;
- audit local bounded com event IDs imutáveis e metadata mínima;
- executável por path explícito permanece hard-denied mesmo após approval.

### Control plane

- `GovernanceService` antes do dispatch de filesystem/process/Git;
- session e command metadata persistidos em D1;
- idempotency key persistida somente por hash;
- `policy_restrictions` aplicada como restrição adicional;
- precedência efetiva `DENY > ASK > ALLOW`;
- remote `ALLOW` nunca vira autoridade local;
- remote `ASK` exige approval cloud e novo attempt da tool;
- lifecycle de approvals em D1;
- validação de ownership e binding user/device/session/command/permission/risk/digest/TTL;
- collision de `approval_id` com binding divergente falha fechado;
- consumo condicional/atômico de approval `once`;
- endpoint interno de decisão de approval;
- approval emitido pelo agent é consumido antes de redispatch;
- redispatch usa o mesmo command ID, argumentos, permissions, session e digest;
- `AuditService` com redaction/minimização antes de persistir.

### Persistência

A migration `0004_policy_approval_audit.sql` adiciona índices operacionais para:

- lookup de restrictions por scope/permission/expiry;
- binding e command lookup de approvals;
- audit events por command/timestamp.

As tabelas conceituais de policy, sessions, approvals, commands e audit já existiam desde a migration inicial; a Phase 9 as torna parte do runtime.

## Invariantes de segurança

### Cloud nunca amplia policy local

Remote policy pode bloquear ou exigir approval adicional, mas um remote approval não é enviado como `approval_id` para o agent.

Se o agent exigir approval local, somente um approval originado pelo próprio agent, correlacionado e validado, pode liberar a operação.

### Risk reclassification

O agent calcula o risco efetivo como o maior entre o risco recebido e o mínimo local da operação. Isso impede que o control plane transforme write/process side effects em `LOW`.

### Approval binding

O digest normalizado cobre:

- operation;
- arguments;
- requested permissions ordenadas.

Um grant não é válido se command, session, permission, risk, digest ou TTL divergirem.

### Audit minimizado

A trilha persiste referências, decisões, digests, revisões e metadata limitada. Bearer tokens, secrets, passwords, cookies, credentials, private keys e API keys são redigidos antes da escrita.

## Abuse cases exercitados

- **AB-024:** approval expirado é rejeitado;
- **AB-025:** approval não pode ser reutilizado para payload/command divergente;
- **AB-029:** reconnect não reproduz side effect automaticamente;
- **AB-031:** cloud approval não amplia o teto local;
- **AB-032:** risco recebido não reduz o mínimo local;
- **AB-034:** bearer/secret metadata é redigida antes do audit persistente;
- hard deny local vence approval verificado;
- consumo `once` não pode ocorrer duas vezes;
- collision de approval ID com binding divergente falha fechado.

O delta está documentado em `docs/security/threat-model/phase9-policy-approvals-audit-2026-10-05.md`.

## Boundaries preservados

A Phase 9 não implementa:

- Dashboard;
- approval inbox/UX;
- policy editor;
- scope `rule`;
- Git mutável;
- shell irrestrito;
- elevation/admin;
- secret broker;
- sandbox;
- computer use/browser;
- deploy de produção;
- recursos pagos.

A superfície MCP pública permanece com as **16 tools da Phase 8**. Phase 9 altera a governança do dispatch, não o catálogo público.

### Workspace policy

O command context atual não possui uma identidade de workspace confiável no control plane. Assim, restrictions operacionais nesta fase são avaliadas para account/device/session. Workspace scope permanece explicitamente não operacional até o protocolo/contexto carregar `workspace_id`; não é declarado como proteção existente.

## Evidências — agent

Runner Linux isolado em Docker, com `CARGO_TARGET_DIR` em volume Docker para evitar build Rust nativo no Windows.

O Avast interceptava o TLS de `rustup`; o certificado raiz público `Avast Web/Mail Shield Root` foi exportado do trust store do Windows e montado somente no container efêmero. A verificação TLS permaneceu habilitada.

```text
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
cargo check --locked --all-features --target x86_64-pc-windows-msvc
cargo check --locked --all-features --target aarch64-apple-darwin
```

Resultados:

- 72 unit tests: **PASS**;
- 2 auth cross-language contract tests: **PASS**;
- 7 protocol contract tests: **PASS**;
- total Rust: **81 testes, 0 falhas**;
- `fmt`: **PASS**;
- `clippy -D warnings`: **PASS**;
- Windows MSVC compile check: **PASS**;
- macOS ARM64 compile check: **PASS**.

Durante os gates, foram encontrados e corrigidos:

1. mismatch na assinatura do helper de audit local;
2. lint `too_many_arguments` removido por simplificação do helper, sem `allow`;
3. path executable `./tool` que poderia passar após approval;
4. dois testes de process lifecycle dependentes de `sleep(50ms)`, substituídos por espera determinística de estado terminal;
5. ordering de dispatch endurecido para persistir a correlação no Durable Object antes de liberar `command.request` ao WebSocket, inclusive após approval.

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

- 14 test files: **PASS**;
- 81 testes: **PASS**;
- D1 `0001 + 0002 + 0003 + 0004`: **PASS** em database local limpa;
- migrations: **23 + 12 + 2 + 5 comandos executados**;
- Wrangler dry-run: **PASS**;
- bundle: **848,47 KiB / gzip 164,97 KiB**;
- `npm audit`: **0 vulnerabilidades**;
- deploy remoto: **não executado**.

## Cenários control-plane exercitados

- remote `ALLOW` não é transformado em local authority;
- remote `DENY` bloqueia antes do dispatch;
- remote `ASK` cria approval e exige retry;
- approval cloud consumido continua não sendo encaminhado ao agent;
- approval expirado é rejeitado;
- consumo duplicado `once` é rejeitado;
- agent approval com ID collision/binding divergente falha fechado;
- approval emitido pelo agent é persistido;
- decisão gera `approval.decision` e redispatch do exato command;
- session, command ID, arguments, permissions e digest permanecem correlacionados;
- sensitive keys e valores `Bearer ...` são redigidos antes do audit persistente.

## Definition of Done

- [x] policy local fail-closed;
- [x] cloud não amplia autoridade local;
- [x] risk minimum elevado localmente;
- [x] hard denies prevalecem sobre approval;
- [x] approval binding por command/session/permission/risk/digest;
- [x] TTL de approval validado;
- [x] `once` consumido uma única vez;
- [x] remote approval separado de local authority;
- [x] audit metadata mínima e redigida;
- [x] migrations D1 coerentes;
- [x] contratos approval validados no agent/control plane;
- [x] threat model atualizado;
- [x] agent fmt/clippy/tests/cross-target;
- [x] control plane format/typecheck/tests/migrations/dry-run/audit;
- [x] nenhum deploy remoto;
- [x] Dashboard/Phase 10 não iniciada.

## Decisão

A Phase 9 atende ao escopo da issue #34 e pode ser marcada como **`PHASE_9_COMPLETE`** após integração desta branch.

O próximo gate é **Phase 10 — Dashboard**. Seu início exige tarefa dedicada e deve reutilizar a mesma pipeline de policy/approval/audit, sem bypass.
