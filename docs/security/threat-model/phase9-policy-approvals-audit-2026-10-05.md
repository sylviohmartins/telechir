# Phase 9 Threat Model Delta — Policy, Approvals and Audit

**Data:** 2026-10-05

**Base:** `stride-baseline-2026-10-02.md`

**Escopo:** delta de segurança introduzido pela Phase 9; a baseline STRIDE permanece a referência principal.

## Objetivo

A Phase 9 materializa a fronteira de autorização descrita em `specs/policy/authorization-and-approvals.md` e no ADR-0003 sem ampliar a superfície pública de tools.

O invariante continua sendo:

> A policy local do device define o teto. Nenhuma policy cloud, scope OAuth, approval remoto ou instrução do modelo pode ampliar esse teto.

## Novos controles materializados

### Autoridade local

- o agent executa `LocalPolicyEngine` imediatamente antes do side effect;
- risco remoto é tratado como piso solicitado e pode ser elevado localmente;
- `CRITICAL` permanece fail-closed porque a Phase 9 ainda não possui superfície de confirmação local;
- permissões fora do teto atual permanecem hard-denied, incluindo `FS_DELETE`, `SHELL_FULL`, `NETWORK`, `GIT_WRITE`, `GIT_REMOTE_WRITE`, `SECRET_USE`, `ELEVATION` e `ADMIN`;
- approval remoto nunca é encaminhado ao agent como autoridade local.

### Binding de approval

Approval local é correlacionado por:

- `approval_id`;
- `command_id`;
- `session_id`;
- permission;
- risk;
- digest Base64 URL-safe SHA-256 dos argumentos normalizados;
- TTL.

O digest cobre operação, argumentos e permissions ordenadas. Alteração de payload, command ou session invalida o grant.

### Consumo e replay

- approval `once` é removido no agent na primeira autorização válida;
- no control plane, o consumo `once` usa `UPDATE` condicional que exige `APPROVE`, ausência de `consumed_at` e TTL ainda válido;
- antes de redispatch de um approval local, o control plane consome o grant persistido; falha de persistência ocorre antes de qualquer mensagem que libere o side effect;
- a correlação do `command.request` é persistida no Durable Object antes de o frame ser enviado ao WebSocket, inclusive no redispatch pós-approval;
- retries/reconnects continuam dependentes da idempotência da operação e não reproduzem automaticamente comandos aceitos.

### Audit minimizado

O agent mantém um ring buffer local bounded com:

- event ID imutável;
- event type;
- command ID;
- policy revision;
- decision;
- risk;
- approval ID quando aplicável;
- argument digest;
- timestamp.

O control plane persiste metadata correlacionável em `audit_events`, com redaction estruturada e limites de profundidade, tamanho de strings, arrays e quantidade de chaves.

Não são persistidos por default:

- bearer/access tokens;
- secret values;
- passwords/cookies/credentials/private keys/API keys;
- conteúdo completo de arquivo;
- idempotency key em claro.

## Revalidação dos abuse cases da baseline

| Abuse case | Estado na Phase 9 | Evidência/controle |
|---|---|---|
| AB-024 — approval expirado | Coberto | TTL validado no agent e D1; approval expirado não concede execução |
| AB-025 — approval de A usado em B | Coberto | command/session/permission/risk/argument digest binding |
| AB-029 — reconnect reexecuta comando | Mantido | realtime não faz replay automático; side effects preservam idempotency |
| AB-031 — cloud tenta ampliar policy local | Coberto | remote approval não vira `approval_id` local; hard deny local prevalece |
| AB-032 — cloud marca comando crítico como LOW | Coberto | classificação local eleva o risco mínimo; `CRITICAL` é fail-closed |
| AB-034 — bearer token em audit/log | Coberto | redaction por chave e por padrão `Bearer ...`, testada antes da persistência |

## Hardening adicional encontrado durante os gates

O gate Rust revelou que a classificação `SHELL_SAFE` removia `./` ou `.\\` antes de verificar se o executável era um path. Isso permitiria que um approval válido atravessasse a barreira de executável por caminho explícito.

A ordem foi corrigida: qualquer executable contendo separador de path é recusado antes da normalização de sufixo. O teste confirma que `./tool` permanece `POLICY_DENIED` mesmo com approval verificado.

## Trust boundaries revalidados

1. **AI client → control plane:** OAuth/scopes continuam restritivos e não carregam bearer token no command envelope.
2. **Control plane → device:** policy cloud só pode negar ou exigir condição adicional; não concede authority local.
3. **Approval decision → command:** ownership e binding por user/device/session/command/digest são validados antes do redispatch.
4. **Agent → OS:** policy local e preflight são executados imediatamente antes do executor realizar side effect.
5. **Audit storage:** somente metadata bounded/redigida cruza para D1.

## Limites deliberados da Phase 9

- não existe Dashboard/approval inbox;
- não existe policy editor;
- scope `rule` não existe;
- `CRITICAL` não possui confirmação local e portanto é negado;
- Git mutável, shell irrestrito, elevation/admin, secret broker, sandbox, browser e computer use continuam indisponíveis;
- não existe deploy remoto de produção.

### Workspace policy

As tools atuais não transportam uma identidade de workspace no contexto do control plane. Portanto, a avaliação operacional de `policy_restrictions` nesta fase cobre somente scopes para os quais existe identidade confiável no request atual: account, device e session.

A Phase 9 **não declara workspace policy como operacional**. Quando um `workspace_id` confiável fizer parte do command context, o scope deve ser adicionado à mesma avaliação restritiva; até lá, nenhuma funcionalidade é exposta como protegida por workspace policy.

## Riscos residuais

- shell continua sendo uma superfície poderosa mesmo sob `SHELL_SAFE`;
- um host comprometido pode comprometer o agent;
- policy local da Phase 9 é baseline estática em código, ainda sem editor/configuração persistente do usuário;
- approval `session` local permanece conservador: além da session, continua ligado ao command/digest original, portanto não se transforma em grant genérico;
- sem Dashboard, decisões de approval são exercitadas apenas pela API/serviço interno;
- clock skew continua sendo risco residual da baseline; TTL é curto e bounded, mas monotonic-time hardening completo não foi introduzido nesta fase.

## Resultado

Os controles adicionados preservam o ADR-0003 e reduzem o risco dos abuse cases diretamente afetados pela nova capability. A Phase 10 pode consumir a mesma pipeline de autorização, mas o Dashboard não poderá introduzir caminho alternativo ou bypass.
