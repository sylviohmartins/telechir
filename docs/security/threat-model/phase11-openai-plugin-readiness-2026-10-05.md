# Phase 11 Threat Model Delta — OpenAI Public Plugin Readiness

**Data:** 2026-10-05

**Base:** `stride-baseline-2026-10-02.md`, Phase 9 policy/approvals/audit e Phase 10 Dashboard

**Escopo:** package público, domain verification e processo de submission/review OpenAI. Nenhum deploy de produção é realizado nesta fase.

## Objetivo

A Phase 11 prepara o Telechir para uma futura submissão pública sem transformar artefatos de release em nova autoridade operacional.

O invariante permanece:

> O plugin distribui acesso ao Remote MCP. OAuth, ownership, cloud governance e policy local continuam sendo as fronteiras de autorização; metadata de package, reviewer credentials ou um domain challenge nunca concedem autoridade ao agent.

## Novos ativos e trust boundaries

### Package público

O ZIP final contém apenas:

- `plugin.json`;
- `mcp.json`;
- logo;
- composer icon.

Ele não contém:

- source tree;
- environment files;
- reviewer credentials;
- OAuth tokens;
- domain challenge;
- private keys;
- runtime logs;
- `.app.json`;
- lifecycle hooks;
- operational `dist/`;
- `node_modules/`.

O package é configuração de distribuição, não credencial.

### Release inputs

URLs públicas, publisher name e asset paths entram por `release-config.json`, arquivo deliberadamente ignorado pelo Git.

O builder:

- aceita somente chaves conhecidas;
- rejeita campos secret-like;
- rejeita credential embutida em URL;
- exige HTTPS;
- rejeita localhost, TLDs reservados e IPs não públicos;
- exige `/mcp` como path canônico;
- valida assets antes de copiá-los;
- produz ZIP determinístico.

Isso reduz risco de vazar configuração local ou empacotar conteúdo arbitrário por engano.

### Domain challenge

A nova rota:

```text
GET /.well-known/openai-apps-challenge
```

obtém o token somente de `OPENAI_APPS_CHALLENGE_TOKEN`.

Controles:

- nenhuma constante/default de produção;
- token ausente/malformado retorna 404;
- método diferente de GET retorna 405;
- resposta válida é o valor exato em `text/plain`;
- `cache-control: no-store`;
- token não participa de `/health`, `/ready` ou `/version`;
- challenge não entra no command envelope, D1 ou agent.

O runtime não presume base64url: caracteres imprimíveis como `+`, `/` e `=` são preservados. Whitespace periférico e control characters são rejeitados porque impediriam correspondência exata e poderiam criar header/body ambiguity.

### Reviewer credentials

Reviewer username/password/instructions permanecem fora do ZIP e do repositório.

A especificação de demo account versionada contém somente:

- shape do dataset;
- paths sintéticos;
- expected behavior;
- limites de policy.

Credenciais reais são inseridas apenas no formulário seguro do portal de review.

## Tool metadata e selection safety

As 16 tools públicas continuam derivadas de `specs/tools/tool-catalog.json`.

Cada uma declara explicitamente:

- `readOnlyHint`;
- `destructiveHint`;
- `openWorldHint`;
- `securitySchemes`.

A Phase 11 testa que essas annotations chegam ao descriptor MCP real, não apenas ao catálogo estático.

### Open-world conservador

Filesystem, device info e Git local permanecem `openWorldHint: false` porque operam sobre recursos privados e bounded.

`run_command`, `start_process` e `write_process_input` permanecem conservadoramente `openWorldHint: true`. A policy local bloqueia network permission e executáveis comuns de rede, porém um processo explicitamente aprovado ainda é uma superfície geral de execução e não deve ser descrito ao host como incapaz de interagir externamente.

### Destructive semantics

Write/patch/process-input/process-start e cancelamento mantêm `destructiveHint: true` quando um efeito pode sobrescrever estado, iniciar side effects ou encerrar um processo. Confirmation UX do host não substitui authorization/approval no Telechir.

## OAuth/OIDC

Nenhum novo authorization server é criado.

Telechir continua verificando:

- token;
- issuer;
- audience/resource;
- expiry/nbf;
- scopes;
- user binding;
- device ownership.

Para workspace-domain restrictions da OpenAI, OIDC `openid/email` e UserInfo com `email_verified=true` são gates de configuração do IdP externo.

Risco evitado: implementar rapidamente um authorization server próprio apenas para review criaria uma segunda superfície crítica de credenciais e sessão. Essa alternativa permanece fora do escopo.

## Privacy e minimização

A futura privacy policy deve corresponder ao tráfego real. Review deve auditar todos os campos de tool output, inclusive nested/debug metadata.

Controles existentes permanecem:

- bearer nunca vai ao agent;
- audit metadata é bounded/redigida;
- outputs não devem retornar IDs internos desnecessários;
- tool inputs não solicitam passwords/API keys;
- package não contém reviewer credentials.

O package builder não valida o conteúdo jurídico da privacy policy; apenas exige uma URL HTTPS pública. Correspondência entre policy e comportamento é gate humano/review.

## Abuse cases

| Cenário | Controle Phase 11 |
|---|---|
| package inclui credential | allowlist de campos + secret-like rejection + ZIP minimal |
| release config aponta para localhost/test | public HTTPS validator falha fechado |
| MCP URL troca path para endpoint arbitrário | exige path exato `/mcp` |
| asset SVG executa script/referência externa | parser rejeita script, foreignObject, handlers e href ativo |
| token de domain verification vaza em health/version | rota isolada + testes de não exposição |
| challenge com formato não previsto é alterado | valor imprimível é preservado exatamente |
| POST tenta usar challenge como API | 405 GET-only |
| host trata write como read-only | descriptor wire é testado contra catalog annotations |
| docs de annotation divergem do catálogo | review file possui cobertura exata das 16 tools, validada por teste |
| reviewer usa conta pessoal | checklist exige conta dedicada/dados sintéticos |
| reviewer credential é commitada | credencial é proibida no package e release inputs reais são ignored |
| submission é marcada pronta sem produção/OIDC/scan | external readiness checker exige 11 gates com evidência |
| metadata do package cria autoridade | nenhuma metadata altera scopes, policy, approval ou agent |

## Supply-chain e determinismo

O package builder usa somente Python stdlib, evitando dependência nova de build para um artefato sensível de release.

ZIP determinístico:

- entries ordenadas;
- timestamp normalizado;
- permissões normalizadas;
- somente arquivos construídos/copied explicitamente.

Determinismo não prova segurança do conteúdo, mas permite comparar hashes entre builds de mesmos inputs e reduz alteração acidental invisível.

## Gates externos deliberadamente abertos

A Phase 11 não consegue provar localmente:

- verified publisher identity;
- OpenAI project permissions;
- domínio final;
- URLs legais realmente publicadas;
- assets de marca finais;
- MCP de produção;
- domain verification aceita pelo portal;
- IdP OIDC/UserInfo real;
- demo account real;
- demo recording real;
- tool scan real;
- review/approval/publicação;
- Plus availability;
- quota/metering.

O checker `release-readiness.example.json` mantém esses gates falsos por padrão e exige evidência textual quando um operador os marca como concluídos.

## Official-doc ambiguity

Em 2026-10-05, plugin guidelines indicam que annotation justifications não precisam mais estar no descriptor, enquanto a referência de submission errors ainda possui erro relacionado a justification.

Telechir não adiciona extensão MCP inventada. Mantém justificativas humanas separadas em `review/tool-annotations.json` para uso operacional se o portal/reviewer solicitar, e exige revalidação da documentação/portal antes do upload final.

## Riscos residuais

- o domínio/IdP de produção ainda não existe nesta fase;
- o builder não substitui o validator oficial do portal;
- uma URL HTTPS pode apontar para conteúdo inadequado mesmo passando validação sintática;
- o package source pode ficar desatualizado se a OpenAI mudar schema/limites;
- reviewer dataset precisa ser resetável e disponível durante todo o review;
- process tools continuam uma superfície poderosa apesar de scopes/policy/approval;
- uma privacy policy incorreta não é detectável por teste de código.

## Resultado de segurança esperado

A Phase 11 só pode declarar **`PHASE_11_SUBMISSION_READY`** no sentido de que código, metadata source, package tooling e materiais de review estão preparados para receber inputs reais.

Ela não pode declarar plugin publicado, aprovado, domain-verified ou disponível no Plus sem evidência externa.
