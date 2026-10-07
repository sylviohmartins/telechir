# Estado do Projeto

**Atualizado em:** 2026-10-06

## Fase atual

**Discovery concluído / Phases 0–14 concluídas / Phase 14 — Browser automation concluída**

A implementação possui Local Agent Core, control plane, identidade/pairing Ed25519, canal realtime outbound, Remote MCP/OAuth, seis typed filesystem tools, shell/process lifecycle, Basic Git read-only, governança de policy/approvals/audit, Dashboard MVP, tooling fail-closed para package/review do plugin público OpenAI, sandbox Docker local opt-in, Computer use tipado/bounded no Windows e Browser automation Playwright isolada com egress anti-SSRF. A superfície MCP pública possui 24 tools. O projeto **não possui deploy de produção**, plugin submetido, aprovado ou publicado.

## Gates atuais

- [x] Naming discovery: **`NAME_READY` — produto oficialmente chamado Telechir**.
- [~] Clearance jurídico/comercial da marca: **`COMMERCIAL_CLEARANCE_PENDING`** — domínio, packages, handles e trademark precisam de consulta/reserva autoritativa antes de lançamento.
- [x] ChatGPT/Codex public-plugin path: arquitetura revalidada em 2026-10-05; package/review tooling do Telechir em **`PHASE_11_SUBMISSION_READY`**.
- [~] Publicação OpenAI do plugin próprio: **`EXTERNAL_GATES_PENDING`** — publisher/permissões, domínio/URLs/assets, produção, verification/OIDC, reviewer materials, scan, submission/review/approval, Plus availability e quota precisam de evidência real.
- [x] Blueprint técnico/de produto v2 consolidado.
- [x] Estratégia de licenciamento/open source definida em ADR-0005.
- [x] Acceptance criteria formais do vertical slice MVP.
- [x] Definition of Ready para Phase 0: **`READY_FOR_PHASE_0`**.
- [x] Phase 0 — Repository & Protocol Specifications: **`PHASE_0_COMPLETE`**.
- [x] Exit review da Phase 0: **`READY_FOR_PHASE_1`**.
- [x] Phase 1 — Local Agent Core: **`PHASE_1_COMPLETE`**.
- [x] Phase 2 — Hosted Control-Plane Skeleton: **`PHASE_2_COMPLETE`**.
- [x] Phase 3 — Pairing and Device Identity: **`PHASE_3_COMPLETE`**.
- [x] Phase 4 — Device Realtime Channel: **`PHASE_4_COMPLETE`**.
- [x] Phase 5 — Remote MCP Integration and OAuth: **`PHASE_5_COMPLETE`**.
- [x] Phase 6 — Filesystem Tools: **`PHASE_6_COMPLETE`**.
- [x] Phase 7 — Shell/Process Lifecycle: **`PHASE_7_COMPLETE`**.
- [x] Phase 8 — Basic Git: **`PHASE_8_COMPLETE`**.
- [x] Phase 9 — Policy, Approvals and Audit: **`PHASE_9_COMPLETE`**.
- [x] Phase 10 — Dashboard: **`PHASE_10_COMPLETE`**.
- [x] Phase 11 — ChatGPT/Codex public-plugin submission readiness: **`PHASE_11_SUBMISSION_READY`**.
- [x] Phase 12 — Sandbox mode: **`PHASE_12_COMPLETE`**.
- [x] Phase 13 — Computer use: **`PHASE_13_COMPLETE`**.
- [x] Phase 14 — Browser automation: **`PHASE_14_COMPLETE`**.
- [ ] Phase 15 — Multi-device/workspace concurrency não iniciada.

## Decisões atuais

- **Telechir é a marca oficial do produto.**
- O repositório físico já foi renomeado para `telechir`.
- Naming criativo está encerrado; nova rodada só ocorre se surgir impedimento material/jurídico.
- O produto é agnóstico a modelos e multi-IA por design.
- Distribuição no ChatGPT/Codex: plugin público + Remote MCP; o caminho técnico está preparado para package/submission, mas publisher verification, produção, review, publicação, availability por plano e quota continuam gates externos.
- Cloudflare foi aceito como primeiro control plane hospedado em ADR-0004, mantendo protocolo e agent independentes do provedor.
- O agent local aplica a autoridade final de policy.
- Approval remoto pode restringir o dispatch, mas nunca se transforma em autoridade local do agent.
- Operações `CRITICAL` permanecem fail-closed por default; `computer.input` é a primeira exceção explícita e só executa após confirmação humana local session/digest/TTL-bound no próprio device.
- `guarded_host` permanece o execution mode default; `sandbox` é opt-in, exige `sandbox.docker` e nunca faz fallback para host.
- Sandbox Docker é defense-in-depth, não VM boundary nem substituto de policy/approval.
- Computer use one-shot/single-action entrou na Phase 13 somente no Windows.
- Browser automation entrou na Phase 14 como authority `BROWSER` própria, com seis tools tipadas, context Playwright efêmero/non-persistent e egress proxy anti-SSRF; ela não implica `INPUT_CONTROL`, `NETWORK`, filesystem, clipboard ou secrets.
- Streaming de tela, clipboard, persistent authenticated browser, raw JavaScript/CDP/WebDriver/BiDi passthrough, uploads/downloads e adapters macOS/Linux de Computer use permanecem fora do escopo atual.
- O core público usa **Apache License 2.0**, com trademark Telechir separado; `LICENSE` já está na raiz.
- Artefatos históricos permanecem imutáveis; conclusões atuais vivem em `docs/`.
- Artefatos originados no ChatGPT são rastreados em `artifacts/provenance/source-manifest.json`.

## Estado do naming

- 2026-09-29: Telechir chegou a `NAME_CONDITIONAL`.
- 2026-10-01, palavras reais: Grapnel, Skeg, Nervo, Prehend e Hawse bloqueados por colisões.
- 2026-10-01, Stage 2: 560 nomes construídos; nenhum superou Telechir.
- 2026-10-01, Stage 3: screening final preliminar; sem colisão contemporânea material em AI/dev tooling.
- 2026-10-02, Stage 4: **Telechir selecionado definitivamente; gate `NAME_READY`.**
- Clearance comercial permanece separado como `COMMERCIAL_CLEARANCE_PENDING`.

## Identidade atual

**Produto:** Telechir  
**Descriptor:** *Secure computer control for AI agents*  
**Tagline:** *Give AI a secure hand on your machines.*

## Rejeições explícitas

- **MachinaPort** como nome de produto. Permanece somente em snapshots históricos.

## Readiness

As avaliações relevantes estão em:

- `docs/testing/acceptance/definition-of-ready-2026-10-02.md`
- `docs/testing/acceptance/phase0-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase0-contract-audit-2026-10-02.md`
- `docs/testing/acceptance/phase1-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase2-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase3-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase4-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase5-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase6-exit-review-2026-10-03.md`
- `docs/testing/acceptance/phase7-exit-review-2026-10-04.md`
- `docs/testing/acceptance/phase8-exit-review-2026-10-04.md`
- `docs/testing/acceptance/phase9-exit-review-2026-10-05.md`
- `docs/testing/acceptance/phase10-exit-review-2026-10-05.md`
- `docs/testing/acceptance/phase11-exit-review-2026-10-05.md`
- `docs/testing/acceptance/phase12-exit-review-2026-10-05.md`
- `docs/testing/acceptance/phase13-exit-review-2026-10-06.md`
- `docs/testing/acceptance/phase14-exit-review-2026-10-07.md`
- `docs/security/threat-model/phase9-policy-approvals-audit-2026-10-05.md`
- `docs/security/threat-model/phase10-dashboard-2026-10-05.md`
- `docs/security/threat-model/phase11-openai-plugin-readiness-2026-10-05.md`
- `docs/security/threat-model/phase12-sandbox-mode-2026-10-05.md`
- `docs/security/threat-model/phase13-computer-use-2026-10-05.md`
- `docs/security/threat-model/phase14-browser-automation-2026-10-07.md`
- `docs/research/openai/phase11-public-plugin-revalidation-2026-10-05.md`
- `docs/research/docker/phase12-sandbox-revalidation-2026-10-05.md`
- `docs/research/computer-use/phase13-platform-revalidation-2026-10-05.md`
- `docs/research/browser-automation/phase14-playwright-revalidation-2026-10-07.md`
- `docs/research/cloudflare/phase2-revalidation-2026-10-02.md`
- `docs/research/cloudflare/phase4-revalidation-2026-10-02.md`
- `docs/research/mcp/phase5-revalidation-2026-10-02.md`

Resultado atual:

> **PHASE_14_COMPLETE**

A Phase 14 adiciona seis browser tools tipadas à superfície MCP, elevando o total para **24 tools** sem criar novo Device Wire message type: `open_browser_session`, `get_browser_snapshot`, `navigate_browser`, `click_browser`, `fill_browser` e `close_browser_session`. Todas exigem exatamente `BROWSER` e risk floor `HIGH`; side effects exigem idempotency. Browser authority permanece separada de `INPUT_CONTROL` e `NETWORK`.

O adapter inicial usa Playwright 1.63.0 como subprocesso stdio local. Ele cria `BrowserContext` não persistente, não reutiliza profile/cookies/`storageState`, bloqueia downloads/service workers/WebSockets e usa proxy de egress próprio com DNS/range validation para bloquear localhost, private/link-local/metadata e demais destinos não públicos. Raw JavaScript, CSS/XPath, CDP, WebDriver/BiDi passthrough, clipboard, cookies/storage, uploads/downloads e secret injection não fazem parte da surface.

Capabilities só são anunciadas se o sidecar passa health e consegue lançar Chromium. `chromiumSandbox=true` é obrigatório; a prova root falhou fechado e o smoke válido foi executado como usuário não-root. O hardened smoke comprovou open/navigate/snapshot/fill/click/close e bloqueou redirect, subresource e WebSocket para `localhost`, com **0 hits** no endpoint protegido e **0 upgrades**.

Os gates finais e números exatos estão em `docs/testing/acceptance/phase14-exit-review-2026-10-07.md`. Nenhum deploy remoto foi executado.

Os 11 gates externos do plugin OpenAI continuam **`EXTERNAL_GATES_PENDING`** e não foram alterados pela Phase 14.

## Próximos trabalhos

1. Iniciar **Phase 15 — Multi-device/workspace concurrency** como próximo trabalho de implementação, sem ampliar silenciosamente a autoridade de Browser/Computer use.
2. Em paralelo, avançar os 11 gates externos do plugin OpenAI quando publisher, domínio, IdP, assets e produção estiverem disponíveis.
3. Completar/reservar ativos comerciais de Telechir antes de lançamento e manter os gates de signing, CSP/headers, custos e segurança operacional antes de beta/publicação.

## Histórico

Consulte `docs/history/research-lineage.md` para a evolução completa desde o gatilho inicial com Remote Desktop Commander até Telechir.
