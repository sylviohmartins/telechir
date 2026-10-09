# Phase 16 — token Keycloak real consumido pelo verificador Telechir

**Data:** 2026-10-09
**Issue:** #49
**Escopo:** JWT emitido pelo Keycloak 26.8.0 oficial, consumido pelo código real de produção `JwtAccessTokenVerifier`, com consulta de identidade simulada e **sem Worker/D1 HTTP**.
**Status:** gate implementado, **aguardando CI do head final do PR**.

## Objetivo e cadeia de confiança

Reutilizar o contêiner e realm Keycloak do gate de contrato já integrado pelo PR #65, sem inicializar um segundo IdP. O contêiner expõe somente HTTPS de laboratório; uma CA efêmera assina um certificado servidor distinto. O ensaio verifica fingerprint SHA-256 do **certificado apresentado** e a cadeia da CA antes de usar credenciais CI sintéticas; `curl --cacert` e `NODE_EXTRA_CA_CERTS` continuam exigindo TLS válido.

A emissão usa `client_credentials`, não um usuário humano. As claims realmente originam do Keycloak: `iss`, `sub`, `kid`, `alg=RS256`, `aud=https://127.0.0.1:8988/mcp`, `azp` e o mapper customizado `telechir_scope_fixture=telechir:devices:read`. O runtime compila `apps/control-plane/src/oauth.ts` com o esbuild versionado pelo projeto, sem modificar lógica de produção. O `JwtAccessTokenVerifier` faz discovery RFC 8414/JWKS por HTTPS real e valida token e identidade.

## Critérios de aceite

- Controle positivo: token emitido pelo Keycloak é aceito pelo verificador real, com client ID, audience e escopo **somente leitura**.
- Negativas: audience incorreta, assinatura RSA alterada, subject não vinculado e identidade sintética desativada precisam produzir `OAuthErrorCode.InvalidToken`; negativas criptográficas não devem consultar a identidade.
- O adaptador D1 in-process **exige a SQL original** com `identity_provider`, `provider_subject_hash` e `disabled_at IS NULL`. Ele **não representa um banco D1 real**.
- Não registrar access token, chave privada, segredo ou payload sensível nos logs; remover certificados/artefatos e contêiner no trap do runner.
- GitHub Actions: três jobs obrigatórios aprovados no commit final, incluindo regressão do control plane, clientes MCP oficiais já integrados e Keycloak/verificador.

## Limites e próximos gates

O token **não** atravessa a rota HTTP `mcpHttpRoute`/Worker nem acessa D1 verdadeiro. O teste não cobre Authorization Code+PKCE interativo em Keycloak, consentimento, refresh, IdP externo gerenciado, conta comercial, modelo selecionando uma ferramenta ou dispositivo real. Portanto, a Phase 16 e issue #49 devem permanecer abertas.

Próximo gate: usar o mesmo JWT real no Worker MCP/fixture D1 de laboratório, validar uma leitura `list_devices` e negativas de autenticação/escopos com registros reais de D1 (sem contas humanas). Em incremento separado, Authorization Code + PKCE real.

## Artefatos

- `scripts/interop/keycloak-real-idp-contract.sh`
- `apps/control-plane/test/fixtures/keycloak-real-idp-contract.mjs`
- `apps/control-plane/test/fixtures/keycloak-telechir-production-verifier.mjs`
- `apps/control-plane/src/oauth.ts` (código de produção **inalterado**)
- `.github/workflows/mcp-interop.yml` (mesmos três jobs)

Base anterior: [PR #65](https://github.com/sylviohmartins/telechir/pull/65) e [CI #37975016365](https://github.com/sylviohmartins/telechir/actions/runs/37975016365). Evidência desta alteração: registrar **somente após** CI final confirmada.
