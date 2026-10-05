# Estado do Projeto

**Atualizado em:** 2026-10-05

## Fase atual

**Discovery concluído / Phases 0–12 concluídas / Phase 12 — Sandbox mode concluída**

A implementação possui Local Agent Core, control plane, identidade/pairing Ed25519, canal realtime outbound, Remote MCP/OAuth, seis typed filesystem tools, shell/process lifecycle, Basic Git read-only, governança de policy/approvals/audit, Dashboard MVP, tooling fail-closed para package/review do plugin público OpenAI e sandbox Docker local opt-in para process tools. A superfície MCP pública permanece com 16 tools. O projeto **não possui deploy de produção**, plugin submetido, aprovado ou publicado.

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
- [ ] Phase 13 — Computer use iniciada.

## Decisões atuais

- **Telechir é a marca oficial do produto.**
- O repositório físico já foi renomeado para `telechir`.
- Naming criativo está encerrado; nova rodada só ocorre se surgir impedimento material/jurídico.
- O produto é agnóstico a modelos e multi-IA por design.
- Distribuição no ChatGPT/Codex: plugin público + Remote MCP; o caminho técnico está preparado para package/submission, mas publisher verification, produção, review, publicação, availability por plano e quota continuam gates externos.
- Cloudflare foi aceito como primeiro control plane hospedado em ADR-0004, mantendo protocolo e agent independentes do provedor.
- O agent local aplica a autoridade final de policy.
- Approval remoto pode restringir o dispatch, mas nunca se transforma em autoridade local do agent.
- Operações `CRITICAL` permanecem fail-closed enquanto não existir confirmação local dedicada.
- `guarded_host` permanece o execution mode default; `sandbox` é opt-in, exige `sandbox.docker` e nunca faz fallback para host.
- Sandbox Docker é defense-in-depth, não VM boundary nem substituto de policy/approval.
- GUI/browser/computer-use permanecem pós-MVP.
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
- `docs/security/threat-model/phase9-policy-approvals-audit-2026-10-05.md`
- `docs/security/threat-model/phase10-dashboard-2026-10-05.md`
- `docs/security/threat-model/phase11-openai-plugin-readiness-2026-10-05.md`
- `docs/security/threat-model/phase12-sandbox-mode-2026-10-05.md`
- `docs/research/openai/phase11-public-plugin-revalidation-2026-10-05.md`
- `docs/research/docker/phase12-sandbox-revalidation-2026-10-05.md`
- `docs/research/cloudflare/phase2-revalidation-2026-10-02.md`
- `docs/research/cloudflare/phase4-revalidation-2026-10-02.md`
- `docs/research/mcp/phase5-revalidation-2026-10-02.md`

Resultado atual:

> **PHASE_12_COMPLETE**

A Phase 12 adiciona `execution_mode=guarded_host|sandbox` às process tools, mantendo `guarded_host` como default. Sandbox exige capability `sandbox.docker`, configuração local explícita, Docker binary existente, image imutável local e profile com `--pull never`, `--network none`, rootfs read-only, capabilities removidas, no-new-privileges, recursos bounded e somente o cwd autorizado montado.

Policy/approval continuam a autoridade. Sandbox não permite permission widening e mode swap altera o argument digest, impedindo replay de approval entre sandbox e host. Ausência/falha do runtime nunca faz fallback para host.

Gates finais: agent `fmt` + `clippy -D warnings` + **91 testes**; control plane format/typecheck **97 testes** + Wrangler dry-run + audit 0 vulnerabilidades; D1 `0001–0004` em base limpa; Dashboard **2 testes** + build/audit; plugin tooling **14 testes**. Duas provas no Docker 28.1.1 local confirmaram o profile de isolamento e a semântica de graceful cleanup com `--rm + stop`. Nenhum deploy remoto foi executado.

Os 11 gates externos do plugin OpenAI continuam **`EXTERNAL_GATES_PENDING`** e não foram afetados pela Phase 12.

## Próximos trabalhos

1. Iniciar **Phase 13 — Computer use** como próximo trabalho de implementação, com threat model próprio e sem reutilizar sandbox como justificativa para ampliar autoridade.
2. Em paralelo, avançar os 11 gates externos do plugin OpenAI quando publisher, domínio, IdP, assets e produção estiverem disponíveis.
3. Completar/reservar ativos comerciais de Telechir antes de lançamento e manter os gates de signing, CSP/headers, custos e segurança operacional antes de beta/publicação.

## Histórico

Consulte `docs/history/research-lineage.md` para a evolução completa desde o gatilho inicial com Remote Desktop Commander até Telechir.
