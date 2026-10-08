# Phase 16 — Review parcial de compatibilidade MCP

**Data:** 2026-10-08
**Issue:** #49
**Branch:** `phase16/mcp-compatibility-foundation`
**Resultado:** `PHASE_16_IN_PROGRESS` — fundação de protocolo validada; clientes reais ainda NÃO certificados.

## Escopo desta integração incremental

- Baseline Phase 15 conferido em `main` no commit `62a6c8ff879117f003fe025c0f4952ad9154c0d3`, árvore limpa, somente `main` local/remota e PRs abertas zero.
- Pesquisa oficial das versões moderno/legado MCP e flows documentados para ChatGPT/Codex, Claude Code, Gemini CLI, GitHub Copilot.
- Matriz de evidências `PASS/FAIL/BLOCKED/NOT_TESTED`, separando SDK, wire JSON-RPC e produto de terceiro.
- Quatro novos testes negativos e de interoperabilidade: `initialize` 2025-11-25 + `tools/list` em respostas SSE, `write_file` com scope apenas read bloqueado, `Origin` cruzada 403, `Host` incorreto 421.
- `AGENTS.md`, `PROJECT_STATE.md`, roadmap e README do control plane revalidados; docs e threat model de Phase 16 adicionados.

## Evidência reproduzida no PREDATORH300

Ambiente: Windows, Node v24.13.1, npm 11.19.0; `NODE_OPTIONS=--use-system-ca` foi utilizado somente no processo de build para consumir a CA já confiável do sistema, sem `strict-ssl=false` e sem desabilitar TLS ou Avast.

| Gate | Resultado |
|---|---|
| `npm ci --no-audit --no-fund --no-progress` | PASS; 97 packages |
| `vitest run test/mcp.test.ts` | PASS — 15/15 |
| `npm run format:check` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS — **18 arquivos / 116 testes** |
| `npm run dry-run` | PASS — **942.66 KiB / gzip 175.75 KiB** |
| `npm audit --audit-level=high` | PASS — **0 vulnerabilities** |
| Workspace concurrency AB-028/AB-029 | PASS na suite completa |
| Rust/Windows/macOS cross-target | NOT_TESTED nesta iteração; nenhuma mudança do Agent |
| Produto cliente externo real | BLOCKED — sem endpoint/IdP/conta/client instalado neste fluxo |

### Falha diagnosticada e correção validada

Primeira execução de `mcp.test.ts`: 14/15, devido a parse incorreto de SSE pelo novo teste legado. O HTTP 200 retornava `text/event-stream`, não `application/json`. O teste passou a extrair a mensagem JSON-RPC de `data:`; reexecução 15/15. Não houve alteração do MCP server nem relaxamento de segurança.

Prettier identificou uma linha em branco excedente no `apps/control-plane/README.md`, removida. O mesmo arquivo documentava incorretamente que workspace policy ainda não era operacional; corrigido com referência ao ownership da Phase 15.

## Status exato e limites

**PASS de protocolo** está comprovado para SDK moderno e wire legada nos cenários testados. Isso não é certificação de ChatGPT/Codex, Claude, Gemini, Copilot, Cursor ou equivalentes. Conexão real, OAuth interativo, confirmação UX e side effects de cada cliente seguem `BLOCKED`/`NOT_TESTED`. Não foram provisionados domínio, produção, IDP, OAuth de contas pessoais, recursos pagos nem publicação de plugin. As 24 tools MCP, 15 message types, permissões e authority local permanecem inalteradas.

A issue #49 deve permanecer **aberta** após o merge desta fundação. Somente a certificação real subsequente pode alterar o gate para `PHASE_16_COMPLETE`.

## Documentos relacionados

- `docs/research/mcp/phase16-multi-ai-client-revalidation-2026-10-08.md`
- `docs/testing/acceptance/phase16-certification-matrix-2026-10-08.md`
- `docs/security/threat-model/phase16-client-interoperability-2026-10-08.md`
- `docs/testing/acceptance/phase15-exit-review-2026-10-08.md`
