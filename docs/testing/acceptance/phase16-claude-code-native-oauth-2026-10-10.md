# Phase 16 — Claude Code: OAuth nativo contra Keycloak real

**Data:** 2026-10-10 (America/Sao_Paulo)
**Issue:** [#49](https://github.com/sylviohmartins/telechir/issues/49)
**Cliente:** `@anthropic-ai/claude-code@2.1.295` oficial, Ubuntu GitHub Actions efêmero.
**Transporte:** Streamable HTTP sobre HTTPS loopback / Workerd/D1 reais, identidade sintética.

## Resultado e evidência

**PASS delimitado — OAuth autenticação iniciada pelo cliente oficial e reconexão MCP autenticada.**

Na [CI #38023908095](https://github.com/sylviohmartins/telechir/actions/runs/38023908095), head `24982800651f5da5e749b16009a6b979f7a1eb6c`, os **3/3 jobs** concluíram `success`. O job Keycloak registrou:

- `PASS: official Claude Code 2.1.295 initiates read-only Keycloak OAuth with own S256 PKCE, state and fixed loopback callback`
- `PASS: Chrome/Keycloak consent returned Claude-owned code, state and callback`
- `PASS: Claude Code completed vendor-owned OAuth login`
- `RESULT: KEYCLOAK_CLAUDE_CODE_OFFICIAL_OAUTH_MCP_CONNECTED_PASS`
- `RESULT: KEYCLOAK_CLAUDE_OFFICIAL_OAUTH_CLI_GATE_PASS`

O comando oficial `claude mcp login telechir-claude-ci --no-browser` foi executado em PTY independente. Ele próprio iniciou a autorização `response_type=code` para o `client_id=telechir-phase16-claude`, com PKCE S256, `state`, escopo contendo `telechir:devices:read`, `resource` idêntico ao MCP e redirect `http://localhost:18888/callback`.

Um Chrome real, com CA temporária do Keycloak importada em seu armazenamento NSS isolado e verificação TLS obrigatória, apenas operou login e consentimento na interface oficial do Keycloak; capturou o callback no endereço esperado e o entregou ao próprio Claude pelo modo documentado `--no-browser`. O harness **não** trocou o código por token, não gerou JWT, não construiu header Bearer e não injetou credenciais.

Após o processo confirmar sucesso do login, **um segundo processo `claude mcp list`**, com o mesmo `HOME` efêmero e nenhuma autorização injetada, encerrou com código 0 e reportou `telechir-claude-ci Connected` usando armazenamento de credenciais do próprio cliente.

## Reprodutibilidade e segurança

Arquivos:

- `scripts/interop/fixtures/keycloak-phase16-realm.json` — cliente **público** Claude com callback restrito e PKCE obrigatório, isolado dos clientes Codex/Inspector/Gemini.
- `scripts/interop/keycloak-real-idp-contract.sh` — atribuição opcional do scope read-only via Keycloak Admin REST depois de inicializar o realm (preserva os scopes padrão do IdP).
- `scripts/interop/keycloak-claude-code-native-oauth-smoke.sh` — restabelece o usuário sintético em D1, valida CA/leaf de Keycloak e Worker, chama o cliente.
- `apps/control-plane/test/fixtures/keycloak-claude-code-native-oauth.mjs` — valida a URL antes de expor login, faz consentimento real e examina a reconexão do Claude sem tokens preparados.
- `.github/workflows/mcp-interop.yml` — checagem de sintaxe e CI de integração.

Todas as credenciais de Keycloak são sintéticas, o `HOME` é descartável e o runner remove os dados ao terminar. Proibidos `NODE_TLS_REJECT_UNAUTHORIZED=0`, `ignoreHTTPSErrors`, uso de conta Anthropic real, inferência e qualquer deploy. Não houve alteração das 24 ferramentas MCP, de Device Wire ou do mecanismo final de autorização do agente local.

## Limites precisos — NÃO certificados

- Não foi demonstrado `tools/call:list_devices` iniciado **pelo próprio Claude Code** com o token do fluxo OAuth, nem recusa pós-`disabled_at` através dele.
- Não foram testados tool-use de LLM, seleção de ferramentas, prompts, permissões da interface do Claude Code, IDE, sessão com conta Anthropic, endpoint público, IdP gerenciado ou dispositivo físico.
- `Connected` no processo oficial comprova conexão autenticada MCP com credencial própria, mas **não** equivale a ferramenta realmente executada.
- Os testes antigos com Bearer injetado permanecem distinguíveis deste login.

## Próximos gates

1. Exercitar tool call real `list_devices` via runtime do Claude Code após login, sem depender de modelo pago/conta pessoal e sem capturar/injetar bearer. Se não houver API de chamadas RPC de ferramenta sem inferência, registrar `BLOCKED/NOT_TESTED` em vez de simular.
2. Revalidar isolamento por owner, scope negativo, usuário desabilitado, token expirado e reconnect na integração **do cliente**, com o ambiente real de IdP e Worker.
3. Estabelecer E2E com Local Agent/Device real e staging autorizada separadamente; não marcar Phase 16 COMPLETE apenas por esta CI.

**Referência oficial:** https://code.claude.com/docs/en/mcp — `claude mcp login --no-browser`, `--client-id`, `--callback-port`, `oauth.scopes`.