# Telechir — Pesquisa e Arquitetura

Repositório de pesquisa, discovery de produto e arquitetura para uma futura plataforma que permita que clientes de IA autorizados operem computadores e ambientes executáveis por meio de uma camada de controle segura e auditável.

> **Estado do projeto:** discovery e **Phases 0–14 concluídas**, incluindo Local Agent Core, control plane, Pairing/Device Identity, Device Realtime Channel, Remote MCP/OAuth, Filesystem Tools, Shell/Process Lifecycle, Basic Git read-only, Policy/Approvals/Audit, Dashboard MVP, readiness técnica do plugin público OpenAI, Sandbox mode Docker opt-in, Computer use Windows tipado/bounded e Browser automation Playwright isolada. Não existe deploy de produção nem plugin submetido/aprovado; **Phase 15 — Multi-device/workspace concurrency** é a próxima fase de implementação. Os gates externos de publicação OpenAI e o `COMMERCIAL_CLEARANCE_PENDING` da marca permanecem abertos.

## Por que este repositório existe

O projeto investiga uma camada de execução agnóstica a modelos que possa conectar clientes como ChatGPT, Codex, Claude, Gemini, Copilot e ferramentas compatíveis com MCP a máquinas autorizadas, tratando identidade do dispositivo, permissões, aprovações, auditoria, revogação e futuro sandboxing como preocupações de primeira classe.

Este repositório é a fonte de verdade para:

- pesquisa de mercado e ecossistema;
- discovery e posicionamento de produto;
- estudos de viabilidade técnica;
- decisões arquiteturais e ADRs;
- segurança e threat modeling;
- naming e estratégia de marca;
- histórico de como a ideia e as decisões evoluíram;
- artefatos e datasets de pesquisa;
- futuro roadmap de implementação.

## Princípios atuais

- **Agnóstico a modelos:** a camada de execução não deve depender de um único provedor de LLM.
- **Menor privilégio:** a política local deve continuar sendo a autoridade final.
- **Conectividade outbound-first:** evitar exigir portas de entrada abertas nas máquinas do usuário.
- **Typed tools primeiro:** preferir operações explícitas de filesystem, processos e Git a uma interface irrestrita de “execute qualquer coisa”.
- **Auditabilidade:** ações remotas devem ser atribuíveis, revisáveis e revogáveis.
- **Isolamento progressivo:** diferenciar execução no host, guarded host e sandbox.
- **Pesquisa antes da implementação:** gates não resolvidos de plataforma, segurança e naming devem ser documentados antes do código.
- **Preservação da linhagem:** pesquisas superadas continuam registradas como evidência histórica.

## Mapa do repositório

- `PROJECT_STATE.md` — fase atual, gates e estado da implementação.
- `AGENTS.md` — regras para agentes de IA que trabalhem neste repositório.
- `agent/` — core Rust do Local Agent, identidade Ed25519, cliente realtime outbound, filesystem executor, shell/process lifecycle, Basic Git read-only, policy/approval local, sandbox Docker opt-in, Computer use Windows com FFI isolado e Browser automation via sidecar Playwright, implementados nas Phases 1, 3, 4, 6, 7, 8, 9, 12, 13 e 14.
- `apps/control-plane/` — control plane TypeScript/Cloudflare com D1, pairing, Durable Object/WebSocket realtime, Remote MCP/OAuth, dispatch de filesystem/process/Git/Computer use/Browser, governança de policy/approvals/audit e API autenticada do Dashboard, evoluído nas Phases 2–14.
- `apps/dashboard/` — Dashboard MVP React/TypeScript para devices, approvals, command/audit timeline, usage/health e revogação, implementado na Phase 10.
- `plugins/openai/telechir/` — fonte do package público OpenAI, builder fail-closed, review cases e checklists de submission da Phase 11; não contém credentials nem release ZIP versionado.
- `docs/` — documentação viva de produto, discovery, arquitetura, segurança, testes e histórico.
- `docs/history/research-lineage.md` — narrativa de como o projeto nasceu e por que decisões importantes mudaram.
- `artifacts/` — snapshots datados, relatórios e datasets estruturados.
- `artifacts/provenance/` — rastreabilidade entre os artefatos originados no ChatGPT e suas representações no repositório.

## Linhagem da pesquisa

O projeto começou com uma observação prática: após o esgotamento de uma quota principal de coding agent, o Remote Desktop Commander ainda expunha filesystem e processos úteis a partir do ChatGPT. Isso levou a um censo mais amplo de 181 ferramentas e arquiteturas, a um primeiro blueprint completo, a uma correção importante sobre distribuição via ChatGPT Plus/plugin público e a múltiplas rodadas de naming, incluindo uma Stage 2 com 560 nomes construídos que não superaram Telechir em autenticidade e fit.

Veja `docs/history/research-lineage.md` para a narrativa completa.

## Cobertura dos artefatos

Os trabalhos originados neste chat produziram datasets e relatórios de censo, blueprint técnico, pesquisas de naming, exports de candidatos e uma imagem de referência. Cada artefato único está representado diretamente ou por uma representação canônica/normalizada com proveniência registrada em:

- `artifacts/provenance/source-manifest.json`
- `artifacts/provenance/coverage.md`

Exports intermediários grandes de naming são preservados como fontes e também consolidados em `artifacts/datasets/naming/canonical-naming-candidates.csv`.

## Convenção de idioma

- **nomes de arquivos e diretórios:** inglês;
- **conteúdo documental:** português do Brasil;
- **identificadores técnicos, comandos, nomes de produtos, APIs e campos de schemas:** mantidos em inglês quando isso melhora interoperabilidade ou precisão.

Veja `docs/language-and-naming-conventions.md`.

## Observações importantes

O repositório físico já foi renomeado para **`telechir`**, alinhando o namespace do projeto à marca oficial.

A estratégia de licenciamento do core foi definida em `docs/architecture/adr/0005-open-source-licensing-strategy.md`: **Apache License 2.0** para o core público, com marca Telechir tratada separadamente. O arquivo `LICENSE` já está na raiz; snapshots históricos em `artifacts/` continuam sujeitos às observações de proveniência e não devem ser tratados automaticamente como core distribuível.

## Contribuição

O projeto concluiu discovery e as Phases 0–14. Consulte `CONTRIBUTING.md` e `PROJECT_STATE.md` antes de propor implementação ou avançar para uma nova fase.

## Segurança

Não publique secrets, credenciais, tokens, detalhes privados de infraestrutura ou relatos de vulnerabilidade acionáveis em issues públicas. Consulte `SECURITY.md`.
