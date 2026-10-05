# Telechir Control Plane

Control plane do Telechir em TypeScript para Cloudflare Workers.

## Fases implementadas

### Phase 2 — Hosted Control-Plane Skeleton

- Worker HTTP;
- `/health`, `/ready`, `/version`;
- `DeviceCoordinator` Durable Object skeleton;
- D1;
- boundaries para R2, Analytics Engine e Queue;
- testes via `@cloudflare/vitest-plugin`.

### Phase 3 — Pairing and Device Identity

- state machine de pairing;
- TTL de 10 minutos;
- user code one-time armazenado somente por HMAC keyed;
- limite de tentativas para user code e prova criptográfica;
- challenge derivado de segredo do servidor e persistido apenas por digest;
- verificação Ed25519 pelo Workers Web Crypto;
- ativação transacional que cria `devices/device_keys` somente após prova válida;
- replay de ativação idempotente;
- revogação durável;
- migration `0002_pairing_identity.sql`;
- contrato device-side em `../../specs/auth/pairing-api-v1.md`;
- pairing proof em `../../specs/auth/pairing-proof-v1.md`.

### Phase 4 — Device Realtime Channel

- connection credential curta com TTL de 60 s;
- proof Ed25519 vinculada a device/key/nonce/timestamp/audience;
- WebSocket upgrade autenticado;
- `DeviceCoordinator` por device com Hibernation WebSocket API;
- uma conexão lógica ativa por device;
- JTI single-use e replay defense;
- `agent.hello -> agent.hello_ack`;
- heartbeat/presence e capabilities efêmeras;
- command correlation mínima sem executar tools;
- revogação fecha socket ativo e bloqueia credential futura;
- frame limit de 256 KiB;
- contrato em `../../specs/auth/connection-credential-v1.md`.

### Phase 5 — Remote MCP and Client Access

- endpoint `/mcp` por Streamable HTTP;
- discovery e catálogo de tools derivados de `../../specs/tools/`;
- Protected Resource Metadata e validação de access token;
- ownership de devices aplicado no D1;
- migration `0003_oauth_identity_uniqueness.sql`.

### Phase 6 — Filesystem Tools

- superfície MCP acumulada de 8 tools: `list_devices`, `get_device` e seis filesystem tools;
- scopes `telechir:files:read` / `telechir:files:write` por tool;
- ownership, revogação, presence e capability antes do dispatch;
- `device_id` usado apenas para routing, não incluído em `arguments` enviados ao agent;
- `command.request` via `DeviceCoordinator` com deadline, permission/risk e idempotency;
- correlação bounded por `command_id` e remoção após consumo;
- nenhuma credencial OAuth é encaminhada ao agent.

### Phase 7 — Shell/Process Lifecycle

- superfície MCP acumulada de 14 tools;
- `run_command`, `start_process`, `read_process_output`, `write_process_input`, `cancel_process` e `list_managed_processes`;
- scopes `telechir:processes:read` / `telechir:processes:write`;
- ownership, revogação, presence e capability antes do dispatch;
- `device_id` permanece apenas como routing metadata;
- `start_process` preserva a `idempotency_key` pública até o agent;
- deadlines diferenciados: operações lifecycle curtas e `run_command` com timeout público bounded + headroom;
- correlação por `command_id` removida após consumo;
- nenhuma credencial OAuth é encaminhada ao agent.

### Phase 8 — Basic Git

- superfície MCP acumulada de 16 tools;
- `get_git_status` e `get_git_diff`;
- scope `telechir:git:read`;
- ownership, revogação, presence e capability antes do dispatch;
- requested permission `FS_READ` e risco `LOW`;
- `device_id` usado apenas para routing;
- access token nunca encaminhado ao agent;
- deadline e argumentos bounded;
- correlação por `command_id` removida após consumo;
- nenhuma operação Git mutável é exposta.

### Phase 9 — Policy, Approvals and Audit

- superfície MCP pública permanece em 16 tools;
- `GovernanceService` aplicado antes de dispatch de filesystem/process/Git;
- session/command metadata durável em D1;
- idempotency key persistida somente por hash;
- restrictions cloud com precedência `DENY > ASK > ALLOW` e caráter somente restritivo;
- remote approval nunca é enviado ao agent como autoridade local;
- lifecycle de approvals com ownership, binding, TTL e consumo `once`;
- `approval.request` do agent correlacionado a device/session/command/digest;
- endpoint interno para `approval.decision` sem criar Dashboard/UX;
- redispatch de approval local preserva o command original e ocorre somente após consumo do grant;
- audit metadata mínima, bounded e redigida antes de persistir;
- migration `0004_policy_approval_audit.sql` com índices operacionais.

## Boundaries de autenticação

A Phase 5 implementa o resource-server boundary, e as Phases 6–9 reutilizam esse boundary para filesystem, process lifecycle, Git read-only e governança de policy/approvals/audit. O projeto não implementa authorization server próprio nem browser login.

`PairingService.verifyUser(...)` recebe um `user_id` já autenticado. O futuro adapter browser/OAuth deverá chamar esse domínio sem alterar suas invariantes.

Revogação também existe como operação de domínio, mas ainda não como dashboard/API pública autenticada.

## Configuração sensível

O serviço requer, quando pairing, realtime e integração pública estão habilitados:

- `PAIRING_SERVER_SECRET` — pelo menos 32 bytes;
- `PAIRING_VERIFICATION_URI` — HTTPS;
- `REALTIME_SERVER_SECRET` — pelo menos 32 bytes para connection credentials;
- `MCP_RESOURCE_URI` — URI HTTPS canônica da integração;
- `OAUTH_ISSUER` — issuer HTTPS do provedor externo.

Nenhum valor operacional é commitado em `wrangler.jsonc`.

Sem essas configurações, `/ready` falha fechado com `503`.

## Fronteiras intencionais

Ainda não implementados:

- dashboard/approval inbox público;
- policy editor e workspace policy sem um `workspace_id` confiável no command context;
- Git mutável.

Rotas administrativas como `/devices` e `/ws` continuam fechadas; `/mcp` é a superfície pública e, na Phase 9, mantém device info, filesystem typed tools, process lifecycle typed tools e Basic Git read-only. Policy/approvals/audit atuam na governança do dispatch sem adicionar uma nova tool pública.

## Desenvolvimento local

A configuração versionada usa somente um `database_id` placeholder.

```bash
npm run format:check
npm run typecheck
npm test
npm run d1:migrate:local
npm run dry-run
npm audit --audit-level=high
```

`dry-run` gera o bundle sem deploy.

## State ownership

- Worker continua stateless para correção funcional;
- D1 é source of truth durável para pairing/device registration;
- material público pendente vive em `pairings` antes de `ACTIVE`;
- private key nunca sai do agent;
- Durable Object coordena presence/conexão efêmera por device e usa attachment/storage para sobreviver à hibernação;
- D1 continua a autoridade durável para identidade/revogação e, na Phase 9, para sessions, commands, approvals e audit metadata;
- policy restrictions operacionais usam account/device/session; workspace permanece indisponível até existir identidade confiável no command context;
- cloud nunca amplia a policy local do agent.
