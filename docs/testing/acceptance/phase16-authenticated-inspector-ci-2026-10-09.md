# Phase 16 — MCP Inspector autenticado em HTTPS isolado

Data: 2026-10-09

Issue: #49

Baseline: `main` no merge `7c37caa119b68e44ac89ff180705e079f151bb33`.

## Objetivo e arquitetura do gate

Estender a homologação independente da CLI MCP Inspector 2.5.0 para uma sessão **autenticada com JWT RS256 válido** e operação de leitura segura, sem implantar servidor, configurar credenciais reais ou alterar a aplicação em produção.

O job `independent-inspector` mantém o ensaio original de token ausente (401/`auth_required`) e acrescenta `scripts/interop/inspector-authenticated-smoke.sh`, sempre em GitHub Actions Ubuntu descartável e sem secrets.

1. Gerar certificado HTTPS local e par RSA efêmero. A chave privada RSA nunca é gravada: apenas o token temporário assinado, a chave JWK **pública** e a seed SQL ficam na pasta privada `mktemp`, eliminada ao final.
2. Criar D1 isolado em `--persist-to` temporário; aplicar todas as migrações **somente --local**, inserir usuário com `provider_subject_hash=base64url(SHA256(sub))` e dispositivo sintéticos.
3. Executar **entrypoint exclusivamente de teste** `apps/control-plane/test/fixtures/authenticated-inspector-worker.ts` com `wrangler dev`, origin de loopback em `https://127.0.0.1:8988/mcp`, certificado emitido para loopback e JWKS pública injetada por binding efêmero. O `src/index.ts` de produção não importa o fixture.
4. Usar a rota real `mcpHttpRoute`, o servidor MCP real e o `JwtAccessTokenVerifier` de produção para assinatura, JWKS, audience, issuer, scope e vínculo de identidade. **Somente** as respostas de descoberta do authorization server e JWKS são fixture retornado por um fetcher injetado; não existe IdP público ou endpoint JWT exposto.
5. Certificar o certificado apresentado ao cliente via fingerprint SHA-256 e chain trust, depois conferir OAuth metadata e os HTTP 401 (sem bearer e audiência incorreta) e 403 (JWT válido de leitura tentando `write_file`).
6. Rodar **CLI independente em processo próprio** com `--header "Authorization: Bearer [JWT sintético]"`, `--stored-auth-only` e `--format json`. Validar `initialize`, `tools/list` com 24 ferramentas e `tools/call list_devices` com somente um device sintético. Validar ainda que `write_file` não recebe autorização via Inspector.
7. Garantir encerramento do worker e eliminação de pasta privada por `trap`. Não usar `NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl --insecure`, produção, segredos reais ou ações destrutivas.

## Fronteiras explícitas

O teste executa **MCP Inspector real**, por HTTPS genuíno e com JWT real, porém **não executa browser OAuth authorization code/PKCE**; identidade, authorization metadata e JWKS são sintéticas e efêmeras. A assinatura/vínculo são validados pelo componente de produção, mas o authorization server não é um IdP externo. O Worker de fixture não é o entrypoint de produção, embora reuse a rota de produção e o mesmo mecanismo de autenticação. Portanto, um PASS certifica apenas a interoperabilidade autenticada do Inspector com o fixture de teste e a rota MCP, **não** qualquer produto como Codex, Claude Code, Gemini CLI, Copilot ou ChatGPT.

Critérios de aceitação: dois jobs GitHub Actions `success`, resultado rastreável, documentação da limitação, issue #49 ainda aberta e `PHASE_16_IN_PROGRESS`. **PASS REMOTO VERIFICADO:** [GitHub Actions run #37881808611](https://github.com/sylviohmartins/telechir/actions/runs/37881808611), job `independent-inspector`, concluído com `success` em 2026-10-09. Logs comprovam `INDEPENDENT_AUTHENTICATED_INSPECTOR_SMOKE_PASS`: HTTPS pinning, banco local efêmero, OAuth metadata/JWKS sintéticos, JWT RS256 real, 401/403 na rota, `initialize`, `tools/list` com 24 ferramentas, `list_devices` isolado e bloqueio preventivo da escrita pelo próprio Inspector. O job `control-plane` do mesmo run também terminou `success`, repetindo os 125 testes e demais gates.
