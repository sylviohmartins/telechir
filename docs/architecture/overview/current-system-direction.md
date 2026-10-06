# Direção Atual da Arquitetura

**Status:** arquitetura aceita; contratos base da Phase 0 preservados e evoluídos por contratos compatíveis; Phases 1–13 implementadas, incluindo Local Agent Core, control plane, Pairing/Device Identity, Device Realtime Channel, Remote MCP/OAuth, Filesystem Tools, Shell/Process Lifecycle, Basic Git read-only, Policy/Approvals/Audit, Dashboard, package/review tooling OpenAI, Sandbox mode Docker opt-in e Computer use tipado/bounded com adapter Windows; nenhum deploy de produção ou submission pública realizado.

## Boundary do produto

O produto pretendido é uma **camada agnóstica a modelos de execução/controle** entre clientes de IA autorizados e máquinas autorizadas. Ele não deve se tornar outro provedor de LLM nem um coding agent proprietário do reasoning loop.

## Direção atual

```text
Clientes de IA
(ChatGPT / Codex / Claude / Gemini / Copilot / clientes MCP)
        |
        | plugin/app público ou integração Remote MCP direta
        v
Integração / control plane hospedado
(Cloudflare — decisão aceita no ADR-0004)
        |
        | canal realtime com escopo por dispositivo
        v
Agente local seguro
        |
        +-- filesystem
        +-- processos / terminal
        +-- Git
        +-- sandbox Docker opt-in
        +-- computer use one-shot/single-action (Windows)
        +-- futuros adapters de browser e paridade macOS/Linux
```

## Correções importantes em relação ao blueprint v1

O primeiro blueprint utilizou **MachinaPort** como working name. Esse nome foi rejeitado. O artefato histórico é preservado sem ser tratado como decisão atual.

A segunda correção é a estratégia de distribuição: o projeto **não pode depender de um usuário ChatGPT Plus registrar manualmente um custom MCP com write completo**. O caminho pretendido na OpenAI é um plugin/app publicado cujo backend exponha Remote MCP, sujeito às regras atuais de review, plano e surface.

## Invariantes aceitos

- policy local do dispositivo é a autoridade final (ADR-0003);
- conectividade do dispositivo deve ser outbound-first;
- typed tools devem ser preferidas a uma API única de command execution irrestrita;
- trabalho long-running deve usar process/task handles explícitos;
- componentes do control plane hospedado não executam workloads do usuário;
- host, guarded-host e sandbox são níveis de segurança distintos e devem ser descritos honestamente.

## Evidência nova

Em 2026-10-01, o caminho de referência ChatGPT Plus + plugin público foi validado empiricamente com Remote Desktop Commander: device listing, execução de processo e escrita/leitura de arquivo funcionaram na conta Plus usada no discovery.

Em 2026-10-05, o fluxo oficial foi revalidado: package público via ZIP, formato portátil `plugin.json + mcp.json`, publisher verification, domain challenge, MCP scan, 5 positive + 3 negative review cases, demo recording e reviewer account permanecem partes do caminho de publicação. A arquitetura plugin público + Remote MCP continua válida.

Isso reduz o risco arquitetural, mas não garante aprovação/disponibilidade do plugin Telechir específico. A Phase 11 prepara código/package/review; produção, submission, approval e publicação continuam externos.

Em 2026-10-05, a Phase 12 adicionou `execution_mode=guarded_host|sandbox` às process tools. `guarded_host` permanece default e preserva o classificador existente. `sandbox` é explicitamente opt-in, requer capability `sandbox.docker`, image local imutável, Docker profile fail-closed e continua subordinado à mesma policy/approval local. Sandbox é defense-in-depth; não é descrito como VM boundary.

Na mesma data, a Phase 13 adicionou `capture_screen` e `control_computer` como primitives tipados. Captura é one-shot/HIGH e input é single-action/CRITICAL. O input exige confirmação humana local session/digest/TTL-bound imediatamente antes do side effect; approval remoto nunca substitui esse passo. O primeiro adapter é Windows e mantém Win32 FFI isolado fora do core `forbid(unsafe_code)`. macOS/Linux continuam capability-unavailable até adapters com consentimento nativo serem implementados.

## Validações pendentes

- publisher verification e permissões OpenAI do projeto;
- domínio/website/support/privacy/terms e assets finais;
- deploy HTTPS do MCP e domain verification;
- OIDC `openid/email` + UserInfo no IdP externo quando necessário;
- reviewer account, recording, MCP scan, submission e aprovação;
- disponibilidade do plugin próprio no Plus;
- quota/metering do plugin próprio;
- commercial clearance de Telechir antes de lançamento;
- custos/limites Cloudflare com tráfego WebSocket realista antes de beta;
- code signing/update path antes de distribuição pública;
- paridade Computer use em macOS/Linux com mecanismos nativos de consentimento;
- eventual migração da captura Windows GDI para Windows.Graphics.Capture/system picker quando existir host UI adequado.

Decisões já encerradas:
- licenciamento do core: Apache-2.0 (ADR-0005);
- linguagem do agent: Rust (ADR-0007);
- device transport: WebSocket outbound (ADR-0006);
- state ownership: ADR-0008;
- device identity baseline Ed25519: ADR-0009;
- material público pendente no pairing antes de `ACTIVE`: ADR-0010.

Blueprint vivo: `docs/architecture/overview/product-technical-blueprint-v2.md`.

Contratos implementáveis: `specs/`.
