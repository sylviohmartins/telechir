# Phase 16 — suspensão de usuário e reconexão fail-closed no Codex App Server

**Data:** 2026-10-09  
**Issue:** [#49](https://github.com/sylviohmartins/telechir/issues/49)  
**Cliente:** distribuição oficial `@openai/codex@0.162.0`, `codex app-server`.

**Estado:** PENDENTE de CI no PR. Não atribuir PASS antecipado.

## Delimitação do mecanismo

A classe **`JwtAccessTokenVerifier` de produção** consulta `users` via D1 exigindo `disabled_at IS NULL` durante `verifyAccessToken`, além de validar `exp`, `iss`, `aud`, RS256 e scopes. O sistema dispõe, portanto, de **invalidação de acesso por desativação do usuário vinculado**, não de uma revocation list de JWTs individuais (`jti`). Não confundir desativação com revogação individual, logout, refresh token ou IdP remoto.

O teste usa a rota MCP real no Wrangler HTTPS loopback, com certificado leaf assinado por CA efêmera e SHA-256 pinado, JWKS sintético público, JWT assinado e D1 isolado. Todos os arquivos temporários são privados e descartados pelo `trap`.

## Gate executável

1. Ler `list_devices` com JWT válido read-only pelo Codex App Server oficial.
2. Executar o cenário **`expired`** com JWT RS256 cuja assinatura, audiência e escopos são válidos, mas `exp` está no passado, exigindo rejeição explícita `Auth required` ou erro equivalente; conexão/TLS quebrado não conta como recusa correta.
3. Iniciar **outro processo `codex app-server`**, com seu `CODEX_HOME` privado e uma thread efêmera. Executar `list_devices` com sucesso e manter essa **mesma sessão aberta**.
4. O shell desativa **apenas o usuário sintético** no banco D1 persistido pelo mesmo Wrangler, atualizando `users.disabled_at`.
5. Liberar o processo original e repetir **a mesma chamada `list_devices`, mesmo Bearer, mesma thread e mesmo processo**. Exigir recusa de autenticação, nunca a lista de dispositivos.
6. Abrir uma **nova sessão e novo processo Codex com o mesmo JWT ainda válido**. Exigir recusa de autenticação, demonstrando que reconectar não restaura o acesso após desativação.
7. Preservar os gates anteriores de token ausente, audience incorreta, JWT malformado e escopo insuficiente, além de Inspector, Gemini, Claude e PKCE sintético.

## Critérios de prova e limites

As provas devem incluir o sucesso antes da desativação, resultado da mutação de D1, negação na sessão existente e negação após reconexão. Se o Wrangler não compartilhar a mesma persistência D1 com o worker em execução, **falhar**; não substituir por uma resposta simulada, não executar em produção, não alterar o verificador para aceitar resultados mais permissivos. Uma recusa por transport/TLS outage também **não** deve ser aceita como prova de invalidação.

A verificação de usuário desativado aplica-se às chamadas autenticadas atuais: não é prova de desconexão ativa de todos os transportes, revogação `jti` imediata, expiração de sessão browser ou logout de provedores externos.

**Evidência CI:** aguarda execução no GitHub Actions.
