# Phase 16 — Gemini CLI 0.63.0: preflight do REPL interativo

**Referência:** 2026-10-09, America/Sao_Paulo
**Issue:** [#49](https://github.com/sylviohmartins/telechir/issues/49)
**Cliente e transporte:** `@google/gemini-cli@0.63.0`, MCP Streamable HTTPS em laboratório GitHub Actions.
**Estado:** `PASS` restrito ao preflight de **inicialização de REPL com PTY**; OAuth `/mcp auth` **não certificado** (`NOT_TESTED`).

## Objetivo

Diferenciar o comando administrativo `gemini mcp list`, que não inicia OAuth, do comando de REPL `/mcp auth telechir-gemini-phase16-ci`. O experimento não injeta JWT, não autentica em conta real de modelo e não substitui identidade sintética do Keycloak por um usuário real.

## Evidência observada

1. A execução inicial do preflight (`CI #38017548579`) terminou verde globalmente, mas o processo Gemini encerrou com código **42** e nenhuma URL OAuth; isso foi inicialmente insuficiente para classificar a causa.
2. Após preparar o executável oficial em cache npm privado e separar erros de boot de ausência de autorização, a execução `CI #38017849499` falhou **intencionalmente** no job Keycloak: processo `exit=42`, nenhuma URL de autorização. A execução `CI #38018108722` confirmou por log *redigido*: `No input provided via stdin`. Isso indica execução não interativa, **não** um defeito de autorização do Telechir.
3. O harness passou a usar `script`/PTY com verificação TTY no subprocesso e remove as variáveis de detecção de CI **somente do subprocesso do fornecedor**; o wrapper mantém `GITHUB_ACTIONS=true` como requisito, e os testes continuam em runner Linux descartável.
4. **CI [#38018350979](https://github.com/sylviohmartins/telechir/actions/runs/38018350979), 3/3 jobs `success`**: processo Gemini CLI permaneceu ativo, cerca de 22 KiB de saída terminal, sem reproduzir `exit=42`. Não foi detectada authorization URL gerada pela CLI, abertura de navegador, callback nem arquivo de tokens OAuth. O CI registrou somente `GEMINI_CLI_REPL_OAUTH_NOT_OBSERVED_NOT_CERTIFIED`, **não** marcador OAuth PASS.
5. O harness insere `/mcp auth <alias>` na entrada do PTY; **não há prova independente de que a UI recebeu e processou o comando**, pois a renderização do REPL e possíveis telas iniciais não foram certificadas. Assim, a ausência de URL não pode ser interpretada como rejeição do fluxo pelo cliente nem defeito de Telechir.

## Restrições e segurança

- Realm Keycloak 26.8.0, usuário sintético, público `telechir-phase16-gemini` com PKCE S256, `telechir:devices:read`, callback loopback, Workerd/D1 locais; nenhuma infraestrutura de produção.
- O navegador usa Chrome com CA temporária verificada, sem `ignoreHTTPSErrors` ou bypass de TLS; perfis e certificados efêmeros.
- A autenticação de modelo é **fictícia e inválida**, criada exclusivamente para validar a inicialização local do REPL. Não se realiza inferência. O subprocesso usa proxy loopback indisponível para impedir chamadas normais a serviços de modelo externos; somente `127.0.0.1`/localhost são exceções declaradas.
- Npm baixa o executável publicado e versionado antes de iniciar o REPL; execução usa o binário preparado em cache privado, sem `npx` externo durante o PTY.
- Saída bruta de UI, authorization/callback URLs, tokens, cookies e senhas não são enviados ao log persistente. A classificação sanitizada pode mostrar somente tamanho, exit code e flags.
- O código de produção, 24 MCP tools, políticas, scopes e contratos Device Wire não foram alterados.

## Definição do próximo gate

1. Verificar, em interface de fornecedor efetivamente operável, a sequência de telas iniciais do Gemini 0.63.0, o foco do prompt e a aceitação de `/mcp auth telechir-gemini-phase16-ci` — sem reutilizar conta pessoal em CI.
2. Exigir prova de `state` e PKCE S256 próprios, callback de Chrome/Keycloak recebido pela CLI, armazenamento privado do token e conexão autenticada.
3. Separar do OAuth a chamada real de `tools/list` e `list_devices`, além dos negativos de escopo/owner/usuário desabilitado. Não reivindicar seleção de ferramenta por LLM sem sessão em inferência.
4. Se o host exigir autenticação de modelo real ou intervenção de UI não suportada pela automação, marcar o gate `BLOCKED` com motivo, versão e ambiente. Nunca transformar o preflight em certificação só porque três jobs CI passaram.

**Conclusão:** o impedimento anterior de entrada não interativa foi corrigido no ambiente CI. A autenticação OAuth nativa iniciada pelo Gemini continua **não demonstrada**. Issue #49 permanece aberta. Fontes oficiais: https://geminicli.com/docs/tools/mcp-server/ e https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md.
