# Phase 16 — Codex CLI oficial: chamada MCP autenticada de leitura

**Data:** 2026-10-09

**Issue:** #49

**Cliente:** `@openai/codex@0.162.0` — binário oficial, executado via `npx` no runner GitHub Actions Ubuntu.

**Status:** `NOT_VERIFIED` até verificação de CI.

## Por que não usar apenas `codex mcp list`

Os comandos `codex mcp list/get` demonstram configuração e podem declarar servidores enabled sem realizar autenticação ou descoberta MCP válida na sessão. Por isso, o gate utiliza a **API nativa do Codex App Server**, baseada na própria suíte oficial de conformidade MCP do Codex, em que é possível despachar `mcpServer/tool/call` diretamente, sem autenticar numa conta OpenAI nem executar inferência com modelo.

O arquivo `scripts/interop/codex-app-server-readonly-probe.py` utiliza somente bibliotecas da distribuição Python 3 do runner para comunicar por JSON Lines com um **processo `codex app-server` real** e fixado na versão escolhida. O shell wrapper `scripts/interop/codex-app-server-readonly-probe.sh` é chamado ao final do smoke HTTPS autenticado quando `PHASE16_REAL_CODEX_APP_SERVER=1`.

## Procedimento verificável

1. Reutilizar a infraestrutura já certificada: `wrangler dev` na porta de loopback `8988`, certificado HTTPS de curta duração, `verify-local-tls.mjs` (pinning e cadeia), worker de fixture com a rota MCP e JWT verifier reais, JWKS públicas sintéticas e D1 local com usuário/dispositivo de teste.
2. Criar `CODEX_HOME` e `HOME` exclusivos dentro de `mktemp`, sem tocar no perfil real. `config.toml` privado contém somente a URL e **nome da variável** que guarda o Bearer (`bearer_token_env_var`). O JWT assinado nunca é inserido em argv nem gravado no arquivo de configuração do Codex.
3. Excluir do subprocesso quaisquer variáveis `OPENAI_API_KEY`, `CODEX_API_KEY` e `CODEX_ACCESS_TOKEN`, configurar `SSL_CERT_FILE` e `NODE_EXTRA_CA_CERTS` para a autoridade TLS do fixture e restringir o acesso ao loopback. Manter o handshake TLS validado; **não usar `insecure` ou desabilitar verificação**.
4. Iniciar o App Server com JSON-RPC `initialize` e `initialized`; criar `thread/start` efêmera e despachar `mcpServer/tool/call`, passando `server=telechir_fixture`, `tool=list_devices`, `arguments={status:all}`.
5. Exigir na resposta **`structuredContent.devices` com exatamente um dispositivo**, cujo `device_id` coincida com o valor aleatório semeado no banco isolado. Fail-closed em timeouts, JSON malformado, exceção, erro de autorização ou discrepância de dados. O processo Codex é encerrado ao final.
6. O script **não imprime logs brutos do subprocesso**: token, JWT, stderr e notificações não são expostos nos logs GitHub Actions. A limpeza do `trap` externo remove todo estado efêmero.

## Escopo de certificação

Um PASS comprovará o caminho completo **Codex App Server CLI real → TLS MCP → JWT RS256 verificado pelo Telechir → ferramenta `list_devices` executada na rota real → dispositivo correto retornado**, sem modelo OpenAI. Isso é mais rigoroso do que `codex mcp list`, mas **não comprova escolha/invocação da ferramenta por um agente LLM**, autenticação de usuário ChatGPT, IdP externo, OAuth PKCE conduzido pelo Codex, ferramentas de escrita, GitHub Copilot ou plataforma hospedada.

Nenhuma mudança no runtime de produção ou implantação; apenas scripts de integração e documentação. Manter `PHASE_16_IN_PROGRESS`.

## Referências oficiais

- [Codex CLI e MCP — documentação oficial](https://developers.openai.com/codex/mcp/).
- [Codex — suíte oficial de conformidade do App Server e chamadas MCP diretas](https://github.com/openai/codex/blob/main/scripts/mcp_conformance/run_codex_compliance.py).
- [Codex — testes de `mcpServer/tool/call`](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/mcp_tool.rs).

**Resultado CI:** pendente de comprovação no PR.
