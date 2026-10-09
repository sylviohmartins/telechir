# Phase 16 — contrato de tokens com Keycloak real

**Data:** 2026-10-09
**Issue:** #49
**Gate:** execução do servidor oficial Keycloak **26.8.0** em contêiner descartável, com criação do realm sintético pela **Admin REST API oficial autenticada** e HTTPS no loopback.

**Status:** **PASS limitado** — Keycloak real emitindo JWT com audiência MCP e JWKS HTTPS no [GitHub Actions #37975016365](https://github.com/sylviohmartins/telechir/actions/runs/37975016365) (3/3 jobs success).

## Escopo do gate

A distribuição oficial do Keycloak é inicializada em GitHub Actions Ubuntu, sem acesso a produção. O ensaio gera uma autoridade certificadora efêmera separada de um certificado leaf `CA:FALSE`, acessa por HTTPS validado a descoberta OIDC e JWKS do realm `telechir-phase16`, solicita um JWT de **service account** por `client_credentials`, e verifica com `jose` a assinatura RSA de **token realmente emitido pelo Keycloak**.

O realm de teste tem um client confidencial sintético e dois mappers reais de protocolo: audiência customizada `https://127.0.0.1:8988/mcp` e claim `telechir_scope_fixture=telechir:devices:read`. O verificador de contrato exige `iss`, `sub`, `azp`, `aud`, `exp`, `kid`, algoritmo RS256 e recusa uma audiência diferente. O secret incluso na importação é exclusivo do fixture público de CI — **não é credencial de cliente ou usuário verdadeiro**.

## O que não está certificado

A reivindicação de PASS é estritamente **emissão de token e contrato de claims/JWKS por IdP open source real**. Não inclui validação de token pelo Worker em execução, `Authorization Code + PKCE` realizado contra Keycloak, navegador/consentimento, login de usuário humano, IdP externo gerenciado, renovação, revogação, mapeamento de identidade Telechir em D1 ou sessão conduzida por um modelo de IA.

O `JwtAccessTokenVerifier` admite parametrizar `OAUTH_SCOPE_CLAIM`; a claim específica do fixture é uma evidência de mapeabilidade, **não** de aceitação end-to-end pelo verificador real. Para uso final de um IdP, exige-se configurar provider issuer/JWKS/claims e vinculação de usuário com revisão de segurança independente.

## Evidências

- `scripts/interop/keycloak-real-idp-contract.sh`
- `scripts/interop/fixtures/keycloak-phase16-realm.json`
- `apps/control-plane/test/fixtures/keycloak-real-idp-contract.mjs`
- `.github/workflows/mcp-interop.yml`

Referências oficiais: [Keycloak: execução em Docker](https://www.keycloak.org/getting-started/getting-started-docker), [Keycloak: importação de realms](https://www.keycloak.org/server/containers), [Keycloak: Audience mapper](https://www.keycloak.org/docs/latest/server_admin/).

**Prova CI de integração [#37975016365](https://github.com/sylviohmartins/telechir/actions/runs/37975016365):** três jobs `success` no head testado. O job Keycloak retornou:
- `PASS: actual Keycloak 26.8.0 master realm HTTPS OIDC discovery`;
- `PASS: real Keycloak realm provisioned through authenticated Admin REST API`;
- `PASS: real Keycloak RS256 token verified against live HTTPS JWKS`;
- `PASS: exact Telechir resource audience, linked subject, scope mapper, expiry and azp`;
- `PASS: real Keycloak token fails closed with wrong MCP audience`;
- `RESULT: KEYCLOAK_REAL_IDP_ISSUANCE_CONTRACT_PASS`.

**Depuração:** a primeira tentativa com `--import-realm` encontrou erro de diretório no bootstrap da imagem. Para evitar depender de montagem e importação de arquivo na inicialização, o realm passou a ser criado pelo **endpoint administrativo oficial autenticado após o boot do realm master**. Nenhuma alteração no aplicativo Telechir ou na política de autenticação foi necessária. O teste definitivo do último commit documental deve confirmar novamente 3/3 jobs.

**Limite de homologação:** JWT `client_credentials` real emitido por Keycloak, verificado pelo script `jose` contra JWKS reais, porém **ainda não consumido pelo Worker Telechir**. Não atribuir PASS de `Authorization Code + PKCE` real ou login humano a este gate.
