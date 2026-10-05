# Phase 11 Exit Review — OpenAI Public Plugin Submission Readiness

**Data:** 2026-10-05

**Branch:** `phase11/openai-plugin-readiness`

**Issue:** #38

**Resultado:** `PHASE_11_SUBMISSION_READY` na branch; integração em `main` pendente até o merge.

## Escopo entregue

A Phase 11 revalida o caminho público ChatGPT/Codex + Remote MCP e prepara os artefatos versionáveis necessários para futura submissão.

Ela **não** realiza:

- deploy remoto;
- domain verification real;
- tool scan de produção;
- upload no portal;
- submission;
- review;
- approval;
- publish;
- validação de Plus no plugin Telechir;
- medição de quota/metering.

Portanto, `OPENAI-PRODUCT-001`, `OPENAI-PRODUCT-002` e `OPENAI-QUOTA-001` continuam abertos.

## Revalidação oficial

Fontes OpenAI vigentes em 2026-10-05 confirmam:

- diretório universal de plugins para ChatGPT/Codex;
- package ZIP;
- formato portátil recomendado `plugin.json + mcp.json`;
- Remote MCP público via Streamable HTTP/HTTPS estável;
- publisher identity verificada;
- domain challenge;
- MCP scan;
- annotations explícitas;
- OAuth 2.1 para private data/write;
- 5 positive + 3 negative cases no review inicial de um MCP;
- demo recording;
- reviewer credentials separadas do package;
- website/support/privacy/terms e icons no fluxo final.

A nota canônica está em `docs/research/openai/phase11-public-plugin-revalidation-2026-10-05.md`.

## Control plane

### Domain verification route

Adicionado:

```text
GET /.well-known/openai-apps-challenge
```

Características:

- token somente por `OPENAI_APPS_CHALLENGE_TOKEN`;
- nenhum default versionado;
- resposta exata em `text/plain`;
- `cache-control: no-store`;
- GET-only;
- sem token/malformed -> 404;
- método diferente -> 405;
- não aparece em health/version;
- caracteres imprimíveis como `+`, `/` e `=` são preservados;
- control chars e whitespace periférico falham fechado.

O challenge não integra `coreBindingsReady`, pois sua ausência não deve derrubar o runtime normal fora de um processo de verification.

### MCP descriptor

Os testes passam a confirmar no wire:

- 16 tools públicas;
- `securitySchemes` por tool;
- `readOnlyHint`;
- `destructiveHint`;
- `openWorldHint`;
- input/output schemas.

Nenhum catálogo de tool ou protocolo do agent foi ampliado nesta fase.

## Package source

Criado `plugins/openai/telechir/`.

Fonte versionada:

- `package-base.json`;
- `release-config.example.json`;
- `release-readiness.example.json`;
- builder e readiness checker;
- testes;
- submission checklist;
- demo-account specification;
- tool annotation review.

Arquivos reais ignorados:

- `dist/`;
- `release-config.json`;
- `release-readiness.json`.

### Manifest

O builder produz:

```text
plugin.json
mcp.json
assets/logo.<svg|png>
assets/composer-icon.<svg|png>
```

`plugin.json` usa:

```text
https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
```

`mcp.json` usa:

```text
https://agent-plugins.org/schemas/1.0.0/mcp.schema.json
```

e declara um único server:

```json
{
  "type": "streamable-http",
  "url": "https://<production-host>/mcp"
}
```

O package não inclui `.app.json`, hooks, reviewer credentials ou source tree operacional.

## Builder fail-closed

Implementado em Python stdlib, sem nova dependency de supply chain.

Valida:

- campos externos obrigatórios;
- allowlist de chaves;
- rejeição de secret-like fields;
- HTTPS;
- limite de 1024 caracteres em URLs;
- ausência de embedded credentials/query/fragment;
- rejeição de localhost, hosts reservados e IP privado;
- `mcp_url` em path exato `/mcp`;
- developer name/email;
- semantic version;
- package name;
- listing limits;
- category;
- capabilities;
- starter prompts;
- colors e contraste mínimo 2:1;
- exactly 5 positive + 3 negative cases;
- release notes;
- assets SVG/PNG;
- square 48–4096;
- <= 5 MiB;
- SVG sem script/foreignObject/event handlers/active external refs.

A leitura de JSON aceita UTF-8 com ou sem BOM, importante para PowerShell/Windows. A saída permanece UTF-8 normalizada.

O ZIP é determinístico:

- nomes ordenados;
- timestamp normalizado;
- permissões normalizadas;
- somente quatro entries permitidas.

## Review materials

### Positive cases — 5

1. list devices;
2. read sample file;
3. Git status;
4. bounded file write com approval;
5. harmless bounded command.

### Negative cases — 3

1. delete de arquivo não exposto;
2. arbitrary network download/execute negado;
3. elevation/admin/firewall fora da capability.

### Reviewer account

Especificado dataset sintético:

- `Review Device`;
- root `/workspace/review`;
- `hello.txt`;
- sample Git repo;
- bounded write target;
- `echo telechir-review`.

Credentials reais continuam exclusivamente no portal.

## External readiness checker

`check_readiness.py` exige evidência para 11 gates:

1. publisher verified;
2. OpenAI app project permissions;
3. listing URLs públicas;
4. final assets;
5. production MCP;
6. domain verification;
7. OIDC openid/email;
8. UserInfo verified email;
9. reviewer demo account;
10. demo recording;
11. current production tool scan.

O exemplo versionado mantém todos como `false`.

Com o exemplo:

```text
status = EXTERNAL_GATES_PENDING
exit = 3
```

O builder também rejeita deliberadamente `release-config.example.json` por usar host reservado.

## Evidências — plugin tooling

```text
py -3 -m py_compile scripts/build_package.py scripts/check_readiness.py tests/test_build_package.py
py -3 -m unittest discover -s tests -v
```

Resultado:

- **14 testes**, 0 falhas;
- deterministic ZIP: PASS;
- exact tool-annotation coverage: PASS;
- negative validation cases: PASS;
- UTF-8 BOM config: PASS;
- external readiness pending by default: PASS.

### CLI end-to-end sintético

Config/assets foram criados em `%TEMP%`, fora do repositório e sem network/deploy.

Resultado:

```text
entries=assets/composer-icon.svg,assets/logo.svg,mcp.json,plugin.json
size=2562
sha256=1af4f5d10c214631b781c411357d725c7059a15ea7848b7a36571fd18b59ed74
```

O hash é evidência da execução sintética específica; não representa futuro release oficial.

## Evidências — control plane

```text
npm run format:check
npm run typecheck
npm test
npm run dry-run
npm audit --audit-level=high
```

Resultados:

- format: PASS;
- TypeScript strict: PASS;
- 15 test files: PASS;
- **94 testes**, 0 falhas;
- worker challenge coverage incluída;
- MCP annotations/securitySchemes no wire validados;
- Wrangler dry-run: PASS;
- bundle: **860,84 KiB / gzip 166,05 KiB**;
- npm audit: **0 vulnerabilidades**;
- deploy remoto: não executado.

## Evidências — D1

Base local nova:

- `0001_initial.sql`: PASS — 23 commands;
- `0002_pairing_identity.sql`: PASS — 12 commands;
- `0003_oauth_identity_uniqueness.sql`: PASS — 2 commands;
- `0004_policy_approval_audit.sql`: PASS — 5 commands.

Nenhuma migration nova foi necessária na Phase 11.

## Evidências — Dashboard

Regressão completa embora nenhum arquivo Dashboard tenha sido alterado:

- format: PASS;
- typecheck: PASS;
- **2 testes**, 0 falhas;
- production build: PASS;
- JS: 232,41 KiB / gzip 72,35 KiB;
- npm audit: **0 vulnerabilidades**.

## Evidências — Agent Rust

Nenhum arquivo Rust/protocolo foi alterado.

```text
cargo test --locked --all-features
```

Resultado:

- 72 unit tests: PASS;
- 2 identity/cross-language contracts: PASS;
- 7 protocol contracts: PASS;
- total **81 testes**, 0 falhas.

O source foi montado read-only e o target ficou em volume Docker.

## Threat model

Delta:

`docs/security/threat-model/phase11-openai-plugin-readiness-2026-10-05.md`

Cobre:

- package supply chain;
- release config;
- domain challenge;
- reviewer credentials;
- annotations;
- OAuth/OIDC boundary;
- privacy/minimization;
- external readiness evidence;
- ambiguity oficial sobre annotation justifications.

## Boundaries preservados

Não adicionados:

- tool nova;
- Git mutável;
- shell irrestrito;
- Network permission;
- elevation/admin;
- secret broker;
- sandbox;
- screen/browser/computer-use;
- MCP UI;
- authorization server próprio;
- deploy de produção.

## Definition of Done

- [x] requisitos oficiais revalidados;
- [x] 16 tools auditadas;
- [x] annotations/securitySchemes testadas no wire;
- [x] challenge route fail-closed;
- [x] portable package source;
- [x] deterministic fail-closed builder;
- [x] 5 positive + 3 negative cases;
- [x] reviewer dataset/checklist;
- [x] external readiness checker;
- [x] reviewer credentials fora do repo/ZIP;
- [x] package synthetic build prova estrutura;
- [x] threat model;
- [x] control-plane full gates;
- [x] D1 clean migrations;
- [x] Dashboard regression;
- [x] Rust/protocol regression;
- [x] nenhum deploy remoto;
- [x] gates externos não foram falsamente marcados como completos.

## Decisão

A Phase 11 atende ao escopo da issue #38 e pode ser marcada **`PHASE_11_SUBMISSION_READY`** após integração desta branch.

Este estado significa que o repositório está preparado para receber os inputs reais e executar o fluxo de futura submissão. Não significa `SUBMISSION_READY` operacional no checker de release: os 11 gates externos continuam pendentes.

O próximo item do roadmap de implementação é **Phase 12 — Sandbox mode**. Os gates externos OpenAI podem avançar em paralelo quando domínio, publisher, produção e assets estiverem disponíveis.
