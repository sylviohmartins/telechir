# Phase 16 — OpenCode V2: estado de conexão versus autorização MCP real

**Data:** 2026-10-10 (America/Sao_Paulo)
**Issue:** [#49](https://github.com/sylviohmartins/telechir/issues/49)
**Cliente oficial:** `@opencode/cli@2.0.24`, Keycloak 26.8.0, Workerd HTTPS e D1 locais descartáveis.

## Resultado — PASS de autorização do servidor; estado OpenCode não certificado como negativa

A [CI #38031715802](https://github.com/sylviohmartins/telechir/actions/runs/38031715802) concluiu **3/3 jobs success**. O cliente OpenCode V2 iniciou seu próprio OAuth Authorization Code/PKCE e reconectou ao MCP usando credenciais armazenadas pelo fornecedor, como já certificado no PR #79. O novo experimento acrescentou um verificador **independente do cliente**, usando a **mesma credencial de teste armazenada em SQLite** exclusivamente no CI; nenhum JWT foi gerado, substituído ou injetado no OpenCode.

Marcadores emitidos pelo job Keycloak:

- `OPENCODE_V2_STORED_OAUTH_SERVER_BASELINE_READ_PASS` — o endpoint `tools/list` protegido respondeu HTTP 200, devolvendo 24 ferramentas e `list_devices`, com usuário ativo.
- `OBSERVED: OPENCODE_V2_MCP_LIST_CONNECTED_AFTER_DISABLED_USER_NOT_CERTIFIED` — após atualizar `users.disabled_at` no D1, o comando oficial `opencode mcp list` **continuou mostrando `connected`**. **Não é PASS** de negativa de conexão.
- `OPENCODE_V2_STORED_OAUTH_SERVER_DISABLED_USER_DENIED_PASS` — a **mesma credencial OAuth sintética**, apresentada por um verificador independente ao endpoint de produção `tools/list`, recebeu **HTTP 401** enquanto a identidade estava desabilitada.
- `OPENCODE_V2_OFFICIAL_OAUTH_REENABLED_USER_MCP_CONNECTED_PASS` — após reabilitar a mesma identidade, o cliente oficial voltou a reportar `connected`.
- `OPENCODE_V2_STORED_OAUTH_SERVER_REENABLED_READ_PASS` — a leitura independente de `tools/list`, com o mesmo token ainda válido, voltou a receber **HTTP 200**.
- `KEYCLOAK_OPENCODE_V2_SERVER_SCOPE_REVOCATION_REFERENCE_PASS` — ciclo completo de autorização do servidor.

## Interpretação correta

- **Servidor Telechir:** a rota de produção exigiu que o usuário vinculado estivesse ativo para autorizar `tools/list`. A negativa de autorização foi reproduzida com HTTP 401, e o mesmo token voltou a autorizar depois da reabilitação. A capacidade de negar requisições autenticadas após `disabled_at` está comprovada neste ambiente.
- **OpenCode V2:** `mcp list` apresentou `connected` também enquanto uma operação MCP protegida seria negada. Logo, **não se pode usar o rótulo de conexão como evidência de permissão para ferramentas protegidas**. Pode refletir somente a inicialização/transporte do cliente; o teste não demonstra se uma chamada `tools/call` originada pelo OpenCode seria negada.
- **Não é revogação de token no IdP:** a reabilitação permite autorizar o mesmo access token não expirado; o estado do usuário é consultado na aplicação. O token não foi invalidado por `jti` ou revogação de sessão no Keycloak.
- **Sem inferência ou dispositivo físico:** não houve conta de modelo, seleção de ferramentas por LLM, write, Local Agent real, staging hospedada ou produção.

## Segurança do experimento

O OpenCode V2 armazena OAuth em uma tabela SQLite global `credential`, não no arquivo legado `mcp-auth.json`. Para evitar acesso a perfil pessoal ou ambiguidade de diretórios, a fixture de CI define `OPENCODE_DB` para um banco **somente do laboratório** dentro do HOME efêmero. Um processo Node separado abre esse banco **read-only** usando `node:sqlite` e obtém em memória apenas o token do cliente público sintético. Antes da requisição HTTPS de loopback, verifica `iss`, `aud`, `azp`, escopo e expiração para excluir falso 401 por JWT já vencido.

O verificador nunca imprime, envia para logs ou persiste fora do banco original o token. Não modifica o armazenamento OAuth, o controle de acesso de produção, a configuração de CAs do sistema ou as credenciais do computador do usuário. TLS de Keycloak/Workerd é validado com certificados efêmeros e pinning prévio. O Worker permaneceu saudável após a desabilitação.

## Código e próximos gates

- `apps/control-plane/test/fixtures/keycloak-opencode-v2-stored-token-server-probe.mjs`: prova independente `HTTP 200 → 401 → 200` na rota MCP de produção, com o mesmo token sintético guardado pelo OpenCode.
- `apps/control-plane/test/fixtures/keycloak-opencode-v2-oauth-revocation.mjs`: classifica o estado real do comando do fornecedor sem atribuir PASS falso ao estado `connected`.
- `apps/control-plane/test/fixtures/keycloak-opencode-v2-native-oauth.mjs` e `scripts/interop/keycloak-opencode-v2-native-oauth-smoke.sh`: banco SQLite efêmero explícito, sequência real Keycloak/OAuth/D1 e verificações TLS.
- `.github/workflows/mcp-interop.yml`: checagem de sintaxe dos novos arquivos.
- Próximos gates: executar uma ferramenta via runtime oficial OpenCode, sem inferir legitimidade do rótulo `connected`; repetir negativos de escopo/owner e sessão já aberta; investigar comportamento do cliente em nova versão; depois Gemini, E2E do Local Agent, staging e revisão de publicação.

**Fonte oficial complementar:** https://opencode.ai/v2/docs/mcp-servers
