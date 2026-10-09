# Phase 16 — Integração do cliente MCP oficial com JWT realmente assinado

**Data:** 2026-10-09

**Issue:** #49

**Baseline:** `main` em `23133c77e195b3a6cf97378051d6fc83545f0c9f` (PR #54 integrado).

## Objetivo e distinção das evidências

Executar o **SDK cliente real** `@modelcontextprotocol/client` (`Client` e `StreamableHTTPClientTransport`) sobre a rota real `mcpHttpRoute`, utilizando a classe de produção `JwtAccessTokenVerifier` e tokens JWT **RS256 criptograficamente assinados**, em vez de um `OAuthTokenVerifier` simulado que retorna `AuthInfo` diretamente.

É um **teste integrado in-process com fetch injetado** em Cloudflare Vitest: a requisição é tratada pela rota real e o documento de descoberta/JWKS do provedor é um fixture sintético HTTPS. Não é tráfego de Internet, IdP remoto, browser OAuth, Inspector autenticado ou teste de host proprietário. Não há material criptográfico salvo em disco/CI: os pares de chaves são gerados em memória.

## Cobertura adicionada

Arquivo: `apps/control-plane/test/mcp-signed-client.test.ts`.

1. **Modern e legacy + multi-owner**: dois subjects OAuth com hash SHA-256 vinculados a usuários de teste distintos no D1. Tokens assinados com a mesma chave de fixture, `iss`, `aud`, `sub`, `client_id`, `iat`, `nbf`, `exp` e scope `telechir:devices:read`. O verificador real consulta metadata e JWKS (`code_challenge_methods_supported: ["S256"]`), valida assinatura, issuer e audience, resolve contas e propaga autorização. O cliente moderno negocia `server/discover` e o legado usa `initialize`; ambos veem **as mesmas 24 tools** e exclusivamente os próprios dispositivos. `get_device` de owner estrangeiro responde com `isError`, sem expor identificador.
2. **Scope elevation**: token RS256 autêntico só de leitura tenta `write_file`; a operação é **rejeitada em HTTP 403**, antes de qualquer mutação.
3. **Audience inválida**: JWT validamente assinado para outra URL falha na autenticação com **HTTP 401 antes do handshake MCP**.

Execução unitária dirigida: **3/3 PASS**. Suíte integral do control plane: **19 arquivos, 125/125 testes PASS**. Formatação, TypeScript, Wrangler dry-run e `npm audit --audit-level=high`: **PASS** (0 vulnerabilidades reportadas). Os testes existentes de fake verifier e OAuth unitário permanecem complementares, não substituídos.

## Limites e gates externos

O `fetch` do transporte é intencionalmente injetado e o JWKS é uma resposta de fixture; portanto o teste **não comprova** conectividade externa, validação de TLS end-to-end, login PKCE completo com IdP real, persistência de tokens OAuth dos clientes, conexão real de Codex/Claude/Gemini/Copilot ou estado de produção.

CI existente (control-plane + Inspector independente não autenticado) deve executar este novo teste dentro de `npm test` em PR e push de `main`. A conclusão remota só pode ser declarada depois de consultar as execuções no GitHub.

Manter `PHASE_16_IN_PROGRESS`, issue #49 aberta e matriz de certificação marcada `NOT_TESTED` para clientes comerciais. Próximo gate: autenticação end-to-end com MCP Inspector em runner isolado + IdP/JWKS sintético servido por processo separado, e depois clientes comerciais com identidade e HTTPS próprios de homologação.
