# Phase 10 Threat Model Delta — Dashboard

**Data:** 2026-10-05

**Base:** `stride-baseline-2026-10-02.md` e `phase9-policy-approvals-audit-2026-10-05.md`

**Escopo:** nova superfície web administrativa da Phase 10.

## Objetivo

A Phase 10 torna observáveis e operáveis devices, approvals, command/audit timeline, usage/health e revogação sem criar um caminho alternativo ao control plane.

O invariante principal permanece:

> Dashboard é um cliente do control plane. Ele nunca concede autoridade local ao agent e nunca substitui policy, binding, TTL, ownership ou audit.

## Novos trust boundaries

1. **Browser → dashboard API:** bearer OAuth obrigatório e scope específico por operação.
2. **Dashboard API → D1:** toda leitura/mutação é filtrada pelo `user_id` autenticado.
3. **Dashboard API → DeviceCoordinator:** decisões de approval reutilizam o endpoint interno já validado pela Phase 9.
4. **Dashboard API → revogação:** o fluxo existente `revokeDeviceAndCloseRealtime` continua sendo a única orquestração de revoke.
5. **Dashboard bundle → token:** access token fica somente em `sessionStorage` no MVP e não é renderizado após autenticação.

## OAuth e least privilege

A metadata do resource server anuncia três scopes novos:

- `telechir:dashboard:read`;
- `telechir:approvals:decide`;
- `telechir:devices:revoke`.

A autenticação por bearer não é suficiente por si só. Cada rota verifica o scope requerido e responde `403` quando ele não existe.

Isso evita que um token válido emitido somente para uma capability MCP de leitura seja usado como credencial administrativa do Dashboard.

## Ownership e anti-enumeration

As queries de overview filtram pelo usuário autenticado:

- devices;
- sessions;
- commands;
- approvals;
- audit;
- usage/artifact bytes.

Approval decision procura o ID junto com `user_id`. Device revoke também valida `id + user_id` antes da orquestração.

Recursos inexistentes ou pertencentes a outro usuário retornam `404`, reduzindo enumeração cross-account.

## Approvals

O browser envia apenas:

- approval ID na rota;
- `APPROVE` ou `DENY`;
- scope solicitado.

A UI MVP oferece aprovação `once` e negação. Ela não fabrica:

- command ID;
- device/session binding;
- permission;
- risk;
- argument digest;
- autoridade local do agent.

Antes do Durable Object:

- approval precisa pertencer ao usuário;
- TTL precisa estar válido;
- `decision` precisa permanecer nula;
- `consumed_at` precisa permanecer nulo.

A Phase 9 continua responsável pelo binding completo e consumo antes de redispatch. Double-submit retorna conflito e não gera novo side effect.

## Revogação

Revogar device é destrutivo e exige duas confirmações complementares:

- confirmação explícita do usuário no browser;
- `confirm: true` no request da API.

Após ownership check, o control plane reutiliza a operação existente que:

- marca device revogado;
- revoga keys;
- revoga pairing ativo;
- fecha a conexão realtime.

A revogação de um device já revogado é idempotente e devolve o timestamp existente.

## Minimização de dados

O overview não retorna:

- OAuth bearer token;
- secrets;
- password/cookie/credential/private key/API key;
- argumentos completos de command;
- idempotency key;
- argument digest de approval;
- `user_id` redundante do approval.

O contexto humano de approval é sintetizado a partir de tool/operation/permission. Audit usa somente a metadata já limitada e redigida antes da persistência.

## Abuse cases exercitados

| Cenário | Controle |
|---|---|
| usuário A lê estado de B | todas as listas filtradas por owner; teste dedicado |
| usuário A decide approval de B | lookup `id + user_id`; retorna 404 |
| usuário A revoga device de B | ownership check antes de qualquer realtime orchestration |
| bearer válido sem scope administrativo | scope gate retorna 403 |
| approval expirado | rejeitado com 409 antes de contato com device |
| double-submit de approval | estado decidido/consumido rejeitado com 409 |
| payload sensível aparece no overview | DTO e SELECT minimizados; argumentos/digest não são retornados |
| browser amplia policy local | impossível; decisão passa pela mesma governança da Phase 9 |
| revoke sem confirmação | API rejeita antes de mutação |
| device offline | overview continua funcional; presença é somente estado efêmero e revoke permanece durável |

## Limites deliberados

Não fazem parte da Phase 10:

- web terminal;
- screen viewer/streaming;
- policy editor;
- permanent approval rules;
- Git mutável;
- shell irrestrito;
- elevation/admin;
- secret broker;
- sandbox;
- browser/computer-use;
- deploy de produção.

O MVP também não implementa authorization server ou fluxo interativo de browser login. Ele consome um access token emitido externamente. Essa limitação é aceitável nesta fase porque não há deploy público; a experiência de distribuição/autorização passa a ser tratada no gate da Phase 11.

## Riscos residuais

- XSS no Dashboard teria impacto sobre o bearer presente em `sessionStorage`; CSP/headers de produção e fluxo OAuth browser são release hardening futuro;
- a timeline é bounded por limite de resposta, mas ainda não implementa cursor de paginação completo;
- presence depende do Durable Object e pode degradar para offline em falha de consulta;
- o audit exibido herda a qualidade de redaction da origem; novos tipos de metadata precisam manter o mesmo padrão;
- revogação é irreversível no MVP e não oferece reativação automática.

## Resultado

A Phase 10 adiciona uma superfície administrativa sem ampliar a autoridade do agent. OAuth scopes, ownership, DTO minimizado, confirmação de revoke e reutilização da pipeline da Phase 9 preservam fail-closed e least privilege.
