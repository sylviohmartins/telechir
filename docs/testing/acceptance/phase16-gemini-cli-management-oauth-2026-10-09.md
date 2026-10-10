# Phase 16 — Gemini CLI: teste de OAuth por comando administrativo e limite da evidência

**Data:** 2026-10-09  
**Issue:** [#49](https://github.com/sylviohmartins/telechir/issues/49)  
**Cliente:** `@google/gemini-cli@0.63.0`, Linux GitHub Actions descartável.  
**Estado:** `PASS` **somente para o diagnóstico de comportamento de `gemini mcp list`**; OAuth iniciado pelo Gemini permanece **`NOT_TESTED`**. Não existe autorização implícita para login de modelo, uso de conta real, staging ou produção.

## Pergunta testada

O comando administrativo `gemini mcp list` inicia a autenticação OAuth quando há uma configuração MCP com `oauth`, Keycloak real e nenhuma credencial Bearer pré-fornecida?

## Execução e observação

- Executado em ambiente Linux descartável sobre Keycloak 26.8.0 + Workerd/MCP + D1 locais, com client público previamente registrado `telechir-phase16-gemini`, escopo apenas `telechir:devices:read`, PKCE S256 e redirect URI restrita a loopback.
- Os certificados de Keycloak e Worker permanecem verificados por CA efêmera isolada e preflight de leaf; não houve bypass TLS, `trust:true`, login Google/LLM, token fixture injetado ou impressão de segredos.
- O runner preparou o ambiente de navegador real, mas o CLI **não abriu o navegador** e **não iniciou authorization request**.
- [CI #38006740106](https://github.com/sylviohmartins/telechir/actions/runs/38006740106), head `5554adf61b5d27bcb3bae94abc88378aa02c1674`: os jobs control-plane e clientes independentes passaram, mas o job Keycloak foi **FAIL** porque o experimento originalmente exigia erroneamente que `gemini mcp list` iniciasse OAuth.
- Evidência sanitizada do processo real: `vendorExitCode=0`, `disconnected=true`, `browserLaunchCaptured=false`, `oauthUrlSeen=false`, `connected=false`, `tlsError=false`, `dcrError=false`. Nenhum code, state, senha, header ou callback foi publicado.
- O harness agora classifica explicitamente esse resultado como `GEMINI_CLI_MCP_LIST_OAUTH_NOT_INITIATED` **sem emitir marcador de aprovação de OAuth**. A ausência de token é exigida para essa classificação. Comportamentos inesperados continuam falhando o CI.

## Interpretação correta

A documentação oficial diferencia o comando administrativo `gemini mcp list` do comando **interativo** `/mcp auth <server-name>` dentro do REPL. Logo, o comportamento observado **não demonstra incompatibilidade de OAuth do Gemini com Telechir**. Demonstra apenas que **o comando escolhido não iniciou a autorização** naquele ambiente/versão. A integração interativa solicitada continua sem prova. Fontes oficiais:

- https://geminicli.com/docs/tools/mcp-server/
- https://geminicli.com/docs/cli/commands/

## Próximo gate verificável

1. Homologar o próprio `/mcp auth telechir-gemini-phase16-ci` em sessão Gemini CLI real, isolada e autorizada, sem usar conta pessoal em CI. Se o produto exigir uma conta de modelo, registrar `BLOCKED` por essa dependência e não substituir por Bearer injetado.
2. Confirmar que o CLI gera `state`/PKCE S256, navegador autentica no Keycloak, redirect URI é entregue ao listener do Gemini, credencial é obtida e armazenada pelo próprio fornecedor.
3. Validar `tools/list` na conexão autenticada e, separadamente, execução de `list_devices` iniciada pelo próprio cliente, com negativa de escopo, owner indevido, token expirado e `disabled_at`.
4. Anexar CI/versão/ambiente e atualizar a matriz somente para capacidades efetivamente comprovadas. Nenhuma inferência por LLM, device físico, IdP hospedado ou publicação é certificada por este experimento.

**Invariantes preservados:** 24 MCP tools, contratos Device Wire, least privilege, autoridade final do agent local, TLS estrito e nenhum deploy.
