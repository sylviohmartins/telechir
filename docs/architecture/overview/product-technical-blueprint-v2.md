# Product & Technical Blueprint v2

**Data:** 2026-10-01  
**Status:** arquitetura consolidada; Phases 0–7 concluídas; foundations, identidade, canal realtime, integração MCP/OAuth, filesystem tools e shell/process lifecycle implementados sem deploy de produção
**Marca:** **Telechir** (`NAME_READY`); commercial/legal clearance permanece pendente antes de lançamento  
**Objetivo:** consolidar a direção técnica após naming discovery e validação empírica do caminho ChatGPT Plus + plugin público + Remote MCP.

## 1. Visão

O produto deve ser uma **camada universal, model-agnostic, policy-first e auditável de execução/controle** entre clientes de IA autorizados e máquinas autorizadas.

Ele não é:
- um novo LLM;
- um coding agent proprietário;
- um RMM genérico;
- um remote desktop tradicional;
- um simples shell MCP.

Ele é a camada que fornece às IAs **mãos seguras e controladas** sobre computadores e ambientes executáveis.

## 2. Distribuição no ChatGPT

A experiência-alvo para usuário ChatGPT Plus é:

```text
ChatGPT Plus
  -> plugin público aprovado
  -> Remote MCP hospedado
  -> control plane
  -> canal realtime outbound
  -> agente local
  -> filesystem / processos / Git
```

O usuário final não deve precisar cadastrar manualmente um custom MCP.

Essa arquitetura foi validada por:
- documentação oficial de plugins públicos com Remote MCP;
- Remote Desktop Commander como referência pública;
- teste empírico nesta conta Plus com listagem de device, execução de processo, escrita e leitura de arquivo.

A aprovação/distribuição do nosso futuro plugin específico continua como **release gate**, não como bloqueio arquitetural.

## 3. Multi-AI by design

O core deve ser reutilizável por:

- ChatGPT;
- Codex;
- Claude/Claude Code;
- Gemini/Gemini CLI;
- GitHub Copilot;
- Cursor;
- Cline;
- Roo Code;
- OpenCode;
- Goose;
- qualquer cliente MCP compatível;
- futuros adapters REST/SDK/CLI.

MCP é interface externa principal, não protocolo interno obrigatório.

## 4. Arquitetura recomendada

```text
AI Clients
(ChatGPT plugin / Codex / Claude / Gemini / MCP clients)
        |
        | MCP / HTTPS / OAuth
        v
Public Integration Layer
        |
        v
Cloudflare Control Plane
  - Workers
  - Durable Objects
  - D1
  - R2
  - Analytics Engine
        |
        | versioned realtime protocol
        | outbound-only WebSocket from device
        v
Secure Local Agent
        |
        +-- device identity
        +-- local policy authority
        +-- filesystem
        +-- process / PTY
        +-- Git
        +-- audit
        +-- future adapters
              - browser
              - GUI/computer-use
              - sandbox
              - SSH/WinRM
              - Docker/Kubernetes
```

## 5. Boundaries

### External protocol

MCP para integração com clientes de IA.

### Internal device protocol

Protocolo próprio, versionado e orientado a:
- reconnect;
- correlation IDs;
- idempotency;
- command lifecycle;
- process output streaming;
- cancellation;
- heartbeats;
- capability negotiation;
- backpressure.

Não forçar MCP na comunicação cloud↔device.

## 6. Cloudflare

### Workers
Responsáveis por:
- endpoint MCP;
- OAuth/API;
- validação;
- routing;
- dashboard API.

Não executam workloads do computador do usuário.

### Durable Objects
Um coordenador lógico por device para:
- presence;
- WebSocket;
- locks;
- correlação de comandos;
- bounded realtime state.

### D1
Metadata durável:
- users;
- devices;
- public keys;
- pairings;
- policies;
- session metadata;
- approvals metadata;
- release metadata.

### R2
Blobs:
- outputs grandes;
- screenshots;
- diagnostics;
- artifacts.

### Analytics Engine
Métricas agregadas de:
- tool calls;
- latency;
- bytes;
- failures;
- client/device dimensions.

### KV
Somente cache/feature flags não críticos.

### Queues
Somente assíncrono:
- telemetry fanout;
- cleanup;
- retries explícitos;
- audit pipelines.

Não colocar o caminho síncrono normal de tool calls na Queue.

## 7. Local Agent

### Linguagem recomendada

**Rust** é a decisão aceita para o core (ADR-0007).

Razões:
- memory safety;
- single binary;
- footprint reduzido;
- async/networking;
- controle de processos;
- FFI/native APIs;
- boa adequação a uma fronteira de segurança.

Tauri pode ser adicionado depois para tray/UI, sem misturar UI com runtime core.

### Responsabilidades

- device identity;
- secure transport;
- policy enforcement;
- filesystem;
- process/PTY;
- Git;
- local secret broker;
- audit local;
- signed updater;
- platform adapters.

## 8. Invariante principal de segurança

> O control plane e o cliente de IA nunca podem elevar as permissões além do limite estabelecido localmente no device.

Precedência conceitual:

```text
hard deny local
> device policy
> workspace/account policy
> temporary session grant
> client requested scope
```

## 9. Permission model

Domínios iniciais:

- FS_READ
- FS_WRITE
- FS_DELETE
- SHELL_SAFE
- SHELL_FULL
- PROCESS_CONTROL
- NETWORK
- GIT_WRITE
- GIT_REMOTE_WRITE
- SCREEN_READ
- INPUT_CONTROL
- BROWSER
- SECRET_USE
- ELEVATION
- ADMIN

Resultados:
- ALLOW
- ASK
- DENY

## 10. Typed tools first

Preferir tools especializadas:

- `device.list`
- `device.info`
- `fs.list`
- `fs.stat`
- `fs.read`
- `fs.write`
- `fs.patch`
- `fs.search`
- `process.start`
- `process.read`
- `process.write`
- `process.cancel`
- `process.list`
- `git.status`
- `git.diff`
- `system.metrics`
- `artifact.get`

Evitar uma tool genérica `execute_anything` como primitive principal.

## 11. Process lifecycle

Processos long-running são first-class objects.

```text
process.start
 -> processId
 -> process.read
 -> process.write
 -> process.cancel
 -> completed/failed
```

Isso é obrigatório para Maven, Spring Boot, servidores locais e testes demorados.

## 12. Filesystem safety

Toda operação deve:

1. normalizar path;
2. canonicalizar;
3. resolver symlink/reparse;
4. validar against allowed roots;
5. aplicar deny de paths sensíveis;
6. aplicar policy da operação;
7. executar atomicamente quando possível.

Writes de código devem suportar `expected_hash` para reduzir stale edits.

## 13. Secret broker

A IA referencia um identificador, não recebe necessariamente o valor real.

Exemplo:

`secret://github/build-token`

O agent resolve localmente e injeta no processo conforme policy.

Objetivo:
- reduzir exposição no prompt;
- reduzir persistência acidental;
- permitir credentials de curta duração.

## 14. Execution modes

### HOST
Execução direta no host sob policy.

### GUARDED_HOST
Policy reforçada + restrições de env/network/resource.

### SANDBOX
Container/VM/microVM explícita.

Nunca chamar HOST de sandbox.

## 15. Concorrência

- leituras podem ser concorrentes;
- alterações devem usar lease por workspace/path group;
- writes suportam precondition/hash;
- retries usam idempotency key;
- reconnect não reexecuta automaticamente comando já aceito.

## 16. Pairing e identidade

Fluxo-alvo:

```text
install agent
 -> generate device keypair
 -> login/pairing
 -> one-time challenge
 -> user verifies device
 -> public key registered
 -> device connects outbound
```

Requisitos:
- nonce one-shot;
- TTL;
- replay protection;
- revoke imediato;
- private key em keystore do SO quando disponível.

## 17. Dashboard

MVP:
- devices;
- online/offline;
- version/OS;
- active sessions;
- tool calls;
- command/process timeline;
- approvals;
- errors;
- latency;
- bytes;
- revoke.

Web terminal e screen viewer ficam pós-MVP.

## 18. MVP

### In scope

- account/auth foundation;
- agent identity;
- pairing;
- device registry;
- outbound WebSocket;
- Remote MCP;
- device list/info;
- filesystem list/stat/read/write/patch/search;
- process lifecycle;
- Git status/diff;
- policy allow/ask/deny;
- basic risk classification;
- approvals;
- audit timeline;
- simple dashboard;
- ChatGPT public-plugin packaging/readiness.

### Out of scope

- mouse/keyboard;
- continuous screen streaming;
- browser automation;
- arbitrary SSH fleet;
- Kubernetes/Docker control;
- Git push;
- silent privilege elevation;
- autonomous production deploys;
- hosted LLM inference.

## 19. Threat model baseline

Obrigatório cobrir:
- OAuth/session theft;
- device key theft;
- pairing replay;
- malicious MCP client;
- path traversal;
- symlink/reparse escape;
- secret-file access;
- destructive shell commands;
- command obfuscation;
- privilege escalation;
- process/resource exhaustion;
- package supply-chain;
- network exfiltration;
- prompt injection from files/terminal/browser/GUI;
- multi-agent write conflict;
- duplicate execution after reconnect;
- stale approvals;
- control-plane compromise;
- updater compromise;
- secrets in logs/artifacts.

## 20. Naming

O working name **MachinaPort está rejeitado** e permanece apenas em histórico.

**Telechir é a marca oficial do produto**, com status `NAME_READY`.

O clearance de domínio, package namespaces, handles e trademarks passa a ser um gate separado (`COMMERCIAL_CLEARANCE_PENDING`) para lançamento público/comercial.

O repositório físico foi renomeado para `telechir` em 2026-10-02.

## 21. Open-source strategy

Decidida em ADR-0005:
- core público sob **Apache License 2.0**;
- marca Telechir protegida separadamente;
- agent, protocolo, adapters MCP, CLI/SDKs e policy primitives interoperáveis entram no core público;
- serviço hospedado e futuros recursos enterprise podem ter componentes operacionais separados mediante ADR.

`LICENSE` e contributor policy foram adicionados na Phase 0.

## 22. Roadmap

1. Phase 0 — Repository and protocol specifications — **concluída em 2026-10-02**
2. Phase 1 — Local agent core — **concluída em 2026-10-02**
3. Phase 2 — Hosted control-plane skeleton — **concluída em 2026-10-02**
4. Phase 3 — Pairing and device identity — **concluída em 2026-10-02**
5. Phase 4 — Device realtime channel — **concluída em 2026-10-02**
6. Phase 5 — Remote MCP + OAuth — **concluída em 2026-10-02**
7. Phase 6 — Filesystem tools — **concluída em 2026-10-03**
8. Phase 7 — Shell/process lifecycle — **concluída em 2026-10-04**
9. Phase 8 — Basic Git — **próxima fase**
10. Phase 9 — Policies, approvals and audit
11. Phase 10 — Dashboard
12. Phase 11 — ChatGPT public-plugin readiness
13. Phase 12 — Sandbox mode
14. Phase 13 — Computer use
15. Phase 14 — Browser automation
16. Phase 15 — Multi-device/workspace concurrency
17. Phase 16 — Multi-AI compatibility certification
18. Phase 17 — Public release hardening

## 23. Release gates

### Naming
- `NAME_READY` concluído em 2026-10-02 — marca oficial: **Telechir**.
- `COMMERCIAL_CLEARANCE_PENDING` antes de lançamento comercial: domínio, packages, handles e trademark.

### OpenAI
- plugin próprio aprovado;
- Plus availability validada;
- write/process tools efetivamente habilitadas;
- quota/metering medidos.

### Security
- threat model formal — **baseline concluído; manter atualizado por fase**;
- path boundary tests;
- pairing/replay tests;
- approval binding;
- signed update path;
- secret redaction.

### Operational
- cost/load test;
- reconnect/duplicate tests;
- observability baseline;
- rollback strategy.

## 24. Golden vertical slice

```text
ChatGPT
 -> device.list
 -> fs.list
 -> fs.read
 -> fs.patch
 -> process.start("mvn test")
 -> process.read
 -> diagnose failure
 -> fs.patch
 -> process.start("mvn test")
 -> git.diff
```

Sem commit/push automático.

## 25. Evidências principais

- censo global e catálogo de 181 ferramentas;
- naming discovery Stage 1/2/3;
- evidência empírica de plugin público write/process em Plus;
- ADR-0002 aceito;
- threat model inicial;
- pesquisa Cloudflare/OpenAI/MCP preservada no repositório.

## 26. Resultado

A Phase 0 materializou os contratos em `specs/`, formalizou threat model/tabletops e aceitou os ADRs centrais. A Phase 1 implementou o Local Agent Core em Rust; a Phase 2 implementou o skeleton TypeScript/Cloudflare do control plane; e a Phase 3 materializou identidade Ed25519, pairing one-time, prova criptográfica cross-language, ativação D1 transacional e revogação.

O projeto está em **`PHASE_7_COMPLETE`**. O próximo gate de implementação é **Phase 8 — Basic Git**, em execução dedicada de Build, Test & Iterate. Não há deploy de produção e os release gates pendentes continuam válidos.
