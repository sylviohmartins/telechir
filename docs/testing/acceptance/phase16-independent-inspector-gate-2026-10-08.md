# Phase 16 — Smoke MCP Inspector CLI independente em CI

**Data:** 2026-10-08
**Issue:** #49
**Artefato:** `scripts/interop/inspector-unauthenticated-smoke.sh`
**Gate:** CI GitHub Actions `.github/workflows/mcp-interop.yml` — job `independent-inspector`.

## Objetivo e alcance exato

Executar a implementação **real** `@modelcontextprotocol/inspector@2.5.0` (CLI) como **processo independente** contra o **Worker real** do Telechir servido pelo Wrangler em HTTPS dentro de um runner Ubuntu descartável. O escopo inicial é autenticação **negativa**: comprovar que o cliente não consegue realizar `tools/list` sem token e que não inicia um fluxo OAuth interativo. Esse teste não prova ferramentas descobertas sob login, autorização para executar ações, nem compatibilidade com Codex, ChatGPT, Claude Code, Gemini CLI ou Copilot.

## Segurança e método

1. `npm ci` com lockfile do `apps/control-plane`; `@modelcontextprotocol/inspector` instalado pela CLI de forma **version-pinned** (`2.5.0`).
2. `openssl` gera certificado de **um dia** e chave local temporária no diretório `mktemp` com `umask 077`; nenhum segredo vindo do GitHub, produção ou máquina pessoal.
3. Wrangler sobe `127.0.0.1:8987` com HTTPS e `MCP_RESOURCE_URI` idêntico ao endpoint local. `OAUTH_ISSUER` de teste não resolve para autorização produtiva.
4. HTTP `GET /health` e metadata `/.well-known/oauth-protected-resource` só passam após validação padrão da cadeia de confiança (`curl --cacert`).
5. `verify-local-tls.mjs` verifica **fingerprint SHA-256 exato e CA** antes de qualquer request ao MCP. Não existe `--insecure`, `rejectUnauthorized:false`, token, client secret ou `NODE_TLS_REJECT_UNAUTHORIZED=0`.
6. JSON-RPC `tools/list` sem bearer deve retornar **HTTP 401** com `WWW-Authenticate: Bearer`.
7. O CLI upstream Inspector, com `MCP_STORAGE_DIR` e `MCP_INSPECTOR_OAUTH_STATE_PATH` vazios e isolados, `--stored-auth-only` e `MCP_AUTO_OPEN_ENABLED=false`, deve encerrar com código **3 (auth_required)**. Qualquer saída 0, timeout ou outro exit interrompe CI.
8. `trap` interrompe Wrangler e elimina arquivos temporários, incluindo chave privada e storage OAuth. O job não faz deploy nem abre serviço público.

## Classes de evidência

| Item | Classificação | Comprovação |
|---|---|---|
| TLS loopback e certificado estritamente verificado | RUN-TIME CHECK | Script/exit e logs CI |
| Metadata público e challenge `401` | WIRE REAL | `curl` separado do SDK |
| Rejeição `auth_required` pelo Inspector 2.5.0 | CLIENTE EXTERNO REAL, fluxo sem autenticação | CI Linux `independent-inspector` |
| `tools/list` autorizado 24/24, scopes por usuário, refresh/reconnect | NOT_TESTED neste script | Requer IdP/DB sintéticos e cliente autenticado |
| Integração via clientes IA de fornecedores | BLOCKED/NOT_TESTED | Requer contas, conexão OAuth e gate humano adequado |

**Evidência verificada:** GitHub Actions PR #53, run [#37845791616](https://github.com/sylviohmartins/telechir/actions/runs/37845791616), job `Independent Inspector CLI auth-boundary smoke (Linux)` (**success**, 2026-10-08), logs reais do job confirmam, nesta ordem: `PASS: local-only HTTPS Worker health`, `PASS: TLS certificate fingerprint and chain verified`, `PASS: OAuth protected-resource metadata`, `PASS: unauthenticated MCP tool discovery denied with HTTP 401`, `PASS: MCP Inspector 2.5.0 real CLI correctly rejected absent OAuth credentials`, `RESULT: INDEPENDENT_CLIENT_UNAUTHENTICATED_SMOKE_PASS`. O resultado **PASS** se limita ao handshake HTTPS/metadados e à rejeição de acesso sem token pelo cliente externo; não certifica auth positivo ou produtos fornecedores.

## Limitações remanescentes

O smoke é um teste **negativo**, sem JWT e sem efeito no dispositivo. O Worker utiliza D1/Durable Objects locais, mas não é necessário semear usuários porque a requisição deve falhar antes de qualquer acesso a ferramentas. Não substituir a matriz da Phase 16 por esse teste: MC-010/MC-011/MC-012 permanecem pendentes no que se refere a acesso autenticado e execução real.

## Fontes oficiais

- MCP Inspector CLI: https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli
- MCP Inspector smoke/CI: https://github.com/modelcontextprotocol/inspector/blob/main/docs/cli-smoke-testing.md
- Wrangler local dev: https://developers.cloudflare.com/workers/wrangler/commands/workers/
