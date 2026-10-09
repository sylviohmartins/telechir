# Phase 16 — Inspector oficial inicia OAuth interativo e retorna ao MCP

**Data:** 2026-10-09
**Issue:** #49
**Estado do gate:** **PASS delimitado** — [CI #37992688505](https://github.com/sylviohmartins/telechir/actions/runs/37992688505), 3/3 jobs success no commit `b9b24b7`. Marcadores `KEYCLOAK_REAL_INSPECTOR_INTERACTIVE_OAUTH_MCP_PASS` e `KEYCLOAK_INSPECTOR_EXTERNAL_OAUTH_CLIENT_PASS`. Revalidar no último head após atualização documental.

## Objetivo e separação de evidências

Os PRs #69 e #70 validaram Authorization Code + PKCE S256, Keycloak real e Google Chrome headless. **Neles, o próprio harness gerava o par PKCE, construía a URL e trocava o code.** Este incremento pretende testar um **cliente MCP independente publicado pelo projeto Model Context Protocol**: `@modelcontextprotocol/inspector@2.5.0 --cli`.

O Inspector deve **realizar por conta própria** discovery OAuth via challenge `WWW-Authenticate` e protected-resource metadata, iniciar o code flow PKCE S256, escutar seu callback oficial `http://127.0.0.1:6276/oauth/callback`, trocar o code por token e retomar a solicitação de ferramenta `list_devices`. O driver Playwright serve **exclusivamente** para preencher o formulário e consentimento real no Keycloak 26.8.0, sem construir challenge, assinar token, trocar código ou inserir `Authorization` no cliente.

## Condições exigidas

- Cliente público Keycloak **exclusivo** `telechir-phase16-inspector` com fluxo padrão, `PKCE S256`, callback loopback estático e `consentRequired=true`, separado dos outros clientes OAuth de laboratório.
- D1 local real: reutilizar o mesmo `sub`/owner/dispositivo previamente validado no PR #70, sem violar `UNIQUE(identity_provider,provider_subject_hash)`.
- Worker HTTPS real de `mcpHttpRoute`/`JwtAccessTokenVerifier`, com `fetch()` nativo de metadata RFC 8414/JWKS do Keycloak. A CA do Worker e a do Keycloak devem passar por **preflight de fingerprint leaf e cadeia**, e Node Inspector só recebe um bundle dessas duas CAs efêmeras; browser Chrome recebe **somente CA do Keycloak** via NSS privado.
- O Inspector recebe um arquivo de configuração **privado e somente de leitura** (`--config`) que limita `oauth.scopes` a `telechir:devices:read` e desativa a solicitação opcional de refresh token. O Keycloak registra esse único escopo como **optional client scope** permitido ao cliente `telechir-phase16-inspector`, **após o bootstrap do realm pela API administrativa oficial**, para preservar os escopos OIDC padrão (`profile`/`email`) e a claim `preferred_username` exigida nos gates anteriores. Assim não se confunde toda a lista de 14 escopos anunciados pelo servidor com a concessão solicitada por um cliente apenas de leitura. Nenhum escopo de escrita é registrado ou concedido a este cliente.
- A CLI não deve receber `--header Authorization`, `--stored-auth-only` ou um JWT de fixture. O próprio `inspector` inicia o OAuth. `MCP_AUTO_OPEN_ENABLED=true` autoriza esse OAuth em runner sem TTY; a URL de autorização é mantida somente em memória no driver de navegador, **não impressa**.
- Verificar que o navegador só abriu uma URL `authorization_endpoint` do emissor pinado com `client_id`, callback, `state` e `code_challenge_method=S256`, e concluiu login/consentimento na interface oficial.
- Verificar **resultado emitido pelo processo real do Inspector**, `tools/call:list_devices` com `structuredContent.devices` contendo **exatamente o device do usuário** e não o device estrangeiro. Um resultado do harness direto ou token preinjetado **não satisfaz** esse gate.
- Runtime CI descartável, limite de 150s, armazenamento OAuth específico do job em diretório privado, nenhuma alteração em perfis reais, logs filtrados sem código, token, senha, cookie ou URL de autorização.

## Evidência realizada e regressões corrigidas

O primeiro CI confirmou que o próprio Inspector CLI publicou uma URL de autorização PKCE S256 com `client_id`, `state`, `redirect_uri` correto e listener loopback, mas o Keycloak redirecionou diretamente ao callback sem login. O motivo era a solicitação automática de escopos mais ampla que o permitido ao cliente de leitura. A configuração privada do Inspector passou a solicitar somente `telechir:devices:read`.

Uma primeira tentativa de registrar o escopo no JSON do realm alterou indevidamente os **escopos OIDC padrão**, removendo `preferred_username` dos tokens emitidos para o cliente PKCE preexistente. O CI bloqueou corretamente o incremento. Foi corrigido para usar **POST de `client-scopes` e PUT de `optional-client-scopes` na API Admin REST oficial do Keycloak 26.8.0 após bootstrap**, preservando `profile`/claims anteriores. Não há mudança no Worker de produção.

**Prova no CI #37992688505:** todos os três jobs concluíram `success`; o gate Keycloak registrou a criação/atribuição do escopo de leitura pela API Admin REST, **os gates prévios de PKCE e navegador continuaram aprovados**, o Inspector iniciou seu fluxo OAuth por conta própria, o Chrome fez login e consentimento no IdP, o Inspector recebeu o callback e devolveu o resultado autêntico de `tools/call:list_devices` com somente o device associado ao mesmo usuário no D1. O JWT não foi injetado pelo driver. A fixture cancela temporizadores de proteção assim que cada etapa termina para evitar retenção desnecessária do processo no CI. Este é `PASS` **apenas do Inspector 2.5.0 e ambiente local CI**, não de hosts proprietários.

## Limites da certificação

Um Inspector CLI oficial independente não é o mesmo que autenticação interativa por ChatGPT, Codex, Claude, Gemini, Copilot, Cursor ou outro cliente proprietário. Ainda não constitui uso por modelo em inferência, usuário/conta real, ambiente de produção nem execução em provedor IdP gerenciado. Não é aceite para `PHASE_16_COMPLETE`.

## Artefatos

- `scripts/interop/fixtures/keycloak-phase16-realm.json` — novo cliente real-Inspector CI.
- `apps/control-plane/test/fixtures/keycloak-inspector-interactive-oauth.mjs` — driver DOM apenas; Inspector gera/consome OAuth.
- `scripts/interop/keycloak-inspector-interactive-oauth-smoke.sh` — Workerd, D1 e certificados.
- `scripts/interop/keycloak-real-idp-contract.sh` e `.github/workflows/mcp-interop.yml` — CI.

Documentação oficial: [MCP Inspector CLI — OAuth](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md#cli-specific-oauth-for-http-servers), [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).