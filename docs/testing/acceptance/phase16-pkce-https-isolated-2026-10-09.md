# Phase 16 — Authorization Code + PKCE S256 em HTTPS isolado

**Data:** 2026-10-09

**Issue:** #49

**Tipo de evidência:** protocolo OAuth em emissor de teste independente de produto, não homologação externa.

## Objetivo

Ampliar a certificação automática além da autenticação com JWT pré-assinado. O script `scripts/interop/oauth-pkce-https-smoke.sh`, executado pelo job `independent-inspector`, gera certificado TLS de curta duração e inicia um servidor OAuth **sintético**, mas efetivamente atendendo endpoints HTTP sobre **HTTPS com certificado validado e fingerprint pinning**. Um cliente de teste realiza requisições reais pela rede de loopback.

O servidor e o cliente ficam dentro de `apps/control-plane/test/fixtures/oauth-pkce-https-smoke.mjs`, sem importação pelo Worker de produção. O authorization server emite codes de uso único com validade máxima de 60 segundos e access tokens RS256 vinculados ao recurso MCP. Os codes, o par RSA e o access token residem apenas em memória; o certificado TLS e sua chave são gerados em pasta temporária e excluídos por trap.

## Cobertura do cenário

- Discovery real do authorization server em `/.well-known/oauth-authorization-server` e leitura por HTTPS da JWKS pública (sem chave privada).
- Authorization Code com `client_id`, `redirect_uri`, `resource`, `scope`, `state` e `code_challenge_method=S256`; validação de retorno do `code` e `state` na redirect URI registrada.
- Troca `POST /token` de `code` e `code_verifier` criptograficamente aleatório, `SHA256`/base64url; obtenção de bearer assinado com `iss`, `aud`, `sub`, `client_id`, scope e expiração.
- Verificação da assinatura RS256 por chave pública obtida do endpoint JWKS; rejeição de audiência divergente.
- Rejeição de `plain`, challenge ausente, falta ou alteração de `resource`, scope indevido, redirect não registrado, client ID incorreto, response type incompatível, verifier inválido, replay de code e troca divergente de `client_id`/`redirect_uri`/`resource`.
- TLS sem modo `insecure`, `NODE_TLS_REJECT_UNAUTHORIZED=0` ou exposição de secrets; servidor escuta exclusivamente em `127.0.0.1`.

## Distinção crucial

Este teste verifica um **servidor OAuth sintético de homologação e a interoperabilidade de um cliente de teste**, não um IdP real de terceiros. Ele ainda **não** executa login humano, tela de consentimento, dynamic client registration, revogação, refresh token, browser, nem o fluxo PKCE *dentro* do MCP Inspector ou de Codex/Claude/Gemini. Também não altera a rota MCP de produção; os testes já existentes do PR #56 continuam cobrindo a aceitação pelo Telechir de JWT RS256 pré-assinado contra o MCP Inspector e D1 isolado.

Não elevar o status da Phase 16 para COMPLETE por causa deste incremento. Registrar PASS apenas após sucesso verificável do job no GitHub Actions.

## Referências normativas

- [RFC 7636 — Proof Key for Code Exchange](https://www.rfc-editor.org/rfc/rfc7636)
- [RFC 8707 — Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707)
- [MCP Authorization Specification, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

**Resultado CI:** **PASS verificado no GitHub Actions [#37887181576](https://github.com/sylviohmartins/telechir/actions/runs/37887181576)**. O job `independent-inspector` confirmou `ISOLATED_PKCE_HTTPS_PROTOCOL_SMOKE_PASS` com TLS pinning, descoberta, S256, vínculo `client`/`redirect`/`resource`, RS256/JWKS e negativas de segurança; o job `control-plane` também terminou `success` com 125 testes, formatação, tipos, dry-run e auditoria de dependências. A prova atesta o emissor OAuth **sintético**, não homologação com IdP externo.
