# Phase 16 — Matriz auditável de certificação Multi-AI

**Data:** 2026-10-08
**Issue:** #49
**Baseline:** 24 MCP tools, 15 Device Wire message types, Phase 15 integrada.
**Regra:** `PASS` de protocolo não equivale a `PASS` de cliente real.

| Sujeito | Versão/transport | Protocol probe | Cliente real | Evidência necessária |
|---|---|---|---|---|
| `@modelcontextprotocol/client` (test harness do repo) | SDK lockfile 2.3.0, MCP moderno 2026-07-28 | PASS — Vitest `mcp.test.ts` | N/A — SDK | `apps/control-plane/test/mcp.test.ts` |
| OAuth Authorization Code/PKCE S256 fixture | Emissor sintético HTTPS loopback e cliente de teste Node 24 | PASS — discovery, code/state, PKCE S256, JWKS/RS256, resource binding, replay e negativas | N/A — não é IdP nem cliente comercial | [CI #37887181576](https://github.com/sylviohmartins/telechir/actions/runs/37887181576), `oauth-pkce-https-smoke.mjs` |
| Wire JSON-RPC sem SDK externo de produto | MCP legado 2025-11-25, Streamable HTTP/SSE | PASS — `initialize`, `tools/list`, 24 tools | N/A — wire | `apps/control-plane/test/mcp.test.ts` Phase 16 |
| MCP Inspector CLI externo | 2.5.0, HTTPS Streamable HTTP, runner Linux descartável | PASS — TLS validado, metadata, 401/WWW-Authenticate | PASS para challenge sem token e sessão autenticada JWT RS256 sintética (24 tools, `list_devices` e recusa de escrita); fluxo PKCE/IdP real NOT_TESTED | [GitHub Actions #37845791616](https://github.com/sylviohmartins/telechir/actions/runs/37845791616) |
| ChatGPT plugin Telechir | Remote HTTPS, OAuth e package sujeito a review | BLOCKED — sem endpoint autorizado | BLOCKED — plugin não publicado | Issue #15 e gates externos |
| Codex CLI (App Server) | **0.162.0**, Streamable HTTPS, JWT RS256, Ubuntu CI | **PASS — cliente oficial executa ferramenta MCP read-only** via `mcpServer/tool/call` | `list_devices` devolve exatamente um device sintético com ID esperado; chamada mediada por modelo LLM, PKCE pelo cliente e IdP real NOT_TESTED | [CI #37892176590](https://github.com/sylviohmartins/telechir/actions/runs/37892176590), `codex-app-server-readonly-probe.py` |
| Claude Code | **2.1.295**, Streamable HTTPS, JWT RS256, Ubuntu CI | **PASS limitado — conexão MCP de CLI real** | `Connected` via `claude mcp list`; execução de ferramentas por LLM, PKCE via CLI e IdP real NOT_TESTED | [CI #37890233252](https://github.com/sylviohmartins/telechir/actions/runs/37890233252), `claude-code-authenticated-probe.sh` |
| Gemini CLI | **0.63.0**, Streamable HTTPS, JWT RS256, runner Linux | **PASS limitado — conexão MCP de CLI real** com recurso protegido e Bearer sintético | **CONNECTED** em `gemini mcp list`; tool call via LLM, PKCE via CLI e IdP real NOT_TESTED | [PR #58](https://github.com/sylviohmartins/telechir/pull/58), `gemini-cli-authenticated-probe.sh` |
| GitHub Copilot | IDE/Agent, versão e policy não aferidas | NOT_TESTED | BLOCKED — sem host/endpoint de homologação | IDE real com aprovação |
| Cursor/Cline/Roo/OpenCode/Goose | A definir individualmente | NOT_TESTED | NOT_TESTED | Pesquisa oficial e smoke por versão |

## Incremento: cliente Inspector CLI independente no CI Linux

O job `independent-inspector` executa o `@modelcontextprotocol/inspector@2.5.0` real em processo independente contra um Worker Wrangler isolado por HTTPS. Testa exclusivamente a negativa sem bearer: TLS com pinning, discovery de metadata OAuth, 401 no wire e código 3 (`auth_required`) no Inspector com `--stored-auth-only`. **PASS REAL VERIFICADO:** job Inspector CLI do run GitHub Actions [#37845791616](https://github.com/sylviohmartins/telechir/actions/runs/37845791616) concluído `success` com TLS pinning, metadata, 401 e `auth_required` (exit 3). Mesmo assim, acesso autenticado às 24 tools e clientes de IA de fornecedores continuam BLOCKED/NOT_TESTED. Evidência/limites: `docs/testing/acceptance/phase16-independent-inspector-gate-2026-10-08.md`.

## Ensaio autenticado independente (CI; conclusão a verificar)

Adicionado harness `scripts/interop/inspector-authenticated-smoke.sh`: Worker de fixture isolado com rota MCP real, `JwtAccessTokenVerifier` real, JWT RS256 efêmero, descoberta OAuth/JWKS sintética, D1 local com usuário/device sintético, HTTPS local com pinning, Inspector CLI 2.5.0 real verificando initialize, 24 tools, leitura `list_devices` e negação de escrita. **PASS REMOTO VERIFICADO:** [GitHub Actions #37881808611](https://github.com/sylviohmartins/telechir/actions/runs/37881808611) concluiu os dois jobs `success` (125/125 testes do control plane, Inspector CLI autenticado). O Inspector executou `initialize`, enumerou as 24 ferramentas e leu dispositivo sintético vinculado ao JWT RS256. O Inspector preventivamente recusou escrita por falta do scope; a rota real também retornou HTTP 403 quando invocada diretamente. Não houve fluxo authorization code/PKCE nem IdP real. A evidência completa e os limites estão em `docs/testing/acceptance/phase16-authenticated-inspector-ci-2026-10-09.md`. Não é IdP real nem cliente comercial certificado.

## PKCE S256 com servidor OAuth sintético em HTTPS (2026-10-09)

GitHub Actions [#37887181576](https://github.com/sylviohmartins/telechir/actions/runs/37887181576) confirmou **PASS** no smoke `scripts/interop/oauth-pkce-https-smoke.sh`: issuer/JWKS via HTTPS de loopback com TLS pinning; authorization code + `state`; troca com `code_verifier` S256; bearer JWT RS256 vinculado a `resource`; negações de downgrade, audience/client/redirect/scope inadequados, verificador inválido e replay. **O emissor, o cliente e a identidade são sintéticos**. Este não é um login PKCE via MCP Inspector nem teste de IdP real. A matriz de clientes comerciais não muda. Detalhes em `docs/testing/acceptance/phase16-pkce-https-isolated-2026-10-09.md`.

## Keycloak real — contrato de emissão/JWKS, sem OAuth E2E (2026-10-09)

O serviço oficial **Keycloak 26.8.0**, iniciado como contêiner descartável no Ubuntu CI, publicou discovery OIDC e JWKS reais por HTTPS com CA/leaf efêmeros. O realm de laboratório foi provisionado via **Admin REST API autenticada**, e o token de acesso real de `client_credentials` foi validado usando `jose` contra a JWKS **publicada pelo Keycloak**. Critérios comprovados: RS256, `kid`, `iss`, `sub`, `azp`, `exp`, claim read-only mapeada, `aud=https://127.0.0.1:8988/mcp` e negação de `aud` incorreta. **PASS:** [GitHub Actions #37975016365](https://github.com/sylviohmartins/telechir/actions/runs/37975016365), **3/3 jobs success**. O token **não foi utilizado na rota MCP/Worker do Telechir**, a claim `telechir_scope_fixture` ainda precisa de parametrização no Worker, e **Authorization Code + PKCE com Keycloak real, login, consentimento e provedores hospedados não foram certificados**. Evidência: `docs/testing/acceptance/phase16-keycloak-real-idp-token-contract-2026-10-09.md`.

## Keycloak real → verificador OAuth de produção (gate em validação)

O ensaio incremental reutiliza o Keycloak real do PR #65 e passa seu JWT RS256 pelo `JwtAccessTokenVerifier` **sem modificar a produção**. Exercita JWKS/discovery HTTPS, vinculação `sub` por SHA-256, claim de leitura parametrizada, identidade não vinculada/desativada, assinatura alterada e audiência incorreta. Os casos negativos exigem `InvalidToken`, e dados temporários são descartados. **Status: PASS delimitado** na [CI #37979177621](https://github.com/sylviohmartins/telechir/actions/runs/37979177621), 3/3 jobs success e marcador `KEYCLOAK_TELECHIR_PRODUCTION_VERIFIER_PASS`; merge condicionado à CI verde do último commit. O banco é um adaptador **in-process**, portanto **não** demonstra o Worker/D1 ou a ferramenta MCP consumindo o JWT Keycloak. Detalhes: `phase16-keycloak-production-verifier-2026-10-09.md`.

## Keycloak real → Worker HTTPS MCP → D1 local (em validação)

O incremento subsequente utiliza o **JWT RS256 emitido pelo Keycloak oficial 26.8.0** no `mcpHttpRoute` e `JwtAccessTokenVerifier` de produção executados em Worker Wrangler HTTPS real. A identidade e os dois devices residem em **D1 local verdadeiro**, sem contas de usuário reais. Exige leitura `list_devices` isolada por owner, ausência de Bearer e assinatura adulterada em HTTP 401, `write_file` somente leitura em HTTP 403, além de negativa pós-`users.disabled_at` com o mesmo token. **Status: PASS delimitado** no job Keycloak da [CI #37980819190](https://github.com/sylviohmartins/telechir/actions/runs/37980819190), com marcadores `KEYCLOAK_WORKER_D1_MCP_READONLY_PASS`, `KEYCLOAK_WORKER_D1_DISABLED_USER_PASS` e `KEYCLOAK_WORKER_D1_MCP_AUTHENTICATED_PASS`; validar novamente o último head antes do merge. **Limitação específica:** metadata RFC 8414 e JWKS são consultados do Keycloak via HTTPS verificado no bootstrap e fornecidos ao Worker como **snapshots públicos de teste**; o Worker não faz outbound TLS ao Keycloak neste gate. Sem Authorization Code+PKCE, LLM, IdP comercial ou Cloudflare hospedada. Detalhes: `phase16-keycloak-worker-d1-mcp-2026-10-09.md`.

## Workerd → Keycloak HTTPS direto — CA positiva/negativa (gate em validação)

**PASS delimitado:** [CI #37982415861](https://github.com/sylviohmartins/telechir/actions/runs/37982415861) (3/3 jobs success, commit `0222d61`), marcador `KEYCLOAK_WORKER_DIRECT_TLS_OAUTH_JWKS_PASS`. O ensaio retira inteiramente o replay de discovery RFC 8414 e JWKS no Workerd, utiliza o `JwtAccessTokenVerifier` de produção com seu `fetch()` real e configura CA efêmera de Keycloak exclusivamente via `NODE_EXTRA_CA_CERTS` no processo Wrangler. **Sem a CA correta, HTTP 401; com a CA correta, discovery/JWKS diretamente do Keycloak e autorização MCP/D1 válidas.** Novas regressões exigem `redirect: manual` e negação de 3xx (compatibilidade com Workerd). Reexecutar três jobs no head final antes de merge. **Não equivale a Worker hospedado, IdP gerenciado ou PKCE de cliente humano.** Documento: `phase16-keycloak-workerd-direct-tls-2026-10-09.md`.

## Chromium real — PKCE + tela de consentimento Keycloak (novo gate)

**PASS delimitado:** [CI #37989967995](https://github.com/sylviohmartins/telechir/actions/runs/37989967995), 3/3 jobs success no commit `b8a7737`, marcadores `KEYCLOAK_CHROMIUM_BROWSER_PKCE_CONSENT_PASS` e `KEYCLOAK_CHROMIUM_BROWSER_PKCE_MCP_D1_PASS`. Google Chrome Stable headless real via Playwright 1.58.2 e trust NSS temporário com CA de Keycloak; controle negativo com CA de outro servidor; login por controles DOM do IdP; consentimento rejeitado (`access_denied`) e aceito; callback HTTP loopback real com validação de `state`; JWT real de Keycloak com audiência MCP; códigos reutilizados, verifier incorreto e code expirado recusados; **mesma identidade D1/mesmo `sub` entre o cliente PKCE HTTP e o cliente Chrome, sem violar UNIQUE(issuer, subject_hash)**; MCP Worker/JWKS HTTPS direta com negativas de owner/scope/disabled. **Não equivale a usuário real, cliente de IA autenticado interativamente nem cloud implantada.** Documento: `phase16-keycloak-browser-pkce-2026-10-09.md`.

## Keycloak real Authorization Code + PKCE S256 — login de usuário sintético

**PASS delimitado:** [CI #37984488017](https://github.com/sylviohmartins/telechir/actions/runs/37984488017) (3/3 jobs success; commit `2efee83`; marcadores `KEYCLOAK_REAL_AUTHORIZATION_CODE_PKCE_S256_PASS` e `KEYCLOAK_REAL_PKCE_MCP_D1_HUMAN_USER_PASS`). A extensão CI autenticou uma pessoa sintética de laboratório na **página HTML real** do Keycloak 26.8.0 via cliente HTTP de teste, em cliente público com PKCE S256 obrigatório. O teste verificou downgrade/missing challenge, substituição de `state` (proteção do **cliente**, não do IdP), troca por verifier errado, redirect URI divergente, replay de código pós-emissão válida, `sub` de humano diferente do cliente de serviço, audiência/scope do JWT e `list_devices` de uma identidade humana vinculada ao D1 local via Workerd com discovery/JWKS HTTPS diretos, incluindo isolamento e desativação do usuário. **Sem prova de navegador visual, consentimento humano (consentRequired=false no lab), MFA, client comercial, modelo LLM ou cloud hospedada.** Documento: `phase16-keycloak-real-pkce-2026-10-09.md`.

## Codex App Server — desativação e reconexão fail-closed (2026-10-09)

O cliente oficial `@openai/codex@0.162.0` executou `list_devices` com JWT válido, teve seu usuário sintético **desativado no D1 persistido** e, **sem fechar o processo ou trocar a thread**, teve outra chamada com o **mesmo JWT** negada. Novo processo usando esse JWT ainda não expirado também falhou; JWT RS256 intencionalmente expirado foi recusado. **PASS:** [CI #37967586920](https://github.com/sylviohmartins/telechir/actions/runs/37967586920), 2/2 jobs `success`. Identificadores de evidência: `CODEX_IN_SESSION_USER_DISABLED_PASS`, `CODEX_DISABLED_USER_NEW_SESSION_PASS`, `CODEX_AUTH_BOUNDARY_EXPIRED_PASS`. **Não equivale à revogação individual de JWT (`jti`), à desconexão ativa nem ao logout de IdP remoto.** Registro detalhado: `docs/testing/acceptance/phase16-codex-user-disable-reconnect-2026-10-09.md`.

## Codex App Server — negativas autenticadas pelo cliente oficial (2026-10-09)

O `@openai/codex@0.162.0` real executou cinco sessões `mcpServer/tool/call` independentes, cada uma com processo, `CODEX_HOME` e thread efêmera. **PASS CI:** [GitHub Actions #37964924397](https://github.com/sylviohmartins/telechir/actions/runs/37964924397), dois jobs `success`: (1) `list_devices` autorizado devolveu o device sintético esperado; (2) Bearer ausente foi **bloqueado no próprio Codex** antes de enviar requisição; (3) JWT RSA com audience incorreta e (4) token malformado receberam `Auth required` no handshake; (5) tentativa de `write_file` com JWT somente leitura recebeu `Insufficient scope`. Não confundir bloqueio local sem token com status HTTP 401 remoto. Esse teste verifica o runtime oficial, **não** uma escolha de ferramenta por modelo de IA. Evidência detalhada: `docs/testing/acceptance/phase16-codex-auth-boundary-negatives-2026-10-09.md`.

## Codex CLI oficial — execução de ferramenta por App Server (2026-10-09)

O `@openai/codex@0.162.0` real executou **`mcpServer/tool/call` com `tool=list_devices`** após `initialize` e `thread/start` efêmera. A chamada atravessou Streamable HTTPS verificado por certificado leaf + CA efêmera, JWT RS256 sintético, `mcpHttpRoute` e `JwtAccessTokenVerifier` de produção, chegando a D1 local isolado. O retorno continha exatamente o `device_id` semeado. **PASS REMOTO:** [GitHub Actions #37892176590](https://github.com/sylviohmartins/telechir/actions/runs/37892176590), 2/2 jobs `success`. Não houve credenciais reais, modelo OpenAI invocando tools, fluxo PKCE no cliente, IdP externo ou deploy. O teste `codex mcp list` sozinho não seria comprovação de conexão real; utilizou-se o recurso direto do App Server de acordo com a suíte oficial de conformidade Codex. Ver `docs/testing/acceptance/phase16-codex-app-server-authenticated-readonly-2026-10-09.md`.

## Claude Code CLI real — conexão autenticada (2026-10-09)

O `@anthropic-ai/claude-code@2.1.295` real executou `claude mcp list` num processo independente e reportou `telechir-fixture ... Connected` por HTTPS validado e JWT RS256 sintético aceito pela rota e pelo verificador de produção do Telechir. **PASS CI comprovado:** [GitHub Actions #37890233252](https://github.com/sylviohmartins/telechir/actions/runs/37890233252), dois jobs `success`. O comando ocorreu com `HOME` temporário, `.claude.json` privado, sem login nem credenciais comerciais; todo estado descartado. A primeira tentativa falhou apenas por diretório de configuração incorreto, corrigido sem alterações na aplicação. Não houve execução do modelo Claude, chamadas de ferramentas pela IA, OAuth PKCE no cliente, IdP externo ou deploy. Evidências: `docs/testing/acceptance/phase16-claude-code-cli-authenticated-2026-10-09.md`.

## Gemini CLI real — conexão com JWT assinado, sem inferência LLM

No [PR #58](https://github.com/sylviohmartins/telechir/pull/58), o **Google Gemini CLI 0.63.0 real** reconheceu e conectou `telechir-fixture` por Streamable HTTPS com Bearer RS256 válido, pinning de certificado, JWKS sintética e banco D1 isolado. O primeiro teste diagnosticou `Disabled` por diretório temporário não confiável (comportamento de segurança correto do cliente); o CI passou a conceder trust apenas para o processo naquele diretório descartável. O segundo revelou que o status `Connected` é enviado a `stderr`, corrigindo-se o verificador de saída sem relaxar o predicado. O teste de conexão não inclui comando de modelo Gemini, execução de tool por LLM, fluxo PKCE dentro da CLI ou IdP de terceiros. A documentação de aceitação está em `docs/testing/acceptance/phase16-gemini-cli-authenticated-2026-10-09.md`.

## Regressões do verificador OAuth (in-process)

O ciclo adicional de Phase 16 acrescentou casos de **usuário desativado**, **deduplicação de scopes JWT como string/array** e **rejeição de token malformado/alg=none antes de busca JWKS** no verificador real. Ensaio direcionado `oauth.test.ts`: **13/13 PASS**. **Isto não é um teste do Inspector autenticado.** A integração externa CLI + JWT válido + D1 foi posteriormente testada com Inspector e Gemini CLI; o texto acima refere-se ao gate de 2026-10-08. Detalhes em `docs/testing/acceptance/phase16-oauth-fail-closed-regression-2026-10-08.md`.

## Casos e invariantes obrigatórios

| ID | Critério | Evidência automatizada esperada |
|---|---|---|
| MC-001 | `server/discover` moderno, 24 tools | `mcp.test.ts` |
| MC-002 | `initialize` legado, tools/list, 24 tools | `mcp.test.ts`, Phase 16 |
| MC-003 | input/output schema, annotations, security schemes | `mcp.test.ts` |
| MC-004 | token inválido 401 + metadata; scope insufficiente 403 | `mcp.test.ts` |
| MC-005 | cross-owner and revoked device fail-closed | `mcp.test.ts` e ownership tests |
| MC-006 | Origin/host host bound; body bounded | `mcp.test.ts`, Phase 16 |
| MC-007 | non-replay/reconnect & lease conflicts | `workspace-concurrency.test.ts` AB-028/AB-029 |
| MC-008 | local device policy/approval/digest confirmation | testes de governance/agent |
| MC-009 | dados não confiáveis/sensitive audit redaction | tests Browser/Computer/security |
| MC-010 | real client discovery + safe tool call | **BLOCKED** até cliente e endpoint de homologação |
| MC-011 | real client OAuth e escalation denial | **BLOCKED** até IdP/client reais |
| MC-012 | real multi-client contention/reconnect | **BLOCKED** até clientes reais e device de teste |

## Regra de aceite

Para declarar `PHASE_16_COMPLETE`, é preciso critérios objetivos e evidência de **clientes reais** do conjunto alvo, com pelo menos leitura autorizada, erro/scope negado e um side effect benigno com confirmação adequada, além de AB-028/029, regressão dos tool schemas e auth. Qualquer cliente não ensaiado deve permanecer marcado `BLOCKED`/`NOT_TESTED`, e a redação de suporte público deve limitar-se ao que foi comprovado.

### Evidência de execução — 2026-10-08

`npm exec -- vitest run test/mcp.test.ts` no PREDATORH300 após `npm ci` (Node 24.13.1, Vitest 4.1.11): **15 testes PASS**, incluindo quatro casos Phase 16. O primeiro ensaio detectou um problema **no próprio harness**: o cliente legado recebia `text/event-stream` e o teste tentava `Response.json()`. O teste foi corrigido para interpretar o evento SSE `data:` e reexecutado com 15/15 PASS. **Nenhuma alteração do servidor foi necessária.** Não houve teste de cliente proprietário real.

### Evidência externa e CI do terceiro ciclo

CI GitHub Actions comprovadamente **PASS** no PR #51 e no push da `main` (`37843796029`, `37843837500`), com checkout, Node 24, npm ci, tests, format, typecheck, Wrangler dry-run e audit aprovados. O ensaio com endpoint real em Wrangler `https://localhost:8987/mcp` revelou **TLS_CERTIFICATE_SUBSTITUTED** pelo Avast: a conexão externa foi deliberadamente bloqueada antes de executar o MCP Inspector ou enviar qualquer bearer. O preflight de fingerprint SHA-256 e seus testes unitários ficaram versionados no repositório. Ver `docs/testing/acceptance/phase16-verified-ci-and-local-tls-2026-10-08.md`. **Nenhum cliente de produto externo foi certificado.**

### Evolução da suíte — segundo ciclo da Phase 16

Na regressão local final desta etapa, os 18 arquivos de teste do control plane passaram (**119/119**); o arquivo MCP passou **18/18**. O ciclo incremental adicionou três cenários de segurança/interoperabilidade: paridade dos 24 descriptors no wire legado (schema, annotations e metadata OAuth); dois owners diferentes acessando o MCP simultaneamente sem vazar device IDs; bearer ausente/inválido e tentativa de browser por token somente de filesystem. O fixture falso de tokens foi corrigido para emitir `OAuthError(InvalidToken)` tal como o verificador JWT real; nenhuma política do runtime foi alterada. Há agora um workflow GitHub Actions restrito, sem deploy, para repetir os gates de control plane. **A conclusão real do workflow deve ser verificada no GitHub; não deduzir PASS do arquivo YAML.**

Ver `phase16-interop-regression-ci-2026-10-08.md` e `docs/research/mcp/phase16-external-client-smoke-plan-2026-10-08.md`.

### Integração com JWT RS256 real + cliente oficial (2026-10-09)

O harness adicional `apps/control-plane/test/mcp-signed-client.test.ts` executa clientes reais do SDK (`@modelcontextprotocol/client`) usando **JWTs RS256 assinados e verificados por `JwtAccessTokenVerifier`**, metadata OAuth e JWKS sintéticos, e contas D1 vinculadas por hash de subject. Teste dirigido **3/3 PASS**: modos moderno/legado, discovery das 24 tools, dois owners isolados, scope de escrita negado em HTTP 403 e audience errada negada em HTTP 401. É integração in-process com fetch injetado e issuer de fixture; **não equivale a autenticação com IdP real ou certificação de clientes externos**. Evidência em `docs/testing/acceptance/phase16-signed-jwt-client-integration-2026-10-09.md`.

A execução de um único smoke local não satisfaz o DoD de compatibilidade multi-IA.
