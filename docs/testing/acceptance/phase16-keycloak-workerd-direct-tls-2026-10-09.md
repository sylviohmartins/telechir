# Phase 16 — Workerd consulta Keycloak real por HTTPS (sem replay)

**Data:** 2026-10-09
**Issue:** #49
**Status:** **PASS delimitado** — [CI #37982415861](https://github.com/sylviohmartins/telechir/actions/runs/37982415861), 3/3 jobs `success` e marcador `KEYCLOAK_WORKER_DIRECT_TLS_OAUTH_JWKS_PASS` no commit `0222d61`. A CI do último commit documental deve ser novamente validada antes do merge.

## Gate / hipótese

Estender o ensaio integrado pelo PR #67, executando o mesmo Keycloak 26.8.0 oficial e Worker Wrangler/D1 isolado. O modo estrito `PHASE16_TEST_DIRECT_KEYCLOAK=true` usa o **`JwtAccessTokenVerifier` de produção sem injetar um fetcher**; com isso, `fetch()` do próprio Workerd solicita `/.well-known/oauth-authorization-server/realms/telechir-phase16` e a `jwks_uri` publicada pelo Keycloak real. Diferentemente do ciclo anterior, **nem `PHASE16_TEST_JWKS` nem `PHASE16_TEST_AUTHORIZATION_METADATA` são configurados**. O fixture recusa mistura com snapshots e qualquer emissor diferente do único issuer efêmero esperado.

## Segurança de TLS e verificação adversarial

O script `scripts/interop/keycloak-workerd-direct-tls-smoke.sh` executa duas instâncias descartáveis e sequenciais do Worker, reutilizando apenas o D1 e o Keycloak sintéticos:

1. **CA incorreta:** processar `tools/list` com o JWT realmente emitido pelo Keycloak, mas Workerd recebendo **somente a CA do Worker**, distinta da CA do Keycloak. Deve retornar **HTTP 401**; se aceitar, a execução falha. O erro não deve produzir bypass de JWT.
2. **CA correta:** iniciar Wrangler/Workerd com `NODE_EXTRA_CA_CERTS` apontando **somente para a CA efêmera do Keycloak**. O protocolo MCP e a verificação JWT devem aceitar token com assinatura, issuer, audiência e escopo corretos, consultar o D1 real e listar um device do usuário vinculado sem expor o device estrangeiro; rejeitar ausência de Bearer e assinatura adulterada (401), escrita sem escopo (403) e usuário desativado no mesmo D1 (401).

Ambos servidores HTTPS usam leaf de `CA:FALSE`, chains verificáveis e `verify-local-tls.mjs` para comparar leaf apresentado e trust chain antes de enviar Bearer. Não há `NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k`, trust system-wide, segredo de produção ou fallback para documento público simulado.

## Defeito de interoperabilidade encontrado e corrigido

O primeiro CI (job Keycloak do PR #68) rejeitou corretamente o JWT com CA desconhecida, porém também devolveu 401 com CA correta. Foi adicionado ao **Worker somente de CI** um diagnóstico `/__phase16_direct_idp_probe` que consulta os documentos OAuth/JWKS sem tocar no JWT. A segunda execução expôs a mensagem real do Workerd: `redirect: "error"` não é aceito por `fetch()` do runtime de borda.

Correção em `apps/control-plane/src/oauth.ts`: `redirect: "manual"` e rejeição explícita de respostas HTTP não `ok` (incluindo 3xx) **ou já redirecionadas**. O destino redirecionado não é acessado; não há relaxamento de origem, alg, issuer, audience ou scopes. O teste `oauth.test.ts` adicionou regressão para HTTP 302 com `Location` não confiável exigindo `OAuthErrorCode.InvalidToken`.

Depois da correção, o terceiro CI confirmou **HTTP 401** com CA errada e **sucesso no fetch direto de discovery e JWKS e na leitura autorizada** com CA correta (CI #37982415861), além dos 3/3 jobs de regressão.

## Validação e limites

Exigir CI no head final com 3/3 jobs success e marcadores positivos/negativos do gate direto. Não presumir que `NODE_EXTRA_CA_CERTS` sempre funcione: diferenças de versões Wrangler/Miniflare/Workerd e interceptação TLS podem causar bloqueio; registrar a causa objetiva, sem atribuir PASS em falha. A variante anterior com documentos públicos replayed continua como regressão, independente deste teste.

**Este é um laboratório GitHub Actions Linux em loopback, com Worker e D1 locais.** Não comprova CA pública, domínio externo, Workers implantados na Cloudflare, IdP gerenciado, Authorization Code + PKCE em Keycloak, login/consentimento humano, mediação por LLM, dispositivo real ou revogação de JWT por `jti`. Manter `PHASE_16_IN_PROGRESS` e issue #49 abertas.

## Evidências

- `apps/control-plane/test/fixtures/authenticated-inspector-worker.ts` (modo estrito fixture, sem mudança em `src/`);
- `scripts/interop/keycloak-workerd-direct-tls-smoke.sh`;
- `scripts/interop/keycloak-real-idp-contract.sh`;
- `apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs` (mesmos cenários positivos e negativos do PR #67);
- `docs/testing/acceptance/phase16-keycloak-worker-d1-mcp-2026-10-09.md`.

Referências técnicas: [Cloudflare workerd — trust de CA em wrangler dev](https://github.com/cloudflare/workerd/issues/3500), [Cloudflare — desenvolvimento local](https://developers.cloudflare.com/workers/local-development/). O gate de PR #67 continua documentado separadamente.
