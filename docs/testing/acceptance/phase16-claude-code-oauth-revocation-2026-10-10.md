# Phase 16 — Claude Code: recusa após `users.disabled_at` e recuperação da conexão

**Data:** 2026-10-10 (America/Sao_Paulo)
**Issue:** [#49](https://github.com/sylviohmartins/telechir/issues/49)
**Cliente real:** `@anthropic-ai/claude-code@2.1.295`, processo CLI oficial em GitHub Actions Linux.
**Alvo:** Keycloak oficial 26.8.0 + Worker Workerd HTTPS + D1 local + identidade sintética.

## Resultado — PASS delimitado de autorização no estabelecimento da conexão

O teste sucede o fluxo nativo de autenticação OAuth/PKCE do Claude certificado pelo [PR #77](https://github.com/sylviohmartins/telechir/pull/77). O harness reutiliza **a mesma credencial armazenada pelo Claude** no `HOME` efêmero, sem extrair o token, gerar novo JWT, manipular código de autorização, adicionar headers `Authorization` ou usar conta Anthropic.

A [CI #38028376197](https://github.com/sylviohmartins/telechir/actions/runs/38028376197) concluiu **3/3 jobs com sucesso** no commit `815301c9f0e515e8be8cf1adcb97669bb958310e`, incluindo os marcadores:

- `KEYCLOAK_CLAUDE_CODE_OFFICIAL_OAUTH_MCP_CONNECTED_PASS` — o Claude Code estabeleceu conexão autenticada após OAuth.
- `CLAUDE_OFFICIAL_OAUTH_DISABLED_USER_MCP_REFUSED_PASS` — após o usuário ser marcado `disabled_at` no D1 real, nova execução `claude mcp list` **não** reportou `Connected`; foi exigido status explícito `Failed to connect`, `Connection error` ou `Needs authentication`.
- `CLAUDE_OFFICIAL_OAUTH_REENABLED_USER_MCP_CONNECTED_PASS` — após reabilitar a mesma identidade D1, nova execução do Claude voltou a reportar `Connected` sem outro login OAuth.
- `KEYCLOAK_CLAUDE_OFFICIAL_OAUTH_USER_REVOCATION_GATE_PASS` — encadeamento completo de estado autorizador, negativa e recuperação.

O teste exige o endpoint `/health` real, com HTTPS validado, **depois** de desabilitar o usuário, impedindo que uma indisponibilidade acidental do Worker seja confundida com uma recusa de autorização. A CLI roda com o mesmo diretório privado, cliente público, escopo `telechir:devices:read` e endpoints de laboratório.

## Limites e interpretação de segurança

- A negativa é de **autorização pela aplicação em uma nova conexão MCP**, baseada em `users.disabled_at`; isso **não** demonstra revogação criptográfica do access token no Keycloak. Como a reabilitação do usuário permite nova conexão sem login, o token previamente emitido ainda é utilizável enquanto válido e autorizado pela aplicação.
- A ferramenta MCP `list_devices` **não** foi chamada pelo Claude neste gate. Não se comprovou revogação de sessão **já estabelecida** durante uma chamada, nem comportamento de long-poll, refresh token, duração/expiração do token, token revogado no IdP ou negações de `tools/call` via runtime Claude.
- `claude mcp list` e `mcp get` são comandos oficiais de **estado/diagnóstico de conexão**, não subcomandos diretos de execução de ferramenta. O caminho normal de `tools/call` no Claude Code envolve uma sessão de agente/modelo, não homologada sem autenticação do fornecedor.
- Nada foi executado contra usuário, modelo, dispositivo, IdP hospedado ou Worker de produção. TLS/CA temporários são verificados; sem `ignoreHTTPSErrors`, bypass TLS ou headers Bearer fabricados.
- Não houve alterações de runtime produtivo, 24 ferramentas MCP, grants, protocolos Device Wire ou políticas de aprovação.

## Arquivos e reprodução

- `apps/control-plane/test/fixtures/keycloak-claude-code-oauth-revocation.mjs`: verifica a configuração somente-leitura, executa o `claude mcp list` oficial com `HOME` do login e **classifica exclusivamente** a linha do alias do Telechir sem imprimir URLs ou tokens.
- `scripts/interop/keycloak-claude-code-native-oauth-smoke.sh`: desabilita e reabilita a identidade sintética no D1 real, verifica `/health` antes da negativa e executa as duas novas verificações de estado do fornecedor.
- `.github/workflows/mcp-interop.yml`: verifica sintaxe de novo fixture; o job Keycloak executa o conjunto completo via `scripts/interop/keycloak-real-idp-contract.sh`.

## Próximos gates

1. Uma chamada efetiva de `tools/call:list_devices` pelo runtime oficial do Claude Code, com negativa por `disabled_at` também no nível de ferramenta — **NOT_TESTED** sem conta/inferência.
2. Rejeição após logout/revogação no Keycloak, expiração de JWT e reconnect com novas credenciais; não confundir com a negativa de `disabled_at` local.
3. Certificação Gemini `/mcp auth`, isolamento em dispositivo físico e staging autorizada; Phase 16 **permanece IN_PROGRESS**.

**Referência oficial:** https://code.claude.com/docs/en/mcp (status `Connected`, `Needs authentication`, `Failed to connect`).
