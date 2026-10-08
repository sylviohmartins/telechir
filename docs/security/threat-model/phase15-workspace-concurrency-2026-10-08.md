# Threat Model — Phase 15 Workspace Concurrency

**Data:** 2026-10-08
**Estado:** Phase 15 candidate

## Ativos protegidos

- ownership user → device → workspace;
- integridade de filesystem/process/Git/Computer/Browser side effects;
- binding de command/approval/session/argument digest/workspace;
- idempotency;
- monotonicidade do fencing token;
- audit trail sem payload sensível.

## Ameaças e controles

### Workspace spoofing

Caller pode tentar usar workspace de outro usuário/device. resolveWorkspace exige user_id + device_id + workspace_id, workspace ativo e device não revogado; mismatch retorna NOT_FOUND.

### Double mutation — AB-028

Side effects adquirem lease exclusivo por workspace antes do dispatch. Lease ativo de outro command retorna CONFLICT. Reads não adquirem lease exclusivo.

### Global serialization desnecessária

A chave do lease inclui workspace_id; workspaces distintos no mesmo device e devices distintos do mesmo usuário continuam concorrentes.

### Stale owner e fencing

Nova aquisição real incrementa fencing token; renew do mesmo command mantém o token. Command e audit persistem workspace/fence.

Risco residual: o host OS não faz compare-and-fence atômico; nesta fase o fencing protege coordenação cloud, redispatch e audit, não constitui distributed transaction com o filesystem/OS.

### Reconnect replay — AB-029

Nova conexão do mesmo device não replaya command aceito. Estado ACCEPTED, workspace e fencing permanecem duráveis; nova mutação conflita enquanto o lease estiver ativo.

### Approval muda de workspace

Approval persiste workspace_id. Decision/redispatch validam session, digest e workspace; renew preserva o fencing token.

### Idempotency confundida com lock

Idempotency deduplica o efeito lógico; lease serializa side effects; approval governa autoridade; fencing versiona ownership temporal. Um não substitui o outro.

### Eviction/restart

Lease e fence ficam em Durable Object Storage transacional, não apenas em memória.

### Terminal não libera lease

completed, failed e cancelled liberam lease. A Phase 15 também corrige os polling loops de todas as device tool services para tratar command.cancelled como terminal explícito.

### Revocation

Revocation fecha realtime, remove leases do coordinator e a resolução de workspace exige device não revogado.

### Workspace policy bypass

Governance avalia account, device, workspace e session scopes. Teste dedicado prova DENY em um workspace sem contaminar sibling workspace.

### Audit leakage

Audit registra IDs, decisão, risco, workspace e fencing; raw arguments continuam representados pelo digest existente.

## Riscos residuais

- lock coarse-grained por workspace;
- sem fair queue: concorrência recebe CONFLICT;
- expiry lazy, sem alarm;
- fencing não é imposto atomicamente pelo host OS;
- D1 e DO não formam uma transação distribuída.

## Resultado

A Phase 15 reduz concorrência perigosa sem ampliar authority, sem nova tool pública e sem iniciar Phase 16.
