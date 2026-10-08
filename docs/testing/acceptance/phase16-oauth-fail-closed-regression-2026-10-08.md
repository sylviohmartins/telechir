# Phase 16 — Regressão OAuth fail-closed no control plane

**Data:** 2026-10-08

**Issue:** #49

**Status:** incremento automatizado de segurança, não certificação externa autenticada.

## Motivação

A execução do MCP Inspector real confirmou a fronteira sem credenciais (HTTPS, metadata OAuth e 401) no runner Linux (PR #53). A execução autenticada positiva ainda exigiria um IdP sintético acessível pelo Worker e um usuário devidamente vinculado em D1. O primeiro protótipo de teste local não completou o handshake HTTPS devido à interferência de certificado do Avast já documentada em `phase16-verified-ci-and-local-tls-2026-10-08.md`. Esse protótipo não foi integrado ao código-fonte nem usado para alegar sucesso.

Enquanto o ambiente end-to-end autenticado não estiver disponível, o controle de segurança já existente foi aprofundado com testes de regressão estritamente in-process que exercitam **o verificador JWT de produção** `JwtAccessTokenVerifier`, com issuer e material de assinatura gerados em teste e JWKS fornecido por um fetcher controlado.

## Novos casos implementados em `apps/control-plane/test/oauth.test.ts`

1. **Usuário desativado:** token RS256 válido, correspondente a subject e usuário existente, é negado ao definir `users.disabled_at`. O erro preserva `OAuthError(InvalidToken)`.
2. **Normalização de scopes:** `scope` representado como string com espaços duplicados ou como lista com entradas duplicadas resulta somente em escopos únicos e explicitamente concedidos, sem elevação.
3. **Token malformado ou sem assinatura válida:** credencial com estrutura inválida e JWT declarando `alg=none` são rejeitados antes de consultar metadata/JWKS remoto, devolvendo `OAuthError(InvalidToken)`.

Não houve alteração do `src/oauth.ts`, regras de autorização, endpoint, client_id, scopes públicos nem contratos Device Wire.

## Aceite e evidência

- Teste direcionado `vitest run test/oauth.test.ts`: 13/13 PASS (10 anteriores + 3 novos).
- Os gates de regressão geral, TypeScript, formatação, dry-run, npm audit e CI devem ser validados independentemente no PR.
- Nenhuma credencial de produção ou recurso externo/financeiro necessário.
- A partir deste incremento, a matriz da Phase 16 deve diferenciar `JWT_VERIFIER_IN_PROCESS_PASS` de `INSPECTOR_AUTHENTICATED_END_TO_END_NOT_TESTED`.

## Próximos gates

Construir e executar um ambiente Linux/HTTPS com IdP e JWT sintéticos, persistência D1 efêmera e client CLI independente; validar `tools/list` 24/24, leitura autorizada, cross-user, escopo insuficiente e reconexão. Não realizar esses testes sob TLS interceptado nem reutilizar credenciais reais. Até sua execução comprovada, `PHASE_16_IN_PROGRESS`, issue #49 aberta.
