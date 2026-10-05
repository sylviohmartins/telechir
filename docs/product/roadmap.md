# Roadmap do Discovery até a Implementação

Este roadmap é intencionalmente gated. Ele descreve a ordem de maturação do projeto, não uma autorização para implementar todas as fases.

## Gates de discovery

1. **Naming discovery** — **concluído**: Telechir / `NAME_READY`.
2. **Commercial clearance da marca** — pendente antes de lançamento público/comercial; não bloqueia Phase 0.
3. **Viabilidade ChatGPT Plus/plugin** — caminho de referência validado; plugin próprio, availability e quota continuam como release gates.
4. **Blueprint v2** — consolidado com as decisões atuais.
5. **Licensing/open-source strategy** — concluída: core Apache-2.0 / ADR-0005.
6. **Definition of Ready** — concluída para Phase 0.
7. **Phase 0** — concluída em 2026-10-02; contratos congelados em `specs/`.
8. **Phase 1 readiness** — `READY_FOR_PHASE_1` concluído.
9. **Phase 1** — Local Agent Core concluída em 2026-10-02; exit review em `docs/testing/acceptance/phase1-exit-review-2026-10-02.md`.
10. **Phase 2** — Hosted Control-Plane Skeleton concluída em 2026-10-02; exit review em `docs/testing/acceptance/phase2-exit-review-2026-10-02.md`.
11. **Phase 3** — Pairing and Device Identity concluída em 2026-10-02; exit review em `docs/testing/acceptance/phase3-exit-review-2026-10-02.md`.
12. **Phase 4** — Device Realtime Channel concluída em 2026-10-02; exit review em `docs/testing/acceptance/phase4-exit-review-2026-10-02.md`.
13. **Phase 5** — Remote MCP Integration and OAuth concluída em 2026-10-02; exit review em `docs/testing/acceptance/phase5-exit-review-2026-10-02.md`.
14. **Phase 6** — Filesystem Tools concluída em 2026-10-03; exit review em `docs/testing/acceptance/phase6-exit-review-2026-10-03.md`.
15. **Phase 7** — Shell/Process Lifecycle concluída em 2026-10-04; exit review em `docs/testing/acceptance/phase7-exit-review-2026-10-04.md`.
16. **Phase 8** — Basic Git concluída em 2026-10-04; exit review em `docs/testing/acceptance/phase8-exit-review-2026-10-04.md`.
17. **Phase 9** — Policy, Approvals and Audit concluída em 2026-10-05; exit review em `docs/testing/acceptance/phase9-exit-review-2026-10-05.md`.

## Fases após readiness

0. Repository and protocol specifications — **concluída**
1. Local agent core — **concluída**
2. Hosted control-plane skeleton — **concluída**
3. Pairing and device identity — **concluída**
4. Device realtime channel — **concluída**
5. Remote MCP integration and OAuth — **concluída**
6. Filesystem tools — **concluída**
7. Shell/process lifecycle — **concluída**
8. Basic Git — **concluída**
9. Policy, approvals and audit — **concluída**
10. Dashboard — **próxima fase**
11. ChatGPT public-plugin readiness
12. Sandbox mode
13. Computer use
14. Browser automation
15. Multi-device/workspace concurrency
16. Multi-AI compatibility certification
17. Public release hardening

A implementação não deve atravessar gates apenas porque uma fase posterior é tecnicamente possível.
