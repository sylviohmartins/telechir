# Phase 13 Exit Review — Computer Use

**Data:** 2026-10-06

**Branch:** `phase13/computer-use`

**Issue:** #42

**Resultado:** `PHASE_13_COMPLETE` na branch; integração em `main` pendente até merge.

## Escopo entregue

A Phase 13 adiciona Computer use de forma tipada e bounded sem transformar o Telechir em remote desktop genérico.

Novas public tools:

- `capture_screen`;
- `control_computer`.

A superfície MCP passa de 16 para **18 tools**.

Nenhum novo Device Wire message type foi criado. O baseline continua com **15 message types**; apenas `command_operation` evoluiu para incluir:

- `screen.capture`;
- `computer.input`.

## capture_screen

Contrato:

- device explícito;
- `max_width` bounded, default 256 e máximo 320;
- `max_height` bounded, default 144 e máximo 240;
- one-shot;
- sem streaming;
- sem OCR implícito.

Segurança:

- permission `SCREEN_READ`;
- risk floor `HIGH`;
- capability `computer.screen.capture`;
- approval Telechir bounded/TTL;
- screenshot marcada `untrusted=true`;
- binário máximo 180 KiB;
- base64 não entra em audit metadata;
- MCP retorna bytes no image content block;
- `structuredContent` contém somente metadata.

O primeiro provider Windows usa GDI/Win32 como fonte one-shot de pixels e codifica o resultado público em PNG. A arquitetura documenta Windows.Graphics.Capture como evolução moderna futura.

## control_computer

Executa exatamente **uma action por command**:

- `move_pointer`;
- `click`;
- `scroll`;
- `key`;
- `type_text`.

Não existe API pública para:

- macro;
- array de actions;
- raw scan code;
- clipboard;
- arbitrary script;
- DOM/browser automation;
- elevation;
- UAC/secure-desktop bypass.

Segurança:

- permission `INPUT_CONTROL`;
- risk floor `CRITICAL`;
- capability `computer.input`;
- idempotency key obrigatória;
- arguments bounded;
- confirmação humana local no Windows;
- confirmation binding por session + argument digest + TTL;
- TTL local de 30 s;
- remote `approval_id` é rejeitado como substituto;
- cloud approval continua somente restritivo;
- mudança de payload/session/expiry falha fechado.

## Confirmação local Windows

O adapter usa:

- `WTSGetActiveConsoleSessionId`;
- `WTSSendMessageW`;
- Yes/No;
- default No;
- foreground/topmost;
- timeout de 30 s;
- resumo bounded;
- digest parcial;
- conteúdo de `type_text` oculto.

Falha ao apresentar o prompt ou ausência de console local ativo vira deny.

O prompt não é secure desktop. Spoofing/clickjacking por software local comprometido permanece risco residual documentado.

## Windows input provider

Input usa APIs oficiais Win32:

- `SetCursorPos` / `GetCursorPos`;
- `SendInput`.

Controles:

- coordinates dentro do virtual desktop atual;
- posição do cursor revalidada antes de click/scroll;
- key allowlist;
- modifiers allowlisted/unique;
- text <= 2.000 chars;
- control characters rejeitados;
- UIPI não é contornado;
- envio parcial é falha;
- mouse/key/text possuem best-effort release cleanup em envio parcial;
- nenhum teste automatizado dispara input real.

## Boundary nativo

O crate principal `telechir-agent` continua:

```rust
#![forbid(unsafe_code)]
```

Todo FFI Win32 fica em:

```text
agent/platform/windows-computer/
```

O core usa wrapper segura e converte somente DTOs bounded.

A primeira tentativa de compilar FFI dentro do crate principal foi corretamente rejeitada por `forbid(unsafe_code)`. A arquitetura foi corrigida; a proteção não foi removida nem relaxada.

## Cross-platform

### Windows

Implementado e capability opt-in.

Config:

```text
TELECHIR_COMPUTER_SCREEN_ENABLED=true|false
TELECHIR_COMPUTER_INPUT_ENABLED=true|false
```

Default: ambos `false`.

### macOS

Sem adapter Phase 13.

Config habilitada falha fechado e capability não é anunciada.

ScreenCaptureKit/CGEvent permanecem caminho arquitetural futuro, respeitando TCC/Screen Recording/Accessibility.

### Linux / Wayland

Sem adapter Phase 13.

XDG ScreenCast/RemoteDesktop portals permanecem caminho arquitetural futuro com consentimento explícito.

Nenhum fallback X11 permissivo foi adicionado.

## Cloud / governance

`ComputerToolsService`:

- ownership ativo;
- device online;
- capability dedicada;
- validação bounded dos argumentos;
- risk/permission fixos por tool;
- idempotency de input;
- argument digest pela mesma governança da Phase 9;
- sem bearer no agent;
- sem raw input payload em audit metadata.

Remote policy continua com precedência:

```text
DENY > ASK > ALLOW
```

Mesmo quando ASK remoto é satisfeito, `approvalId` enviado ao agent permanece `null`; `computer.input` precisa do prompt local.

## OAuth / MCP

Scopes novos:

- `telechir:screen:read`;
- `telechir:input:write`.

Protected Resource Metadata foi atualizada e testada.

MCP annotations:

`capture_screen`:
- readOnly = true;
- destructive = false;
- openWorld = false.

`control_computer`:
- readOnly = false;
- destructive = true;
- openWorld = true.

A annotation `openWorld=true` reflete que input sobre aplicações visíveis pode interagir com entidades externas; ela não amplia authorization.

## Prova Windows não destrutiva

Foi executada captura Win32/GDI real no host PREDATORH300, sem qualquer input sintético.

Resultado:

```text
virtual desktop = 1920x1080
bounded capture = 256x144
PNG bytes = 26725
PNG signature = 89504E470D0A1A0A
binary budget = 184320
temporary artifact removed = true
```

A imagem temporária foi removida imediatamente e não foi aberta, analisada nem commitada.

Essa prova valida o caminho Win32/GDI no host. O crate Rust real foi validado por compile/clippy MSVC, sem alegar execução direta do binário Rust na máquina durante esta sessão.

## Agent / Rust gates

Core:

```text
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
```

Resultado:

- format: PASS;
- clippy -D warnings: PASS;
- **92 unit tests**: PASS;
- connection credential contract: 1 PASS;
- pairing identity contract: 1 PASS;
- protocol contracts: 7 PASS;
- total: **101 testes**, 0 falhas.

Windows native adapter:

```text
cargo fmt --manifest-path platform/windows-computer/Cargo.toml -- --check
cargo clippy --manifest-path platform/windows-computer/Cargo.toml   --target x86_64-pc-windows-msvc -- -D warnings
cargo check --locked --all-features --target x86_64-pc-windows-msvc
```

Resultado: PASS.

macOS regression:

```text
cargo check --locked --all-features --target aarch64-apple-darwin
```

Resultado: PASS.

Computer-use habilitado continua runtime-unavailable/fail-closed em target não Windows.

## Control-plane gates

Após ajuste final de dependencies:

```text
npm run format:check
npm run typecheck
npm test
npm run dry-run
npm audit --audit-level=high
```

Resultado:

- format: PASS;
- typecheck: PASS;
- **16 test files / 101 tests**: PASS;
- Wrangler dry-run: PASS;
- Wrangler: 4.148.0;
- bundle: **888,02 KiB / gzip 169,61 KiB**;
- npm audit: **0 vulnerabilidades**.

### Supply-chain finding durante o exit review

O primeiro audit completo encontrou **4 HIGH** por:

```text
sharp < 0.35.5
GHSA-wq5f-xc86-pv6w
CVE-2026-96889
```

Cadeia:

```text
@cloudflare/vitest-plugin
 -> miniflare
 -> sharp 0.35.4
```

Mesmo as releases Cloudflare atuais ainda apontavam Miniflare para `sharp 0.35.4`.

Mitigação:

- `@cloudflare/vitest-plugin` -> 1.3.7;
- `wrangler` -> 4.148.0;
- `overrides.sharp = 0.35.5`;
- lockfile atualizado;
- full suite repetida;
- audit final: 0 vulnerabilities.

Nenhum `npm audit fix --force` foi utilizado.

## D1

Nenhuma migration nova.

Aplicação em base local limpa:

- 0001: PASS — 23 commands;
- 0002: PASS — 12 commands;
- 0003: PASS — 2 commands;
- 0004: PASS — 5 commands.

## Dashboard regression

Nenhuma mudança funcional de UI necessária.

- format: PASS;
- typecheck: PASS;
- **2 testes**: PASS;
- production build: PASS;
- JS: 232,41 KiB / gzip 72,35 KiB;
- npm audit: 0 vulnerabilities.

## OpenAI plugin tooling regression

A public surface passa de 16 para 18 tools.

Package/review tooling:

- Python compile: PASS;
- **14 testes**: PASS;
- annotation review cobre a superfície atual;
- package continua sem credentials/runtime screenshot.

A documentação de submission foi atualizada para 18 tools; publicação real continua gate externo.

## Threat model

Documento:

`docs/security/threat-model/phase13-computer-use-2026-10-05.md`

Cobre:

- prompt injection visual;
- captura de segredo;
- capability spoof;
- remote approval tentando substituir local confirmation;
- payload mismatch;
- spoofing/clickjacking;
- confirmation text injection;
- expiry;
- session swap/reconnect;
- retry/replay;
- oversized screenshot;
- secure desktop/UAC;
- UIPI;
- stuck keys/buttons;
- cursor/focus race;
- multi-monitor/DPI;
- rapid abuse;
- raw scan-code;
- clipboard;
- browser scope creep;
- audit leakage;
- malformed capture;
- visual content como untrusted input.

## Riscos residuais aceitos

- GDI não oferece o picker/consentimento visual de Windows.Graphics.Capture;
- prompt WTS não é secure desktop;
- revogação cloud exatamente durante prompt bloqueante pode não ser observada de forma síncrona;
- foco pode mudar após confirmação;
- race física de mouse ainda existe;
- DPI/layout podem mudar entre captura e ação;
- software local comprometido pode spoofar UI;
- screenshot autorizada pode conter segredo visível;
- macOS/Linux ainda não possuem adapter;
- não existe input-specific rate limiter além de confirmação CRITICAL por action;
- browser automation estruturada continua fora da fase.

## Boundaries preservados

Não implementados:

- Browser/DOM automation;
- clipboard;
- accessibility tree;
- screen streaming;
- OCR;
- action macros;
- arrays de actions;
- raw scan-code API;
- privilege elevation;
- secure desktop interaction;
- UAC bypass;
- macOS/Linux GUI adapters;
- deployment remoto.

## Definition of Done

- [x] duas tools públicas tipadas;
- [x] Windows adapter real;
- [x] core mantém forbid(unsafe_code);
- [x] FFI isolado;
- [x] screen one-shot/bounded/HIGH;
- [x] input single-action/bounded/CRITICAL;
- [x] confirmação local session/digest/TTL-bound;
- [x] remote approval não substitui local confirmation;
- [x] idempotency de input;
- [x] capability gate cloud + agent;
- [x] UIPI/elevation não contornados;
- [x] screenshot não persistida em audit;
- [x] content block separado;
- [x] 15 message types preservados;
- [x] 17 command operations cross-language;
- [x] macOS/Linux fail-closed;
- [x] Windows MSVC gate;
- [x] macOS ARM64 regression;
- [x] prova real não destrutiva de captura;
- [x] nenhum teste gerou input sintético real;
- [x] full Rust gates;
- [x] full control-plane gates;
- [x] clean D1 migrations;
- [x] Dashboard regression;
- [x] plugin tooling regression;
- [x] npm audit 0 após CVE mitigation;
- [x] nenhum deploy remoto;
- [x] Phase 14 não iniciada.

## Decisão

A Phase 13 atende a issue #42 e pode ser marcada **`PHASE_13_COMPLETE`** após integração desta branch.

A próxima fase de implementação é **Phase 14 — Browser automation**.

Os 11 gates externos OpenAI permanecem `EXTERNAL_GATES_PENDING`.
