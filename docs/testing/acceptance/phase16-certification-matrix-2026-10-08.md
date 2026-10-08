# Phase 16 — Matriz auditável de certificação Multi-AI

**Data:** 2026-10-08
**Issue:** #49
**Baseline:** 24 MCP tools, 15 Device Wire message types, Phase 15 integrada.
**Regra:** `PASS` de protocolo não equivale a `PASS` de cliente real.

| Sujeito | Versão/transport | Protocol probe | Cliente real | Evidência necessária |
|---|---|---|---|---|
| `@modelcontextprotocol/client` (test harness do repo) | SDK lockfile 2.3.0, MCP moderno 2026-07-28 | PASS — Vitest `mcp.test.ts` | N/A — SDK | `apps/control-plane/test/mcp.test.ts` |
| Wire JSON-RPC sem SDK externo de produto | MCP legado 2025-11-25, Streamable HTTP/SSE | PASS — `initialize`, `tools/list`, 24 tools | N/A — wire | `apps/control-plane/test/mcp.test.ts` Phase 16 |
| ChatGPT plugin Telechir | Remote HTTPS, OAuth e package sujeito a review | BLOCKED — sem endpoint autorizado | BLOCKED — plugin não publicado | Issue #15 e gates externos |
| Codex CLI/IDE | MCP HTTP, versão não aferida | NOT_TESTED | BLOCKED — CLI não instalada/sem MCP HTTPS de teste | `codex mcp list`, sessão consentida |
| Claude Code | MCP HTTP, versão não aferida | NOT_TESTED | BLOCKED — CLI não instalada/sem MCP HTTPS de teste | `claude mcp list`, sessão consentida |
| Gemini CLI | Streamable HTTP, versão não aferida | NOT_TESTED | BLOCKED — CLI não instalada/sem MCP HTTPS de teste | `gemini mcp list`, sessão consentida |
| GitHub Copilot | IDE/Agent, versão e policy não aferidas | NOT_TESTED | BLOCKED — sem host/endpoint de homologação | IDE real com aprovação |
| Cursor/Cline/Roo/OpenCode/Goose | A definir individualmente | NOT_TESTED | NOT_TESTED | Pesquisa oficial e smoke por versão |

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

A execução de um único smoke local não satisfaz o DoD de compatibilidade multi-IA.
