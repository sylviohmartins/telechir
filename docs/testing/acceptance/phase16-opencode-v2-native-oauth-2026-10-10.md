# Phase 16 — OpenCode V2: OAuth nativo e reconexão MCP com Keycloak real

**Data de aferição:** 2026-10-10 (America/Sao_Paulo)
**Issue:** [#49](https://github.com/sylviohmartins/telechir/issues/49)
**Cliente:** OpenCode V2 `@opencode/cli@2.0.24`, pacote publicado e executável oficial no Linux CI.
**Escopo:** `PASS` limitado a OAuth do cliente e conexão MCP autenticada; sem inferência de modelo.

## Evidência verificada

O [GitHub Actions #38029687222](https://github.com/sylviohmartins/telechir/actions/runs/38029687222), no head `dc26c5f9a944512199d35ac796aee127d1b7e96a`, concluiu **3/3 jobs success** com Keycloak 26.8.0 oficial, Chrome Stable real, Workerd HTTPS e D1 local descartáveis. O job Keycloak registrou:

- `PASS: official OpenCode V2 initiates native Keycloak OAuth PKCE S256 and scoped loopback callback`
- `PASS: Chrome Keycloak consent and native OpenCode code exchange completed`
- `RESULT: KEYCLOAK_OPENCODE_V2_OFFICIAL_OAUTH_MCP_CONNECTED_PASS`
- `RESULT: KEYCLOAK_OPENCODE_V2_VENDOR_OAUTH_GATE_PASS`

O comando de fornecedor `opencode mcp auth telechir-opencode-v2-ci` gerou o próprio authorization URL de Keycloak `response_type=code`, `state`, `code_challenge_method=S256`, challenge codificado, audience/recurso correspondente a `https://127.0.0.1:8988/mcp`, escopo `telechir:devices:read` e callback de loopback `http://127.0.0.1:19876/mcp/oauth/callback`. O servidor de autorização usou cliente **público pré-registrado** `telechir-phase16-opencode-v2`, sem segredo OAuth, com S256 exigido no Keycloak.

O Chrome de CI apenas operou a interface real de login e consentimento, utilizando CA efêmera verificada e enviando o redirect ao **listener real do OpenCode**. O harness não efetua troca de authorization code nem gera/insere Bearer. A CLI concluiu `mcp auth` com exit 0 e um segundo `opencode mcp list`, em processo independente com o mesmo `HOME`/XDG privado, identificou o servidor como `connected`. Assim, o token foi persistido e reutilizado pelo próprio cliente, sem receber token pronto do teste.

## Segurança e reprodutibilidade

- `scripts/interop/fixtures/keycloak-phase16-realm.json`: cliente OpenCode exclusivo, redirect URI única, PKCE obrigatório. O scope de leitura opcional é associado após bootstrap via Admin REST sem substituir `profile`/`email` padrões.
- `apps/control-plane/test/fixtures/keycloak-opencode-v2-native-oauth.mjs`: configuração `mcp.servers` específica de V2, navegador isolado, verificação estrita de `state`/PKCE/redirect/resource, código de saída e status real. Perfis e saída com URLs/tokens ficam apenas na memória e diretório temporário sem upload.
- `scripts/interop/keycloak-opencode-v2-native-oauth-smoke.sh`: reabilita D1 sintético, reinicia Workerd local e verifica ambas as cadeias TLS. Não altera trust store global.
- `.github/workflows/mcp-interop.yml`: análise estática do harness e execução Keycloak real.
- Nenhum deploy, usuário real, LLM, conta OpenCode, credencial de modelo, política de aprovação, MCP tool ou Device Wire type foi adicionado/alterado.

## Limites que permanecem abertos

- `opencode mcp list` autentica/enumera conexões, mas **não demonstra** `tools/call:list_devices` executado pelo OpenCode ou selecionado por um modelo; nenhum write ou dispositivo físico.
- `users.disabled_at` com credencial OpenCode, sessão já aberta, timeout/refresh, token expirado/revogado ou usuário cruzado **não** foram certificados através deste cliente. Existem gates independentes Codex/Claude e testes de servidor, mas não se deve transplantar seus resultados ao OpenCode.
- O login foi em Keycloak local e Browser headless, não em conta de provedor hospedado nem staging pública.
- Phase 16/#49 continua aberta; a capacidade do Telechir em produção não foi estabelecida.

## Próximos passos

1. Testar negativas de escopo, owner e `disabled_at` por **nova conexão via cliente oficial OpenCode** reutilizando seu token de OAuth, com Worker saudável; procurar também API oficial de tool invocation sem LLM.
2. Fechar os gates pendentes de Gemini `/mcp auth`, GitHub Copilot e clientes secundários relevantes.
3. Homologação com agente/dispositivo físico, staging, controles de publicação e clearance comercial em gates separados.

**Referências oficiais:** https://opencode.ai/v2/docs/mcp-servers e https://opencode.ai/v2/docs/cli/commands/.
