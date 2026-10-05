# Phase 11 — Revalidação de Publicação OpenAI

**Data:** 2026-10-05
**Escopo:** ChatGPT/Codex public plugin + Remote MCP
**Status:** arquitetura continua válida; fluxo de publicação e gates foram atualizados

## Conclusão

A decisão arquitetural do Telechir permanece válida:

```text
ChatGPT / Codex
  -> plugin público instalado
  -> Remote MCP HTTPS
  -> control plane Telechir
  -> device autorizado
  -> agent local
```

O Remote Desktop Commander continua publicado pela OpenAI como plugin que alcança filesystem, terminal e processos de um computador autorizado por meio de Remote MCP.

A mudança relevante desde a pesquisa inicial é operacional: o caminho atual de distribuição usa o **diretório universal de plugins do ChatGPT/Codex**, package ZIP e portal de submission/review.

Esta fase não prova aprovação futura do Telechir.

## Package atual

Para novo package, a documentação recomenda o formato portátil Agent Plugins:

```text
plugin-root/
  plugin.json
  mcp.json
  assets/
```

- `plugin.json` usa o schema Agent Plugins 1.0.0;
- `mcp.json` declara o Remote MCP com `type: streamable-http`;
- metadata específica da OpenAI fica em `extensions.com.openai`;
- package submetido com MCP não deve incluir `.app.json`/apps references ou lifecycle hooks no fluxo público atual;
- o plugin pode combinar skills + MCP, mas Telechir Phase 11 usa somente MCP.

## Listing e assets

Final submission exige:

- package name e semantic version;
- display name <= 30 caracteres;
- short description <= 30;
- long description <= 4.000;
- developer name <= 80;
- categoria suportada;
- até 20 capabilities;
- até 3 starter prompts, <= 128 caracteres e sem MCP `@mention`;
- website HTTPS;
- support URL HTTPS;
- privacy policy HTTPS;
- terms HTTPS;
- primary logo;
- composer icon para pacote compatível com Codex.

Logo/icon devem ser quadrados, >= 48×48, <= 4096×4096 quando raster e <= 5 MiB.

Telechir não versiona assets finais na Phase 11 porque identidade visual/domínio comercial ainda são gates separados. O builder exige os arquivos finais como inputs externos.

## Remote MCP público

Public review exige um endpoint:

- público;
- HTTPS;
- estável;
- não local/test;
- Streamable HTTP;
- normalmente em `/mcp`;
- com autenticação/autorização preservadas;
- com logs/métricas operacionais sem secrets;
- com disponibilidade suficiente para review.

Secure MCP Tunnel serve para desenvolvimento privado, mas não substitui endpoint público de produção na submissão.

## Domain verification

O portal gera um challenge. O host deve servir exatamente o token em:

```text
GET /.well-known/openai-apps-challenge
```

A resposta é plain text com o valor exato.

A Phase 11 implementa essa rota usando `OPENAI_APPS_CHALLENGE_TOKEN` fornecido externamente. Sem token válido a rota retorna 404; não existe default versionado.

## OAuth/OIDC

Telechir já implementa o resource-server boundary:

- OAuth bearer verificado;
- issuer/audience;
- PKCE S256 exigido na metadata do authorization server;
- scopes por tool;
- ownership;
- local policy como autoridade final.

Para integração OpenAI atual, OAuth 2.1 continua esperado quando há dados privados/write.

A documentação atual também recomenda/define para workspace domain restrictions:

- OpenID Connect discovery;
- scopes `openid` e `email` anunciados e habilitados;
- UserInfo Endpoint;
- retorno de `email`;
- `email_verified: true`.

Isso é responsabilidade do IdP/authorization server externo, não do Remote MCP resource server. A Phase 11 registra como gate externo e **não constrói authorization server próprio**.

## Tool metadata

Todas as tools precisam:

- nome claro;
- description fiel ao comportamento;
- input mínimo/purpose-driven;
- output minimizado;
- `securitySchemes` explícito;
- `readOnlyHint` explícito;
- `destructiveHint` explícito;
- `openWorldHint` explícito.

As 16 tools atuais já materializam essas annotations a partir de `specs/tools/tool-catalog.json`.

### Observação sobre justification

Há uma inconsistência transitória nas páginas oficiais consultadas em 2026-10-05:

- a página atual de plugin guidelines diz que annotation justifications não são mais requeridas no descriptor;
- a referência de submission errors ainda lista `justification_required` para final submission.

A decisão conservadora do Telechir é:

1. não inventar campos não padronizados no MCP descriptor;
2. manter as três annotations booleanas explícitas;
3. preservar justificativas humanas em `plugins/openai/telechir/review/tool-annotations.json` para portal/review/appeal se solicitado;
4. revalidar o portal imediatamente antes da submissão.

## Review inicial

Remote MCP review exige exatamente:

- **5 positive test cases**;
- **3 negative test cases**;
- demo recording URL;
- release notes;
- reviewer-ready demo credentials quando OAuth é usado.

Credentials e reviewer instructions não devem entrar no package ZIP; são preenchidos no portal seguro.

Os casos positivos devem declarar:

- description;
- prompt;
- `tools_triggered`;
- `expected_behavior`.

Os casos negativos descrevem solicitações em que o plugin não deve agir e o reviewer deve observar refusal, clarification ou safe fallback.

## Review account

Para servidor autenticado, o reviewer deve receber uma conta demo completa com sample data e sem passos inacessíveis:

- sem MFA dependente de pessoa;
- sem SMS/email verification indisponível;
- sem rede privada/VPN;
- sem dados pessoais/produção.

Telechir define dataset sintético em `plugins/openai/telechir/review/demo-account.md`.

## Privacy

A privacy policy publicada precisa explicar, no mínimo:

- categorias de personal data;
- finalidades;
- categorias de recipients;
- retention;
- user controls.

A guideline atual reforça data minimization e proíbe coleta de auth secrets/credentials como input funcional do plugin.

O desenho Telechir permanece alinhado: bearer não vai ao agent e tool outputs não devem ecoar IDs internos/telemetria/secrets sem necessidade.

## Atualização de MCP após publicação

Depois da publicação inicial, alterações no servidor MCP hospedado podem ser escaneadas diretamente. Tool changes ficam sujeitas a scan e findings; metadata/package/skills continuam exigindo atualização do ZIP quando aplicável.

Contratos publicados devem permanecer backward-compatible durante o ciclo de scan/review.

## Gates internos concluíveis na Phase 11

- tool annotations/securitySchemes auditados;
- domain challenge implementado/testado;
- package source;
- builder determinístico;
- 5 positive + 3 negative;
- demo-account specification;
- checklist de submission;
- external readiness checker;
- docs/threat model/exit review;
- regressões do control plane;
- nenhum deploy remoto.

## Gates externos que permanecem abertos

- publisher verification;
- `api.apps.write/read`;
- domínio final;
- website/support/privacy/terms públicos;
- assets finais;
- MCP de produção;
- domain verification real;
- IdP OIDC/UserInfo;
- reviewer account real;
- demo recording;
- tool scan de produção;
- submission;
- approval;
- publicação;
- disponibilidade real no Plus;
- quota/metering.

Portanto, o resultado correto da Phase 11 é **`PHASE_11_SUBMISSION_READY`**, não “plugin publicado”.

## Fontes oficiais revalidadas

- https://developers.openai.com/plugins
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/plugin-guidelines
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/deploy/app-review
- https://developers.openai.com/plugins/deploy/submission-errors
- https://openai.com/business/plugins/remote-desktop-commander/
