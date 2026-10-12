# Phase 16 — Codex App Server: revogação na mesma sessão com OAuth nativo Keycloak

**Data de aferição:** 2026-10-12 (America/Sao_Paulo)
**Issue:** [#49](https://github.com/sylviohmartins/telechir/issues/49)
**Cliente oficial:** `@openai/codex@0.162.0`, `app-server` JSON-RPC real, Ubuntu GitHub Actions descartável.
**Autorização:** OAuth Authorization Code + PKCE S256 iniciados pelo próprio Codex CLI; Keycloak 26.8.0, Workerd HTTPS e D1 local real.

## Resultado — PASS de autorização em chamada de ferramenta na sessão ativa

A [CI #38207585691](https://github.com/sylviohmartins/telechir/actions/runs/38207585691), no head `ec9dfaaee1281cecca3988f9f3b40ef501738f9c`, concluiu **3/3 jobs `success`**.

O ensaio usa o perfil OAuth previamente autenticado pelo próprio Codex CLI; não extrai nem injeta o Bearer. Um **único processo `codex app-server`** cria **uma única thread**, e efetua chamadas JSON-RPC oficiais `mcpServer/tool/call`, ferramenta **`list_devices`**, com argumentos `{"status":"all"}`. As três operações ocorrem no **mesmo processo, mesma thread e mesma configuração de credencial do fornecedor**, sem sessão de LLM.

Marcadores verificados no job Keycloak:

- `KEYCLOAK_CODEX_OAUTH_IN_SESSION_BASELINE_READ_PASS`: chamada de leitura autorizada; resultado contém exatamente o dispositivo sintético previamente vinculado ao titular OAuth.
- `KEYCLOAK_CODEX_OAUTH_IN_SESSION_USER_DISABLED_PASS`: atualização restrita do `users.disabled_at` no D1 efêmero, sem reiniciar Codex; o Worker segue com `/health` saudável e a chamada subsequente na mesma thread sofre negativa de autorização.
- `KEYCLOAK_CODEX_OAUTH_IN_SESSION_USER_REENABLED_PASS`: reabilitação restrita da mesma identidade no D1 e nova chamada na mesma thread devolvem novamente **somente** o dispositivo esperado.
- `KEYCLOAK_CODEX_OAUTH_IN_SESSION_REVOCATION_GATE_PASS`: sequência completa foi executada no runtime oficial, sem LLM ou token substituto.

Os gates anteriores `KEYCLOAK_CODEX_OAUTH_APP_SERVER_DEVICE_READ_PASS` e `KEYCLOAK_CODEX_OAUTH_APP_SERVER_DISABLED_USER_PASS`, em novos processos separados, também passaram na mesma execução. Isso preserva a cobertura de nova conexão e acrescenta a de autorização **durante** a sessão.

## Implementação e controles

`scripts/interop/codex-app-server-oauth-readonly.py` inclui cenário `live-revocation`: uma thread Codex e três chamadas `mcpServer/tool/call` ao mesmo alias MCP. A alteração de D1 usa apenas os scripts SQL de `browser-pkce/disable.sql` e `browser-pkce/seed.sql`, já gerados e escopados ao `identity_provider` e ao `provider_subject_hash` sintéticos; uma verificação adicional restringe a instrução a um único `UPDATE users SET disabled_at`. `wrangler d1 execute DB --local --persist-to` opera somente em `worker-state` do diretório temporário GitHub Actions, sem produção.

A saúde do Worker é verificada em `https://127.0.0.1:8988/health` com CA efêmera explícita, sem bypass TLS. A reabilitação do usuário sintético ocorre também se a asserção de negativa falhar, de modo que a fixture não permaneça deliberadamente desabilitada durante os demais testes. O ensaio executa comandos de infraestrutura apenas no CI efêmero e não altera o agente local, as ferramentas MCP nem políticas de usuários reais.

`scripts/interop/keycloak-codex-cli-interactive-oauth-smoke.sh` executa o cenário `live-revocation` **depois do login real** e antes dos cenários legados de processo separado, que continuam ativos. Não houve criação de endpoint, superfície de ferramentas, permissão ou tipo Device Wire adicional.

## Delimitações obrigatórias

- **PASS** de chamada MCP pelo runtime Codex oficial com OAuth do Keycloak, incluindo negativa e recuperação na **mesma thread**.
- **NÃO TESTADO**: seleção/autonomia da ferramenta por modelo, consentimento de conta real, interface ChatGPT, retenção de conexão ociosa ou desconexão de sessões abertas sem tool call.
- O `disabled_at` é imposto pela aplicação ao processar cada requisição; **não** demonstra invalidação criptográfica de JWT, revogação de `jti` ou logout/refresh token no Keycloak.
- A identidade, o dispositivo, as CAs e os dados são sintéticos; nenhum dispositivo físico nem ambiente staging/produtivo participou.

## Próximas fases

1. Avaliar negativas de escopo/owner e `tools/call` pela mesma thread OAuth nativa com mais identidades sintéticas sem ampliar autoridade.
2. Certificar Gemini `/mcp auth` se houver sessão de cliente compatível; status permanece `NOT_TESTED` sem autorização concluída.
3. Validar dispositivo físico, Local Agent, realtime e staging separadamente, com limites e ações explicitamente autorizados.
4. Preservar a issue #49 em aberto até revisar todos os critérios da matriz e o exit review.

**Base técnica:** `scripts/interop/codex-app-server-oauth-readonly.py`, `scripts/interop/keycloak-codex-cli-interactive-oauth-smoke.sh` e [CI #38207585691](https://github.com/sylviohmartins/telechir/actions/runs/38207585691).
