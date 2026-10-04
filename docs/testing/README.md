# Estratégia de Validação

A implementação começou pela fundação Rust do Local Agent na Phase 1. Ainda não existe deploy de produção. Este diretório registra evidências, gates e estratégias de validação por fase.

Camadas esperadas:

- unit/property tests para protocolo, policy e paths;
- integration tests para control plane e agentes simulados;
- testes cross-platform do agent em Windows/macOS/Linux;
- testes de segurança/adversariais;
- reconnect/chaos tests;
- load tests para presence e process output;
- avaliações de tools/agentes em múltiplos clientes;
- workflow Java/Spring Boot como canário representativo de software engineering.

## Phase 0

- `acceptance/phase0-exit-review-2026-10-02.md` — exit gate da Phase 0;
- `acceptance/phase0-contract-audit-2026-10-02.md` — auditoria independente e revalidação dos contratos;
- `tabletop/phase0-tabletop-results.md` — cenários arquiteturais exercitados em papel.

## Phase 1

- `acceptance/phase1-exit-review-2026-10-02.md` — exit gate do Local Agent Core, incluindo testes, lint, bootstrap e compile checks cross-target.

## Phase 2

- `acceptance/phase2-exit-review-2026-10-02.md` — exit gate do Hosted Control-Plane Skeleton, incluindo typecheck, testes no Workers runtime, migration D1 local e dry-run do Wrangler.

## Phase 3

- `acceptance/phase3-exit-review-2026-10-02.md` — exit gate de Pairing and Device Identity, incluindo identidade Ed25519, fixture cross-language, replay/TTL/revogação, migrations D1, cross-target Rust e dry-run do Worker.

## Phase 4

- `acceptance/phase4-exit-review-2026-10-02.md` — exit gate do Device Realtime Channel, incluindo credential curta, Hibernation WebSocket, heartbeat/presence, replay/reconnect/revogação, contratos cross-language e gates cross-target.

## Phase 5

- `acceptance/phase5-exit-review-2026-10-02.md` — exit gate da integração MCP e autenticação da Phase 5.

## Phase 6

- `acceptance/phase6-exit-review-2026-10-03.md` — exit gate de Filesystem Tools, incluindo policy local deny-by-default, traversal/symlink/junction hardening, idempotência, vertical slice MCP → realtime → agent e checks cross-platform.

## Phase 7

- `acceptance/phase7-exit-review-2026-10-04.md` — exit gate de Shell/Process Lifecycle, incluindo `SHELL_SAFE` fail-closed, ownership local de processos, ring buffers/cursor, timeout, idempotência, process-tree cancellation, scopes MCP e checks cross-platform.

## Phase 8

- `acceptance/phase8-exit-review-2026-10-04.md` — exit gate de Basic Git, incluindo `git.status`/`git.diff` read-only, containment de worktree/gitdir/common-dir, config audit fail-closed, subprocesso Git bounded, scope MCP e checks cross-platform.
