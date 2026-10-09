# Phase 16 — Codex App Server: negativas de autenticação e escopo

**Data:** 2026-10-09

**Issue:** [#49](https://github.com/sylviohmartins/telechir/issues/49)

**Cliente testado:** `@openai/codex@0.162.0`, executável real, via `codex app-server` com API `mcpServer/tool/call`.

**Resultado observado:** PASS de todos os cinco cenários no [GitHub Actions #37964924397](https://github.com/sylviohmartins/telechir/actions/runs/37964924397), com 2/2 jobs `success`; o commit documental final deve ter os próprios checks aprovados antes do merge.

## Objetivo e mecanismo

Provar que o **cliente Codex oficial**, e não só chamadas HTTP diretas de teste, não consegue usar ferramentas do Telechir quando a credencial é ausente, inválida ou insuficiente. Cada cenário inicia um processo `codex app-server` novo com `CODEX_HOME` distinto e `thread/start` efêmera; a comunicação App Server usa JSON Lines.

Executar o controle positivo antes das negativas. Isso diferencia indisponibilidade de rede/TLS de negação válida. O certificado do endpoint é emitido por CA efêmera distinta, possui `CA:FALSE` e `serverAuth`, e é validado pela cadeia e pelo fingerprint do leaf. O `CODEX_CA_CERTIFICATE` vale só para o subprocesso; não há `insecure`, desativação TLS nem instalação global de root.

## Matriz de cenários

| Cenário | Ferramenta MCP | Credencial por sessão | Resultado esperado |
|---|---|---|---|
| `read` (controle) | `list_devices` | JWT RS256 válido, `telechir:devices:read` | PASS com apenas o dispositivo sintético semeado |
| `no-token` | `list_devices` | Sem variável de ambiente bearer | Rejeição de autenticação; se o próprio Codex recusar a ausência da env antes da requisição, registrar isso como bloqueio **do cliente**, não como resposta HTTP 401 |
| `wrong-audience` | `list_devices` | JWT RS256 válido na assinatura, mas `aud` incorreta | Negação; nunca retornar dispositivo |
| `malformed` | `list_devices` | Token não assinado e malformado | Negação; nunca retornar dispositivo |
| `write-denied` | `write_file` | JWT com apenas `telechir:devices:read` | Rejeição de autorização/escopo de escrita; argumentos vazios evitam qualquer alteração legítima |

O harness deve reconhecer uma negativa apenas por sinais de **autenticação ou escopo** em erro do App Server ou resultado MCP marcado `isError`. Um erro genérico de TLS, inicialização ou ferramenta inexistente **não constitui PASS**. Qualquer retorno bem-sucedido de ferramenta em cenário negativo é `FAIL`.

Os tokens, arquivos de configuração, certs e registros do D1 são descartados no encerramento da execução. `HOME`, `CODEX_HOME`, `NO_PROXY` e secrets de conta permanecem isolados; chaves OpenAI externas são removidas do ambiente filho. O JWT temporário não aparece em linha de comando nem nos logs publicados.

## Limites

Mesmo após PASS, este ensaio **não prova** autorização feita por IdP externo, login OAuth via navegador, consentimento, token revogado, tool call escolhido pelo modelo Codex ou ferramentas em dispositivos físicos. Negação feita no cliente pela ausência de variável bearer não pode ser relatada como resposta HTTP 401 no servidor; o smoke HTTP independente já cobre o status 401/403 da rota real.

Referências:
- `scripts/interop/codex-app-server-readonly-probe.py`
- `scripts/interop/codex-app-server-readonly-probe.sh`
- `scripts/interop/inspector-authenticated-smoke.sh`
- `docs/testing/acceptance/phase16-codex-app-server-authenticated-readonly-2026-10-09.md`

## Evidência de execução (CI #37964924397)

Os logs do GitHub Actions mostram os resultados abaixo, emitidos após a execução de **processos reais independentes `@openai/codex@0.162.0`**:

- `CODEX_APP_SERVER_AUTHENTICATED_READONLY_TOOL_PASS` — leitura do dispositivo sintético autorizado.
- `CODEX_AUTH_BOUNDARY_NO_TOKEN_PASS` — o **próprio Codex** rejeitou inicialização MCP com `PHASE16_CODEX_BEARER` ausente; **não é evidência de HTTP 401 enviado ao Telechir**.
- `CODEX_AUTH_BOUNDARY_WRONG_AUDIENCE_PASS` — token RSA assinado com audience incorreta foi recusado durante handshake, com `Auth required`.
- `CODEX_AUTH_BOUNDARY_MALFORMED_PASS` — token malformado recusado no handshake, com `Auth required`.
- `CODEX_AUTH_BOUNDARY_WRITE_DENIED_PASS` — `write_file` com scope somente de leitura gerou `Insufficient scope`, sem retorno de ferramenta e sem escrita.
- `INDEPENDENT_AUTHENTICATED_INSPECTOR_SMOKE_PASS`, `GEMINI_CLI_AUTHENTICATED_MCP_DISCOVERY_PASS`, `CLAUDE_CODE_AUTHENTICATED_MCP_DISCOVERY_PASS` e `ISOLATED_PKCE_HTTPS_PROTOCOL_SMOKE_PASS` permaneceram aprovados.
- Job de regressões TypeScript, formato, segurança, Worker dry-run, audit e testes do control plane: `success`.

**Evidência:** [GitHub Actions run #37964924397](https://github.com/sylviohmartins/telechir/actions/runs/37964924397). A verificação final é feita no último head do PR antes do merge.

**Limite:** a ausência de credencial foi bloqueada no cliente; tokens inválidos foram recusados no handshake; a falta de escopo foi recusada na chamada de escrita. Isto não demonstra token revogado, login via IdP externo, refresh, consentimento nem escolha de ferramenta por LLM.
