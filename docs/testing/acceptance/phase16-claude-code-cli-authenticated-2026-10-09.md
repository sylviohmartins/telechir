# Phase 16 — conexão autenticada do Claude Code CLI real em HTTPS

**Data:** 2026-10-09

**Issue:** #49

**Cliente:** `@anthropic-ai/claude-code@2.1.295` (npm, versão fixada neste gate).

**Status:** `NOT_VERIFIED` até GitHub Actions completar os dois jobs.

## Escopo do ensaio

O gate usa a distribuição oficial do Claude Code CLI num runner Ubuntu temporário e executa `claude mcp list` contra o servidor HTTPS do Telechir. É um **processo cliente externo de verdade**, não o SDK MCP do próprio Telechir.

O comando consulta status de conexão, não realiza inferência de LLM, login, uso de conta Anthropic ou operação remota em dispositivo.

O probe é incorporado ao fluxo autenticado existente:

1. Reutiliza `wrangler dev` com o entrypoint de fixture **somente de teste**, `mcpHttpRoute` e `JwtAccessTokenVerifier` reais, D1 sintético, JWT RS256 de escopo read-only e TLS com fingerprint SHA-256 e cadeia validada.
2. Cria um `HOME` e `CLAUDE_CONFIG_DIR` independentes em `mktemp`, com permissões privadas; escreve a entrada MCP **de escopo exclusivo do usuário sintético desse processo** em `.claude.json` temporário, sem modificar perfis do runner nem credenciais pessoais.
3. Executa o `claude mcp list` do pacote publicado `@anthropic-ai/claude-code@2.1.295` com limite de tempo, guardando stdout e stderr apenas no diretório descartável.
4. Considera PASS somente a saída da **própria CLI** com alias `telechir-fixture` e estado `Connected`. Um exit code zero ou mera presença no arquivo de configuração não comprova conexão.
5. Mantém os testes independentes de cliente Inspector real, Gemini CLI real, OAuth PKCE S256 sintético e a suíte de segurança do control plane.

A limpeza do `trap` original elimina config, JWT, chave TLS, logs e dados D1 temporários. Não alterar `NODE_TLS_REJECT_UNAUTHORIZED`, nem confiar indiscriminadamente no host Windows ou aceitar login externo.

## Fronteiras

Um PASS comprovará, no máximo, **conectividade autenticada e descoberta remota do Claude Code CLI real**, com identidade sintética e JWT RSA previamente emitido. Não comprova execução de ferramentas pelo modelo Claude, respostas a prompts, OAuth Authorization Code + PKCE executado pelo cliente, IdP externo ou publicação do Telechir em catálogos.

Se o Claude Code exigir login na Anthropic antes de executar um comando de gerenciamento, classificar honestamente como `BLOCKED` e não registrar falso PASS. Não introduzir conta ou segredo real para contornar o bloqueio.

Fontes oficiais:
- [Claude Code — Connect via MCP e `mcp list`](https://code.claude.com/docs/en/mcp).
- [Claude Code — `CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/settings).
- [Pacote npm oficial](https://www.npmjs.com/package/@anthropic-ai/claude-code).

**Evidência CI final:** pendente.
