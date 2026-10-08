# Phase 16 — Revalidação oficial de compatibilidade Multi-AI

**Data:** 2026-10-08 (America/Sao_Paulo)
**Issue:** #49
**Status:** discovery documentado; certificação de clientes reais pendente.

## Fronteira e objetivo

Telechir expõe Remote MCP via `/mcp`, no control plane com OAuth/resource server, e nunca transmite authority superior à policy local do device. O control plane usa `@modelcontextprotocol/server` 2.x e mantém `legacy: "stateless"`. O código e os testes, não a intenção do roadmap, definem interoperabilidade real. O SDK presente não prova que um produto de terceiro se conectou.

## Padrão MCP atual e compatibilidade retroativa

- Especificação oficial MCP 2026-07-28: requisições autocontidas, negociação por request e `server/discover`; versões anteriores (até 2025-11-25) usam `initialize` e sessão/headers legados conforme o transporte.
- A documentação oficial do TypeScript SDK separa claramente *modern* (2026-07-28) e *legacy* (2025-11-25 e anteriores). `createMcpHandler({ legacy: "stateless" })` é uma configuração intencional, mas deve ter prova de wire para cada versão.
- O servidor do Telechir exige bearer OAuth, verifica `Origin`/host, rejeita body >256 KiB, verifica scopes por tool e preserva a validação de ownership e policy local.
- **Mudança incompatível não autorizada:** não eliminar legacy para satisfazer um cliente; não abrir rota anônima; não adaptar schemas para permissões mais amplas.

Fontes primárias:
- https://modelcontextprotocol.io/specification/2026-07-28
- https://modelcontextprotocol.io/specification/2025-11-25
- https://modelcontextprotocol.io/specification/draft/changelog
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions
- https://ts.sdk.modelcontextprotocol.io/server

## Clientes pretendidos, conforme documentação primária

| Cliente/superfície | Capacidade descrita pelo fornecedor | Exigência de prova local | Referência |
|---|---|---|---|
| ChatGPT plugin público | Remote MCP HTTPS; OAuth e tools com annotations/security schemes; publicação/review próprios | Package instalado em conta autorizada, consentimento, descoberta, leitura e mutação governada | https://developers.openai.com/plugins/build/mcp-server |
| Codex CLI/IDE/plugin | Configuração MCP remota via `codex mcp add ... --url`; packaging remoto em `mcp.json` | Versão CLI, conexão autenticada e smoke real sem acionamento perigoso | https://developers.openai.com/learn/docs-mcp |
| Claude Code | Remote MCP HTTP + OAuth; `claude mcp add --transport http` | Versão CLI, autenticação e tool calling reais | https://code.claude.com/docs/en/mcp |
| Gemini CLI | Streamable HTTP via `httpUrl`, OAuth discovery e consentimentos por configuração | Versão CLI, login e uso real das tools | https://geminicli.com/docs/tools/mcp-server/ |
| GitHub Copilot IDE | Servidores MCP em IDE/Agent; variações por host e política organizacional | IDE/versão e política do host; teste real de tool discovery, call e approval | https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context |
| Cursor, Cline, Roo Code, OpenCode, Goose | Candidatos secundários; capacidades NÃO certificadas neste discovery | Pesquisa individual de host/versão antes de anunciar compatibilidade | Documentação oficial específica ainda necessária |

**Cuidado:** suporte a *um* transporte ou a configuração de um servidor MCP não equivale a suporte ao Telechir, nem a execução autorizada de suas tools. Um cliente pode descobrir 24 tools e não conseguir usar o fluxo OAuth, tolerar annotations, exibir imagem ou pedir aprovações.

## Critérios para classificar evidência

- `PASS`: execução bem-sucedida, com produto/CLI real identificado e logs de sessão redigidos, ou **PASS apenas de protocolo** se for um teste de SDK/wire;
- `FAIL`: reprodução com versionamento e evidência objetiva; registrar causa e correção;
- `BLOCKED`: depende de endpoint HTTPS, publisher/IdP/conta, instalação de cliente, consentimento ou recurso externo indisponível;
- `NOT_TESTED`: não executado; não representa bloqueio externo comprovado.

Cada resultado exige colunas separadas para `protocol_probe` e `real_client`. Testes de `@modelcontextprotocol/client` e wire JSON-RPC **não** comprovam a integração com ChatGPT/Claude/Gemini/Copilot.

## Fluxos obrigatórios em futura certificação real

1. Transport + discovery moderno/legado e catálogo de 24 tools determinístico, schemas, annotations, OAuth security schemes.
2. 401 com `WWW-Authenticate` e protected-resource metadata; 403 para insufficient scope; credentials/tokens revogados e user/device/workspace de terceiros negados.
3. List/read sem side effects, write/patch/process com risk floor local, approval Telechir session/digest/TTL e sem efeito quando negado; computer input exige confirmação local CRITICAL; navegador é BROWSER isolado.
4. Dois clientes concorrentes no mesmo workspace: AB-028 (lease CONFLICT, fencing crescente), AB-029 (reconnect sem replay aceito); reads e outros workspaces continuam independentes.
5. Untrusted terminal/file/browser/screen content; captura não aparece no audit; sem raw text de input ou secrets; limites de payload/sessão/timeout/rate limit.
6. Ferramenta inexistente, inputs inválidos, scope elevado solicitado pelo modelo, revogação, desconexão e cleanup; nenhuma redução silenciosa de security.

## Restrições operacionais na data do discovery

No computador PREDATORH300, `node`, `npm` e Docker foram encontrados; `codex`, `claude`, `gemini`, `gh` e `cargo` não apareceram como comandos instalados no PATH da sessão consultada. Isso **não** prova indisponibilidade no produto ou na conta, apenas falta de CLI pronta no ambiente avaliado. Revalidar em cada ciclo.

O repo não possui endpoint HTTPS/IdP de produção comprovado, e o checkpoint preserva 11 gates de publicação OpenAI externos. Não criar produção, domínio ou credenciais apenas para converter um `BLOCKED` em `PASS`.

## Decisão desta etapa

Criar uma fundação de testes modernos/legados e regressões de autoridade/transport, manter Phase 16 **em andamento** e preservar a issue até certificações reais e aceitação completa. Arquivos históricos permanecem imutáveis.
