# Phase 10 Exit Review — Dashboard

**Data:** 2026-10-05

**Branch:** `phase10/dashboard-mvp`

**Issue:** #36

**Resultado:** `PHASE_10_COMPLETE` na branch; integração em `main` pendente até o merge.

## Escopo entregue

A Phase 10 adiciona o Dashboard MVP como cliente do control plane existente. Nenhum caminho direto browser → agent foi criado e a superfície MCP pública permanece com 16 tools.

### Dashboard React/TypeScript

Criado `apps/dashboard/` com:

- Vite + React + TypeScript strict;
- visão de devices com online/offline, OS, arch, agent version e last seen;
- resumo de usage/health com tool calls, concluídos, falhas, latência média e bytes de artifacts;
- command/process timeline;
- approval inbox;
- audit timeline;
- revogação de device com confirmação explícita;
- estados loading/empty/error;
- layout responsivo e controles navegáveis por teclado;
- token OAuth mascarado e armazenado somente em `sessionStorage` no MVP.

A UI não implementa web terminal, screen viewer, policy editor, browser/computer-use ou shell irrestrito.

### Dashboard API no control plane

Criado `/dashboard/api/*`:

- `GET /dashboard/api/overview`;
- `POST /dashboard/api/approvals/:approvalId/decision`;
- `POST /dashboard/api/devices/:deviceId/revoke`.

As rotas reutilizam o resource server OAuth existente e exigem scopes próprios:

- `telechir:dashboard:read`;
- `telechir:approvals:decide`;
- `telechir:devices:revoke`.

Bearer válido sem o scope necessário recebe `403`.

### Ownership e minimização

O overview filtra por `user_id` autenticado:

- devices;
- sessions;
- commands;
- approvals;
- audit events;
- usage/artifact bytes.

Approval e revoke também validam owner antes de qualquer ação. IDs pertencentes a outro usuário retornam `404`.

A resposta não expõe:

- access/bearer token;
- secret values;
- argumentos completos;
- idempotency key;
- argument digest de approval;
- `user_id` redundante do approval.

O `human_summary` é sintetizado somente a partir de tool/operation/permission.

### Approval sem bypass

O browser não fornece command binding, permission, risk ou argument digest como autoridade.

Approval decision:

1. autentica o bearer;
2. exige `telechir:approvals:decide`;
3. resolve o usuário autenticado;
4. valida `approval_id + user_id`;
5. rejeita TTL expirado, decisão existente ou consumo existente;
6. chama o mesmo endpoint interno do `DeviceCoordinator` da Phase 9.

A validação completa, consumo e redispatch continuam governados pela Phase 9. Remote approval não se transforma em autoridade local do agent.

### Revogação

O Dashboard exige:

- confirmação explícita no browser;
- `confirm: true` no request;
- scope `telechir:devices:revoke`;
- ownership `device_id + user_id`.

A mutação reutiliza `revokeDeviceAndCloseRealtime`, que mantém a operação de domínio existente para revogar device/key/pairing e encerrar a conexão realtime.

## Hardening realizado durante a implementação

A revisão antes dos gates encontrou e corrigiu quatro pontos:

1. **bearer sem scope administrativo:** autenticação válida isoladamente permitiria acesso excessivo; scopes dedicados foram adicionados e testados;
2. **DTO de approval excessivo:** o primeiro SELECT incluía `user_id` e `argument_digest`; a resposta pública foi minimizada;
3. **double-submit:** approval já decidido/consumido agora falha no boundary HTTP antes de novo dispatch;
4. **cross-user revoke:** ownership é validado antes de qualquer tentativa de orquestração realtime.

O delta completo está em `docs/security/threat-model/phase10-dashboard-2026-10-05.md`.

## Evidências — control plane

Runner Node isolado em Docker, reutilizando volume de `node_modules` e sem gerar dependências no working tree do Windows.

```text
npm run format:check
npm run typecheck
npm test
wrangler d1 migrations apply DB --local --persist-to <fresh-dir>
npm run dry-run
npm audit --audit-level=high
```

Resultados:

- format: **PASS**;
- TypeScript strict: **PASS**;
- 15 test files: **PASS**;
- **89 testes**, 0 falhas;
- Dashboard HTTP específico: **7 testes**, 0 falhas;
- migrations D1 em base limpa: **0001 + 0002 + 0003 + 0004 PASS**;
- comandos de migration: **23 + 12 + 2 + 5**;
- nova migration da Phase 10: **não necessária**;
- Wrangler dry-run: **PASS**;
- bundle Worker: **859,39 KiB / gzip 165,71 KiB**;
- `npm audit --audit-level=high`: **0 vulnerabilidades**;
- deploy remoto: **não executado**.

## Evidências — Dashboard

```text
npm run format:check
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

Resultados:

- format: **PASS**;
- TypeScript strict: **PASS**;
- 1 test file / **2 testes de componente**: **PASS**;
- build Vite de produção: **PASS**;
- JS principal: **232,41 KiB / gzip 72,35 KiB**;
- CSS: **4,43 KiB / gzip 1,65 KiB**;
- `npm audit`: **0 vulnerabilidades**.

Durante os gates, Vitest foi atualizado para **4.1.11** porque a série 3.x instalada inicialmente carregava advisory moderado em `@vitest/mocker`. A atualização removeu o advisory e o config passou a usar `defineConfig` de `vitest/config`.

## Evidências — Agent Rust

Nenhum arquivo Rust ou contrato de protocolo foi modificado na Phase 10.

Foi executada regressão completa em Docker Linux com repo read-only e `CARGO_TARGET_DIR` em volume isolado:

```text
cargo test --locked --all-features
```

Resultados:

- 72 unit tests: **PASS**;
- 2 identity/cross-language contract tests: **PASS**;
- 7 protocol contract tests: **PASS**;
- total: **81 testes Rust, 0 falhas**.

Uma primeira tentativa do runner embutiu `CARGO_MANIFEST_DIR` incorreto ao montar somente `agent/`, causando `No such file or directory` para fixture compartilhada. O código não foi alterado: o gate final foi repetido com o repositório inteiro read-only e target volume novo, confirmando todos os contratos verdes.

## Abuse cases exercitados

- usuário A não recebe devices/sessions/commands de B;
- usuário A não decide approval de B;
- usuário A não revoga device de B;
- token válido sem scope do Dashboard recebe 403;
- approval expirado recebe 409;
- approval já decidido recebe 409 antes de novo dispatch;
- revoke sem confirmação é rejeitado e não altera D1;
- token não reaparece na UI após autenticação;
- approval enviado pela UI usa `once`;
- resposta do overview não inclui argumentos/digest de approval.

## Boundaries preservados

A Phase 10 não implementa:

- web terminal;
- screen viewer;
- policy editor;
- permanent approval rules;
- Git mutável;
- shell irrestrito;
- elevation/admin;
- secret broker;
- sandbox;
- browser/computer-use;
- deploy de produção;
- recursos pagos.

O Dashboard não acessa o agent diretamente.

## Limite de autenticação do MVP

O projeto continua sendo resource server e não implementa authorization server próprio.

Sem deploy público nesta fase, o Dashboard recebe manualmente um access token já emitido. O token permanece somente em `sessionStorage`. Fluxo browser OAuth, PKCE/client registration público, CSP/headers finais e UX de distribuição são gates posteriores, com foco imediato na Phase 11.

## Definition of Done

- [x] `apps/dashboard/` React/TypeScript;
- [x] devices e online/offline;
- [x] version/OS/arch/last seen;
- [x] sessions e command/process timeline;
- [x] approvals;
- [x] errors;
- [x] latency;
- [x] bytes;
- [x] revoke;
- [x] audit timeline;
- [x] usage/health;
- [x] bearer + scopes dedicados;
- [x] ownership em todas as rotas;
- [x] approval/revoke sem bypass da Phase 9;
- [x] minimização de dados;
- [x] responsive/basic accessibility;
- [x] control-plane regressão completa;
- [x] Dashboard format/typecheck/tests/build/audit;
- [x] D1 migrations em base limpa;
- [x] agent protocol regression;
- [x] threat model atualizado;
- [x] nenhum deploy remoto;
- [x] web terminal/screen viewer permanecem fora.

## Decisão

A Phase 10 atende ao escopo da issue #36 e pode ser marcada como **`PHASE_10_COMPLETE`** após integração desta branch.

O próximo gate é **Phase 11 — ChatGPT public-plugin readiness**. Seu início deve tratar distribuição/autorização e requisitos atuais da plataforma sem enfraquecer OAuth, ownership ou autoridade local do agent.
