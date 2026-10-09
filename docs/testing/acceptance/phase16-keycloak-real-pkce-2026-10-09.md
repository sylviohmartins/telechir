# Phase 16 — Authorization Code + PKCE S256 com Keycloak real

**Data:** 2026-10-09
**Issue:** #49
**Status:** **PASS delimitado** — [CI #37984488017](https://github.com/sylviohmartins/telechir/actions/runs/37984488017), 3/3 jobs `success` no commit `2efee83`. Marcadores `KEYCLOAK_REAL_AUTHORIZATION_CODE_PKCE_S256_PASS` e `KEYCLOAK_REAL_PKCE_MCP_D1_HUMAN_USER_PASS`. Validar novamente o último head documental antes do merge.

## Objetivo e novidade

Além do JWT de `client_credentials` já aprovado, autenticar **uma identidade de usuário sintético real no Keycloak 26.8.0** via uma página de login servida pelo IdP por HTTPS, concedendo `authorization_code` a um **cliente público diferente**, com `pkce.code.challenge.method=S256`, `standardFlowEnabled=true`, `directAccessGrantsEnabled=false`, `implicitFlowEnabled=false` e callback loopback estrito `http://127.0.0.1:8798/callback`.

O navegador **não** é controlado neste gate: a fixture Node acompanha redirecionamentos no **mesmo issuer TLS fixado**, envia formulário HTTPS real com credenciais inúteis fora do contêiner e captura a resposta de callback antes de segui-la. É um teste do protocolo OAuth/HTML real, **não** uma prova de login gráfico, aprovação humana, MFA ou consentimento; `consentRequired=false` no laboratório. O `state` é gerado e validado pelo cliente; **Keycloak não é responsável pela proteção do cliente contra CSRF via `state`**.

## Critérios

1. Obter e validar a metadata OIDC/JWKS do Keycloak já verificada pela CA específica; verificar `authorization_endpoint`, `token_endpoint`, S256.
2. Rejeitar pedido de autorização sem `code_challenge` ou com método `plain` (nenhum authorization code pode ser emitido).
3. Completar login HTML do usuário sintético `phase16-user-ci` sem expor credenciais/codes/tokens em stdout ou artefatos de CI.
4. Rejeitar troca de código com `code_verifier` errado e com `redirect_uri` divergente.
5. Recusar `state` substituído **no cliente** antes do token endpoint.
6. Trocar código válido com `code_verifier` S256 e confirmar `access_token` assinado por JWKS do Keycloak, `iss` exato, `aud=https://127.0.0.1:8988/mcp`, `azp=telechir-phase16-pkce`, `preferred_username` e escopo limitado `telechir:devices:read`. A identidade `sub` de usuário deve ser diferente da identidade service-account do gate anterior. Não confundir `resource` OAuth solicitado com suporte dinâmico do Keycloak: a audiência é atribuída por mapper explícito do cliente.
7. Repetição do código **após troca válida** → `invalid_grant`.
8. Vincular `sub` humano por hash SHA-256 ao **D1 verdadeiro** migrado, isolar device de outro proprietário, executar `tools/list` e `tools/call:list_devices` pela rota MCP de produção/Workerd TLS direto, negar assinatura adulterada e sem Bearer (401), `write_file` sem escopo (403), depois negar mesmo JWT quando `disabled_at` é definido no D1 (401).

## Aprendizados verificados no CI

A execução inicial do gate detectou retorno ao formulário HTML após o POST. O primeiro ensaio com usuário embutido no JSON de `RealmRepresentation` não concluiu a autenticação; a criação do usuário foi substituída por **POST autenticado oficial** em `/admin/realms/telechir-phase16/users` (**HTTP 201**). A página continuou reaparecendo até que o usuário de fixture recebesse um e-mail sintético verificado e perfil completo — evitando uma etapa adicional de perfil durante o login. A fixture preserva um diagnóstico restrito a **indicadores estruturais** de HTML, sem gravar HTML, cookies, senha, token ou authorization code.

**Evidência real**: o Keycloak recusou downgrade S256, verifier errado e redirect divergente, emitiu JWT de `sub` humano com audience `/mcp`, recusou replay do code e, no Workerd com HTTPS/JWKS verdadeiros e D1 local, respondeu ao `list_devices` isolado e negou escrita sem escopo e usuário desativado. O retorno com `state` adulterado foi recusado pelo cliente de teste antes da troca do código. A prova não é execução em navegador GUI e consentimento segue desabilitado exclusivamente no laboratório.

## Segurança / não objetivos

- Tudo sob GitHub Actions Linux, Keycloak oficial e Worker/D1 locais descartáveis; trust `NODE_EXTRA_CA_CERTS` efêmero e cert fingerprint pin do IdP e do Worker, sem bypass global TLS, sem credenciais externas.
- Formulário HTTP conduzido por cliente de teste, não navegador real. Sem consentimento Keycloak (desabilitado somente no laboratório), login humano externo, MFA, refresh/revogação por `jti`, servidor gerenciado, Cloudflare hospedada, dispositivo físico ou ferramenta chamada por inferência LLM.
- Credenciais do fixture são públicas por definição e não devem ser reutilizadas em outro ambiente. Tokens e SQL sintéticos persistem **somente no diretório temporário privado** e o trap remove todos.
- Nenhuma mudança no código de produção ou no local agent authority. **Issue #49 permanece aberta** após o gate.

## Componentes

- `scripts/interop/fixtures/keycloak-phase16-realm.json` — test realm com cliente público PKCE S256.
- `scripts/interop/fixtures/keycloak-phase16-user.json` — usuário humano descartável criado na API administrativa oficial, com e-mail sintético e perfil completo.
- `apps/control-plane/test/fixtures/keycloak-real-pkce-login.mjs` — login real via HTTPS, PKCE, code/state, assinatura e SQL temporário.
- `scripts/interop/keycloak-real-pkce-mcp-smoke.sh` — D1/Worker real, segregação e negativas.
- `scripts/interop/keycloak-real-idp-contract.sh` — orquestrador Keycloak/PKCE sem processo extra persistente.
- `scripts/interop/keycloak-workerd-direct-tls-smoke.sh` — trust nativo do Workerd já comprovado.
- `apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs` — contrato MCP autenticado, sem alterações.

Fonte de referência: [Keycloak — Server Administration Guide, clientes OIDC e PKCE S256](https://www.keycloak.org/docs/latest/server_admin/), [Keycloak — Javascript Adapter](https://www.keycloak.org/securing-apps/javascript-adapter). Evidência CI a inserir somente depois de verificação do head final.
