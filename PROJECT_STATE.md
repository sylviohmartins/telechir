# Estado do Projeto

**Atualizado em:** 2026-10-05

## Fase atual

**Discovery concluído / Phases 0–9 concluídas / Phase 9 — Policy, Approvals and Audit concluída**

A implementação possui Local Agent Core, control plane, identidade/pairing Ed25519, canal realtime outbound, Remote MCP/OAuth, seis typed filesystem tools, shell/process lifecycle, Basic Git read-only e governança de policy/approvals/audit com enforcement final no agent. A superfície MCP pública permanece com 16 tools; o projeto **não possui deploy de produção** e ainda não iniciou Dashboard/Phase 10.

## Gates atuais

- [x] Naming discovery: **`NAME_READY` — produto oficialmente chamado Telechir**.
- [~] Clearance jurídico/comercial da marca: **`COMMERCIAL_CLEARANCE_PENDING`** — domínio, packages, handles e trademark precisam de consulta/reserva autoritativa antes de lançamento.
- [x] ChatGPT Plus + plugin público: caminho de referência validado empiricamente com Remote Desktop Commander para write/process; review/disponibilidade do plugin próprio permanecem release gates.
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
- [ ] Phase 10 — Dashboard iniciada.

## Decisões atuais

- **Telechir é a marca oficial do produto.**
- O repositório físico já foi renomeado para `telechir`.
- Naming criativo está encerrado; nova rodada só ocorre se surgir impedimento material/jurídico.
- O produto é agnóstico a modelos e multi-IA por design.
- Distribuição no ChatGPT: plugin/app público + Remote MCP; usuários Plus não devem precisar registrar manualmente um custom MCP.
- Cloudflare foi aceito como primeiro control plane hospedado em ADR-0004, mantendo protocolo e agent independentes do provedor.
- O agent local aplica a autoridade final de policy.
- Approval remoto pode restringir o dispatch, mas nunca se transforma em autoridade local do agent.
- Operações `CRITICAL` permanecem fail-closed enquanto não existir confirmação local dedicada.
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
- `docs/security/threat-model/phase9-policy-approvals-audit-2026-10-05.md`
- `docs/research/cloudflare/phase2-revalidation-2026-10-02.md`
- `docs/research/cloudflare/phase4-revalidation-2026-10-02.md`
- `docs/research/mcp/phase5-revalidation-2026-10-02.md`

Resultado atual:

> **PHASE_9_COMPLETE**

A Phase 9 implementa `ALLOW / ASK / DENY` local, risk floor, hard denies, approvals vinculados a command/session/permission/risk/argument digest/TTL, consumo `once`, `approval.request / approval.decision`, restrictions cloud somente restritivas e audit metadata mínima/redigida. Remote approval nunca vira local authority. O command context atual suporta restrictions account/device/session; workspace policy não é declarada operacional enquanto não existir `workspace_id` confiável no dispatch.

O agent passou em fmt/clippy, **81 testes** e compile checks Windows/macOS. O control plane passou em format/typecheck, **81 testes**, migrations `0001 + 0002 + 0003 + 0004` em D1 local limpa, Wrangler dry-run e `npm audit` sem vulnerabilidades. Nenhum deploy remoto foi executado e a Phase 10 não foi iniciada.

## Próximos trabalhos

1. Em uma execução dedicada de build/test, iniciar **Phase 10 — Dashboard**, reutilizando a mesma pipeline de policy/approval/audit e sem bypass.
2. Em paralelo, completar/reservar ativos comerciais de Telechir antes de lançamento.
3. Manter os release gates de OpenAI, segurança operacional, signing e custos antes de beta/publicação.

## Histórico

Consulte `docs/history/research-lineage.md` para a evolução completa desde o gatilho inicial com Remote Desktop Commander até Telechir.
