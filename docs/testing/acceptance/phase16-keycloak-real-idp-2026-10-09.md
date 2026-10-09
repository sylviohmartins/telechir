# Phase 16 — provedor OAuth real Keycloak no CI isolado

**Data:** 2026-10-09
**Issue:** [#49](https://github.com/sylviohmartins/telechir/issues/49)
**Versão fixada:** Keycloak `26.8.0` (imagem oficial `quay.io/keycloak/keycloak:26.8.0`).
**Estado:** `PASS` limitado para a validação do JWT com IdP real, confirmado no [CI #37971040190](https://github.com/sylviohmartins/telechir/actions/runs/37971040190), job Keycloak `success`. A integração em `main` exige confirmação de **3/3 jobs `success`** no último commit do PR, além desta evidência funcional.

## Objetivo

Adicionar prova que utiliza um **software de IdP de terceiros, real e independente**, em vez de gerar JWT e metadata no próprio harness do Telechir. O Keycloak inicia como container descartável num runner Linux GitHub Actions, publica endpoints OAuth RFC 8414 e JWKS em HTTPS, mantém seu **próprio par de chaves de assinatura** e emite OAuth 2.0 `client_credentials` com JWT RS256 e audience `https://127.0.0.1:8988/mcp`.

O verificador usado para aceitar/rejeitar o token é o **`JwtAccessTokenVerifier` de produção** (compilado de `apps/control-plane/src/oauth.ts` com esbuild, sem modificar sua implementação). O token assinado pelo Keycloak é validado pelo mesmo caminho de discovery RFC 8414 e JWKS reais consumidos de `https://127.0.0.1:8844`. **A consulta D1 é substituída por um adaptador em memória com a cláusula SQL `disabled_at IS NULL` exigida**. Isto exercita a verificação de JWT e o vínculo `sub`/identidade, mas **não** a rota MCP/Worker e o armazenamento D1 reais no mesmo teste. Esses possuem gates isolados anteriores com emissor sintético.

## Segurança do ambiente

- Container Keycloak oficial sem login real, isolado na porta de loopback `127.0.0.1:8844`, limitado a 1536 MiB e removido por `trap`; `start-dev` exclusivamente no CI, não recomendado para produção.
- CA efêmera distinta de certificado final (`CA:FALSE`, `serverAuth`, SAN localhost/IP). A cadeia de confiança é validada por curl e Node e o certificado final é pinado por SHA-256 antes de transmitir os segredos sintéticos. **Nenhuma opção `--insecure` ou `NODE_TLS_REJECT_UNAUTHORIZED=0`**.
- Realm, clients confidenciais, client secrets e chaves TLS gerados por execução em diretório temporário; nada compartilhado em Git, logs ou contas pessoais. Sem usuário ou senha administrativa do Keycloak.
- Apenas o diretório de import e o certificado/leaf-key sintéticos são legíveis para o container, em volumes `ro`. Os JWTs ficam somente na memória do cliente/verificador.

## Critérios de aceitação

1. Keycloak oferece RFC 8414 `/.well-known/oauth-authorization-server/realms/telechir-phase16` com issuer, authorization endpoint, token endpoint HTTPS, `code_challenge_methods_supported` contendo `S256`, e JWKS pública RSA.
2. O token é obtido pela concessão OAuth 2.0 `client_credentials`, via endpoint real do Keycloak, com `iss`, `sub`, `aud` do Telechir, `exp`, assinatura RS256 e `scope=telechir:devices:read`.
3. O verificador real do Telechir obtém a metadata e JWKS pela rede e aceita esse token para o principal sintético vinculado (adapter D1 sem real I/O).
4. Rejeita um **segundo JWT genuíno do Keycloak** com audiência diferente, um JWT com assinatura modificada e o JWT original quando o principal vinculado é marcado `disabled` no adapter.
5. A documentação não deve confundir `client_credentials` com **Authorization Code + PKCE S256 interativo**, que permanece avaliado somente com o emissor sintético; nem com conexão Keycloak→Worker/D1→Codex completa.

## Evidências planejadas

- `scripts/interop/keycloak-real-idp-smoke.sh`
- `apps/control-plane/test/fixtures/create-keycloak-realm.mjs`
- `apps/control-plane/test/fixtures/keycloak-real-idp-verify.mjs`
- Job `keycloak-real-idp` em `.github/workflows/mcp-interop.yml`

**Fronteiras:** não certifica operação em produção, login humano, browser consent, refresh, configuração dinâmica do IdP externo no Worker, seleção de tool por LLM, credenciais de terceiros, token individual revogado via `jti` ou autorização granular de dispositivos. Uma integração Keycloak direta com o MCP HTTPS/Worker permanece trabalho posterior, caso a política de transporte de TLS local do Wrangler permita fazê-la sem relaxamento de segurança.

## Evidência observada no CI

O GitHub Actions [#37971040190](https://github.com/sylviohmartins/telechir/actions/runs/37971040190) executou o **Keycloak 26.8.0 real** e registrou:

- `PASS: Keycloak 26.8.0 HTTPS, pinned TLS leaf and CA chain`;
- `PASS: actual Keycloak RFC8414 discovery, HTTPS endpoints and public JWKS`;
- `PASS: actual Keycloak client_credentials grant issued signed resource-bound read JWT`;
- `PASS: Telechir PRODUCTION JwtAccessTokenVerifier validates real Keycloak JWT and linked subject`;
- rejeição de JWT Keycloak com audiência errada, assinatura modificada e identidade sintética marcada `disabled`;
- `RESULT: REAL_KEYCLOAK_IDP_PRODUCTION_JWT_VERIFIER_PASS`.

O job de interoperabilidade Inspector/Gemini/Claude/Codex também passou no primeiro CI. O job de regressões falhou **somente por formatação** nos dois arquivos JavaScript recém-criados; a correção foi aplicada usando o Prettier do projeto. A prova completa fica condicionada ao último commit com os três jobs `success`.
