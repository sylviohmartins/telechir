# Phase 16 — JWT Keycloak real na rota MCP Worker com D1 local

**Data:** 2026-10-09

**Issue:** #49

**Status:** **PASS delimitado no gate Keycloak** — [CI #37980819190](https://github.com/sylviohmartins/telechir/actions/runs/37980819190), com `KEYCLOAK_WORKER_D1_MCP_AUTHENTICATED_PASS`, `KEYCLOAK_WORKER_D1_MCP_READONLY_PASS` e `KEYCLOAK_WORKER_D1_DISABLED_USER_PASS`. Verificar novamente os **três jobs no último head** antes do merge.

## Critério de aceite

Executar uma autorização `client_credentials` contra o **Keycloak oficial 26.8.0 real** em contêiner efêmero `127.0.0.1:9443`, com TLS validado e CA/leaf próprios. O JWT RS256 não pode ser assinado pela fixture: precisa ser emitido pelo IdP e validado com discovery/JWKS coletados da instância em execução.

Aproveitar o mesmo token e contêiner já existentes no gate do PR #66, iniciar o **Worker Wrangler local real** em `https://127.0.0.1:8988/mcp`, aplicar as migrations **D1 reais**, inserir um usuário vinculado pelo SHA-256 do `sub` do Keycloak, um segundo usuário e dispositivos diferentes. O `mcpHttpRoute` e o `JwtAccessTokenVerifier` importados de `src/` não podem ser falsificados ou modificados.

Validar através de requisições HTTPS JSON-RPC:

- Controle positivo: `tools/list` devolve as **24 tools públicas**; `tools/call:list_devices` retorna exatamente o dispositivo da identidade vinculada e **não** o dispositivo de outro usuário.
- Falhas de autenticação: sem Bearer e com assinatura JWT alterada resultam em **HTTP 401**.
- Escopo insuficiente: token genuíno limitado a `telechir:devices:read` tenta `write_file` e obtém **HTTP 403** mais `WWW-Authenticate` de escopo `telechir:files:write`; nenhum side effect ocorre.
- Desativação: executar `UPDATE users SET disabled_at=CURRENT_TIMESTAMP` no mesmo D1 persistido; nova tentativa de leitura com **o mesmo JWT ainda válido** deve obter **HTTP 401**.
- Transporte: certificado HTTPS da rota Worker e certificado do Keycloak possuem CAs efêmeras **distintas**; validar fingerprint SHA-256 do leaf apresentado e cadeia da CA antes de enviar JWT.

## Limites de evidência importantes

O **token e os documentos públicos OAuth/JWKS são originados do Keycloak real**. O bootstrap do teste obtém discovery RFC 8414/JWKS sobre HTTPS com a CA específica do Keycloak, mas entrega uma **cópia fiel em memória** desses documentos à fixture Worker via `PHASE16_TEST_AUTHORIZATION_METADATA` e `PHASE16_TEST_JWKS`. Assim, o runtime Worker invoca o verificador JWT de produção e D1 verdadeiro, mas **não realiza uma conexão TLS outbound direta ao Keycloak**. Esse limite evita depender de confiança CA global no Workerd e precisa ser considerado no próximo gate de conectividade externa.

O Worker é executado localmente por Wrangler com D1 descartável, **não hospedado na Cloudflare**. A concessão é `client_credentials`, não `Authorization Code + PKCE` com login de usuário humano. Não há inferência LLM, conta comercial, publicação, deploy de produção, device físico nem permissão de escrita. Não marcar `PHASE_16_COMPLETE`.

## Segurança e descartabilidade

Execução restrita ao GitHub Actions Ubuntu, loopback, CA e certificados gerados no job, permissões privadas, sem bypass global TLS, sem chaves de produção, sem JWT em logs. O trap encerra Wrangler e contêiner, remove token/SQL/JWKS/CA temporários e não persiste volumes. Os dois usuários e dispositivos são sintéticos.

## Evidências reexecutáveis

- `scripts/interop/keycloak-real-idp-contract.sh` — Keycloak + JWT legítimo + gate de verificação existente.
- `scripts/interop/keycloak-worker-d1-smoke.sh` — Wrangler HTTPS, D1 real, TLS e mutação.
- `apps/control-plane/test/fixtures/authenticated-inspector-worker.ts` — mesma rota e verificador de produção; replay isolado de documentos públicos autênticos.
- `apps/control-plane/test/fixtures/keycloak-worker-d1-seed.mjs` — subject vinculado ao D1 e isolamento entre owners.
- `apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs` — controle positivo e negativas com HTTP real.
- `.github/workflows/mcp-interop.yml` — job Keycloak existente e dois jobs independentes, sem deploy.

Referência anterior: [PR #66](https://github.com/sylviohmartins/telechir/pull/66), [CI #37979406170](https://github.com/sylviohmartins/telechir/actions/runs/37979406170). **Primeira evidência remota do gate:** [CI #37980819190](https://github.com/sylviohmartins/telechir/actions/runs/37980819190), job Keycloak `success` e predicados citados. O último commit documental precisa também de 3/3 jobs `success`.
