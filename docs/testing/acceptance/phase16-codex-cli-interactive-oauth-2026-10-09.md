# Phase 16 — Codex CLI oficial inicia OAuth interativo e executa MCP

**Data:** 2026-10-09
**Issue:** #49
**Estado:** `PENDING_CI` até o head final completar 3/3 jobs e os três marcadores do Codex.

## Objetivo e limites

Este gate avança além do Inspector oficial do PR #71. Usa o **Codex CLI real publicado no npm**, versão `@openai/codex@0.162.0`, sem conta ChatGPT, OpenAI API key nem inferência. O comando `codex mcp login telechir_ci --no-browser --scopes telechir:devices:read` **deve iniciar a própria autorização OAuth**, gerar `state` e PKCE S256, aceitar o callback completo do navegador em stdin (modo headless oficial), verificar `state`, trocar o code com o próprio verificador e armazenar credenciais por servidor em `CODEX_HOME` efêmero. **O harness NÃO gera code/verifier nem injeta bearer token.**

Depois, o **app-server oficial do Codex**, processo diferente, deve ler as credenciais OAuth daquele mesmo `CODEX_HOME`, criar thread efêmera e chamar `mcpServer/tool/call` com `list_devices`, obtendo exclusivamente o dispositivo do sujeito Keycloak. O gate só aceita um resultado real do app-server. Após `disabled_at` ser definido no D1 local real, um **novo app-server com o mesmo token OAuth armazenado** deve falhar em autorização mesmo antes de expirar o JWT.

## Configuração de homologação

- IdP real Keycloak 26.8.0 em contêiner GitHub Actions descartável, realm e conta humana sintéticos; cliente público `telechir-phase16-codex`, padrão, PKCE obrigatório `S256`, consentimento obrigatório, sem implicit/password grants.
- Callback loopback específico do laboratório `http://127.0.0.1:1455/callback/*` (permitido somente nesse cliente CI). No `--no-browser`, o browser Chrome headless efetua login/consentimento reais e retorna URL de callback à entrada padrão do Codex, sem executar a troca de token.
- `telechir:devices:read` é o **único escopo solicitado** pelo Codex. A autorização é associada ao cliente Codex pela API Admin REST **após** criar o realm, preservando os escopos OIDC padrão e os gates anteriores. A audiência do access token continua sendo `https://127.0.0.1:8988/mcp`.
- Leaf + CA de Keycloak e Worker verificadas por preflight antes de qualquer credencial. Chrome confia só na CA do Keycloak via NSS temporário; Codex recebe bundle efêmero dessas duas CAs por env do seu subprocesso. Nunca `NODE_TLS_REJECT_UNAUTHORIZED=0`, `ignoreHTTPSErrors=true`, `--insecure` nem modificação do trust store do host.
- Codex home privado/0700; `config.toml` protegido/0600; stdout e stderr do CLI em memória e logs do app-server gravados só em arquivos temporários apagados no trap. Não imprimir URLs de autorização/callback, JWTs, cookies, headers, senhas nem corpo de erro arbitrário.
- `CODEX_HOME` separado de profiles pessoais, APIs externas de modelos e dados físicos, sem deploy de Worker hospedado.
- Verificação final: `KEYCLOAK_CODEX_OFFICIAL_PKCE_LOGIN_PASS`, `KEYCLOAK_CODEX_OAUTH_APP_SERVER_DEVICE_READ_PASS`, `KEYCLOAK_CODEX_OAUTH_APP_SERVER_DISABLED_USER_PASS`, `KEYCLOAK_CODEX_OFFICIAL_OAUTH_MCP_D1_PASS`.

**Limitação importante:** prova **Codex CLI e app-server reais** com credencial de IdP local; não prova interação do modelo em inferência, usuário real, UX da extensão IDE, ChatGPT plugin, Cloudflare hospedado ou clientes Claude/Gemini/Copilot.

## Artefatos

- `apps/control-plane/test/fixtures/keycloak-codex-cli-interactive-oauth.mjs` — dirige somente login/consentimento no navegador, repassa callback ao Codex.
- `scripts/interop/codex-app-server-oauth-readonly.py` — chamada `list_devices` via app-server usando credencial persistida pelo Codex, negativa após desativação.
- `scripts/interop/keycloak-codex-cli-interactive-oauth-smoke.sh` — Workerd, D1, TLS, OAuth e negativa.
- `scripts/interop/keycloak-real-idp-contract.sh`, `scripts/interop/fixtures/keycloak-phase16-realm.json` e `.github/workflows/mcp-interop.yml`.

Referências técnicas oficiais: [Codex CLI MCP source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs), [Codex MCP](https://developers.openai.com/codex/mcp), [OAuth MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
