# Phase 16 — Chromium real, Keycloak PKCE S256 e consentimento

**Data:** 2026-10-09
**Issue:** #49
**Gate:** PENDING_CI — não atribuir PASS antes de 3/3 jobs success no head final e dos dois marcadores `KEYCLOAK_CHROMIUM_BROWSER_PKCE_CONSENT_PASS` e `KEYCLOAK_CHROMIUM_BROWSER_PKCE_MCP_D1_PASS`.

## Objetivo

Avançar da autenticação HTTP dirigida sem browser (PR #69) para uma **instância real de Chromium headless automatizada por Playwright**, com formulário visual de login do Keycloak 26.8.0 e tela de consentimento oficial. O cliente OAuth adicional `telechir-phase16-browser` é **público**, exige `PKCE S256`, `standardFlowEnabled=true`, `consentRequired=true`, sem acesso implícito, password grant, service account ou callback externo. Os contratos existentes `telechir-phase16-ci` e `telechir-phase16-pkce` não mudam.

## Controles e evidências exigidas

- Certificado do Keycloak validado por `verify-local-tls.mjs` (leaf apresentado e CA efêmera) antes de entrar no login; **Chromium com NSS DB exclusivamente temporário**, contendo somente aquela CA, e controle negativo com a CA distinta do Worker; `ignoreHTTPSErrors=false`; sem flags globais de bypass.
- Login com controles DOM verdadeiros `#username`, `#password` e `#kc-login` no Chromium headless em `127.0.0.1:9443`. Bloquear navegação/requisições cross-origin não esperadas; callback loopback é capturado localmente pela interceptação Playwright e nunca enviado a serviço externo.
- Primeira sessão: clicar **Cancel** na tela de consentimento e comprovar `access_denied`, mesmo `state` e ausência de `code`.
- Nova sessão/contexto: clicar **Accept**, comprovar `state` e emissão de authorization code verdadeiro. Um callback adulterado em memória deve falhar na validação **client-side** de `state`.
- Troca por token via HTTPS validado com `code_verifier` S256, `iss/aud/azp/sub` e escopo limitado assinados pela JWKS real; rejeitar repetição do code, troca com verifier errado e code expirado. Laboratório define TTL de authorization code reduzido somente para testar expiração; isso não é garantia de revogação de access token.
- Vincular token de browser ao D1 Wrangler isolado por SHA-256(`sub`), ler somente device próprio no MCP Worker com JWKS direto do Keycloak; rejeitar assinatura alterada e Bearer ausente (401), escrita sem scope (403), e JWT válido de usuário localmente desativado (401).
- Nenhuma senha, cookie, authorization code ou access token pode aparecer em logs, screenshots, traces, artefatos ou outputs; diretório privado `mktemp`, cleanup por trap; Playwright `1.58.2` fixado apenas para o job CI.

## Não objetivos

O navegador é **headless, de fato Chromium**, e a tela de consentimento é real, mas o usuário continua sendo um **principal fictício**. Não prova login ou consentimento de pessoa real, MFA, clientes MCP interativos de fornecedores, provedor IdP externo, domínio público, Cloudflare hospedada, IA em inferência ou hardware físico. Nenhum gate desses deve ser marcado como concluído por consequência.

## Implementação

- `apps/control-plane/test/fixtures/keycloak-browser-pkce.mjs` — navegador, callback, PKCE e provas de segurança.
- `scripts/interop/keycloak-browser-pkce-mcp-smoke.sh` — migração D1, autenticação na rota MCP e desativação.
- `scripts/interop/fixtures/keycloak-phase16-realm.json` — cliente com consentimento obrigatório/TTL de code apenas do laboratório.
- `scripts/interop/keycloak-real-idp-contract.sh` e `.github/workflows/mcp-interop.yml` — orquestração segura e instalação efêmera do navegador.
- Referências de plataforma: [Playwright — Browsers](https://playwright.dev/docs/browsers), [Chromium Linux Certificate Management](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/cert_management.md), [Keycloak Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/).

**Estado:** `PHASE_16_IN_PROGRESS`; manter issue #49 aberta após o gate.