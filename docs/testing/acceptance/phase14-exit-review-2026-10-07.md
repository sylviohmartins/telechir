# Phase 14 Exit Review — Browser Automation

**Data:** 2026-10-07

**Branch:** `phase14/browser-automation`

**Issue:** #44

**Resultado:** `PHASE_14_COMPLETE` na branch; integração em `main` pendente até merge.

## Objetivo entregue

A Phase 14 adiciona browser automation como capability própria, tipada e bounded sem transformar o Telechir em passthrough de Playwright/CDP/WebDriver.

Superfície pública adicionada:

1. `open_browser_session`;
2. `get_browser_snapshot`;
3. `navigate_browser`;
4. `click_browser`;
5. `fill_browser`;
6. `close_browser_session`.

A superfície MCP total passa de **18 para 24 tools**.

O Device Wire continua com exatamente **15 message types**. Apenas o enum de command operations foi evoluído.

## Authority e governance

Todas as browser operations exigem exatamente:

```text
PermissionDomain::Browser
risk >= HIGH
```

`BROWSER` não implica:

- `INPUT_CONTROL`;
- `NETWORK`;
- shell;
- filesystem;
- clipboard;
- secrets.

Side-effect operations:

- `browser.session.open`;
- `browser.navigate`;
- `browser.click`;
- `browser.fill`;
- `browser.session.close`.

Todas exigem idempotency key.

`browser.snapshot` é read-only e não aceita idempotency.

Cloud governance permanece restritiva e o agent continua a autoridade final.

## Adapter local

Novo adapter:

`agent/platform/browser-playwright/`

Stack:

- Node.js;
- Playwright **1.63.0** pinado em lockfile;
- Chromium correspondente instalado pelo Playwright;
- stdio/NDJSON somente;
- nenhum listener público.

O Rust fala com o sidecar por request/response bounded e correlacionado por ID.

Falhas de:

- health;
- spawn;
- timeout;
- EOF;
- response ID mismatch;
- JSON inválido;

matam/inutilizam o sidecar e falham fechado.

Capabilities browser só são anunciadas se o health real conseguir lançar Chromium.

## Isolamento do browser

Cada session usa `browser.newContext()` não persistente.

Não são usados/expostos:

- `launchPersistentContext`;
- browser profile pessoal;
- cookies import/export;
- `storageState`;
- localStorage/sessionStorage import;
- extensions;
- browser credentials;
- HTTP auth;
- secret broker.

Session lifecycle:

- opaque session ID;
- TTL configurável entre 30 e 3600 s;
- máximo configurável de 1 a 4 sessões;
- default 900 s / 2 sessões;
- close idempotente;
- expiry fecha context;
- shutdown/crash invalida sessions.

## Chromium sandbox

O adapter configura:

```text
chromiumSandbox: true
```

O primeiro smoke sob root falhou fechado porque Chromium se recusou a executar sandboxed como root.

Não foi adicionado `--no-sandbox` nem `chromiumSandbox:false`.

A prova válida executou como usuário não-root em container efêmero com user namespaces permitidos no runner.

Esse comportamento coincide com a revalidação oficial documentada em:

`docs/research/browser-automation/phase14-playwright-revalidation-2026-10-07.md`

## Egress anti-SSRF

Browser usa proxy loopback próprio do adapter.

Produção bloqueia:

- localhost/local/intranet names;
- single-label hosts;
- IPv4 private/loopback/link-local/CGNAT/benchmark/documentation/multicast/unspecified;
- IPv6 private/link-local/mapped/documentation/multicast/unspecified;
- URL credentials;
- non-HTTP(S);
- portas diferentes de 80/443.

DNS:

- resolve all;
- qualquer address não público causa deny;
- upstream conecta diretamente ao IP validado;
- Host header preserva o hostname lógico.

O proxy também valida CONNECT e rejeita Upgrade.

O agent remove proxy env vars antes de iniciar o sidecar.

## Service Worker / WebSocket / alternate network paths

Context:

- `serviceWorkers: "block"`;
- `routeWebSocket("**")` registrado antes da page principal;
- WebSockets recebem policy-violation close;
- WebTransport/RTCPeerConnection removidos no init script;
- QUIC/WebTransport features desabilitadas no Chromium.

Isso é defense-in-depth adicional ao egress proxy.

## Hardened smoke real

Executado com Chromium real do Playwright e sandbox ativo sob usuário não-root.

Fixture de teste local ativou loopback somente via test-only option; o agent remove essa variável ao iniciar o sidecar de produção.

Fluxo validado:

- health;
- open isolated session;
- navigate;
- semantic snapshot;
- fill;
- click;
- snapshot após interação;
- close;
- second close idempotente.

Abuse paths:

1. allowed fixture -> 302 redirect -> `localhost/protected`;
2. allowed fixture -> `img src=localhost/protected`;
3. allowed fixture -> `ws://localhost/ws`.

Resultado final:

```json
{
  "smoke": "PASS",
  "isolated": true,
  "persistent_profile": false,
  "redirect_private_blocked": true,
  "subresource_private_blocked": true,
  "websocket_blocked": true,
  "protected_hits": 0,
  "websocket_upgrades": 0
}
```

A prova reproduzida final executou com o seccomp padrão do Docker e usuário não-root `node`; não foi necessário `seccomp=unconfined`, `--no-sandbox` ou qualquer relaxamento equivalente. O Chromium sandbox permaneceu ativo.

## Typed locator contract

Permitidos:

- role + accessible name;
- label;
- text;
- placeholder;
- test id.

Boundaries:

- locator string 1..256 caracteres;
- role allowlist;
- optional index 0..9;
- exact opcional;
- sem control chars;
- locator sem index deve resolver de forma única.

Negados:

- CSS;
- XPath;
- JS;
- raw selector engine;
- raw CDP;
- raw WebDriver/BiDi.

## Snapshot

`get_browser_snapshot` retorna:

- session id;
- URL;
- title;
- semantic snapshot;
- captured_at;
- `untrusted=true`;
- `truncated`.

Bounds:

- snapshot: 48 KiB UTF-8;
- result Rust/control plane também bounded.

Não retorna:

- HTML completo;
- cookie;
- storage state;
- network body;
- screenshot;
- credentials.

## Fill

`fill_browser`:

- exatamente um locator;
- texto 1..2000 caracteres;
- sem control chars;
- sem clipboard;
- sem secret injection;
- HIGH;
- side-effect/idempotency.

## Download / dialogs / pages extras

- `acceptDownloads=false`;
- download event é cancelado;
- dialogs são descartados;
- qualquer page extra/pop-up é fechada;
- só a page principal é parte da session.

Nenhuma tool de upload/download foi criada.

## Audit/privacy

Audit não persiste:

- URL bruta;
- snapshot;
- fill text;
- locator value;
- idempotency plaintext;
- cookies/storage.

Governance usa metadata bounded e argument digest.

## Finding de teste durante a fase

O teste inicial de `navigate_browser` expirava aguardando `server.hello`.

Causa:

- o fixture anunciava `browser.navigate` duas vezes em `capabilities`;
- o protocolo exige capabilities únicas;
- o `agent.hello` inválido foi corretamente rejeitado.

Correção:

- fixture passou a anunciar capabilities únicas;
- runtime não precisou de alteração;
- suíte BrowserTools voltou a passar 4/4.

Isso é evidência positiva do schema/protocol validation fail-closed.

## Agent / Rust gates

Executados em Rust 1.99 Bookworm.

Como a image não incluía rustfmt/clippy, a CA Avast já confiada no Windows foi montada somente no container efêmero para manter TLS validado durante `rustup`. Nenhuma proteção TLS/Avast foi desabilitada e a CA não entra no repo.

Gates:

```text
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
```

Resultado:

- fmt: PASS;
- clippy -D warnings: PASS;
- **100 unit tests**: PASS;
- connection credential contract: 1 PASS;
- pairing identity contract: 1 PASS;
- protocol contracts: 7 PASS;
- total: **109 tests**, 0 failures.

Protocol contract continua afirmando exatamente 15 message types.

## Cross-target gates

Windows MSVC:

```text
cargo clippy --locked --all-targets --all-features --target x86_64-pc-windows-msvc -- -D warnings
cargo check --locked --all-features --target x86_64-pc-windows-msvc
```

Resultado: PASS.

macOS ARM64:

```text
cargo check --locked --all-features --target aarch64-apple-darwin
```

Resultado: PASS.

## Browser adapter gates

```text
npm run format:check
npm test
npm audit --audit-level=high
```

Resultado:

- format: PASS;
- **9 tests**: PASS;
- audit: **0 vulnerabilities**.

O hardened smoke real também passou conforme evidência acima.

## Control-plane gates

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
- **17 test files**: PASS;
- **105 tests**: PASS;
- BrowserTools dedicated tests: 4/4;
- MCP Phase 14 descriptor/snapshot tests: PASS;
- OAuth `telechir:browser:use`: PASS;
- Wrangler 4.148.0 dry-run: PASS;
- Worker upload: **922,09 KiB / gzip 172,83 KiB**;
- npm audit: **0 vulnerabilities**.

## D1

Nenhuma migration nova.

Base local limpa:

- 0001: PASS — 23 commands;
- 0002: PASS — 12 commands;
- 0003: PASS — 2 commands;
- 0004: PASS — 5 commands.

## Dashboard regression

- format: PASS;
- typecheck: PASS;
- **2 tests**: PASS;
- production build: PASS;
- JS 232,41 KiB / gzip 72,35 KiB;
- npm audit: **0 vulnerabilities**.

## Plugin tooling regression

- Python compile: PASS;
- **14 tests**: PASS;
- annotation-review coverage: exatamente **24 public tools**;
- external readiness gates continuam pendentes.

## Threat model

Novo delta:

`docs/security/threat-model/phase14-browser-automation-2026-10-07.md`

Cobre:

- visual/prompt injection;
- malicious accessibility names;
- stale locator/TOCTOU;
- click/fill side effects;
- popup/tab;
- iframe/cross-origin;
- redirect/subresource SSRF;
- DNS rebinding;
- alternate IP notation;
- metadata/private ranges;
- WebSocket/WebTransport/WebRTC;
- service workers;
- proxy env bypass;
- schemes;
- credentials;
- cookies/storage/profile;
- download/file chooser;
- dialogs/permissions;
- browser sandbox;
- sidecar crash/timeout;
- replay/reconnect;
- resource exhaustion;
- supply chain;
- CSP;
- audit/privacy.

## Revalidação oficial

Documento:

`docs/research/browser-automation/phase14-playwright-revalidation-2026-10-07.md`

Confirma:

- non-persistent BrowserContext;
- browser/version compatibility;
- explicit Chromium sandbox;
- non-root/sandbox guidance;
- service worker blocking;
- WebSocket routing;
- Chrome 136 remote-debugging/default-profile hardening;
- WebDriver BiDi ainda como Working Draft de 30/09/2026.

## Fora do escopo preservado

Não implementado:

- raw JavaScript/evaluate;
- raw CDP;
- raw WebDriver/BiDi;
- CSS/XPath selectors;
- clipboard;
- profile pessoal;
- cookies/storage import;
- secret injection;
- HTTP auth;
- upload/download;
- browser screenshots;
- network dump;
- multi-page automation;
- persistent authenticated browser;
- Phase 15 multi-device/workspace concurrency.

## Definition of Done

- [x] seis public browser tools;
- [x] BROWSER separado de INPUT_CONTROL/NETWORK;
- [x] HIGH risk floor;
- [x] idempotency para side effects;
- [x] 15 Device Wire message types preservados;
- [x] adapter Playwright local/stdin-stdout;
- [x] health/capability honesty;
- [x] context ephemeral/non-persistent;
- [x] session TTL/concurrency/cleanup;
- [x] semantic snapshot bounded/untrusted;
- [x] locators tipados;
- [x] no raw scripting/passthrough;
- [x] anti-SSRF DNS/IP/ports;
- [x] redirects bloqueados;
- [x] subresources bloqueados;
- [x] WebSockets bloqueados;
- [x] service workers blocked;
- [x] inherited proxy removed;
- [x] downloads/popups/dialogs bounded;
- [x] Chromium sandbox obrigatório;
- [x] hardened real-browser smoke;
- [x] threat model;
- [x] official revalidation;
- [x] Rust fmt/clippy/tests;
- [x] Windows MSVC gate;
- [x] macOS ARM64 gate;
- [x] control-plane full gates;
- [x] clean D1 migrations;
- [x] Dashboard regression;
- [x] plugin tooling regression;
- [x] no remote deployment.

## Decisão

A Phase 14 atende a issue #44 e pode ser marcada **`PHASE_14_COMPLETE`** após integração desta branch.

A próxima fase do roadmap é **Phase 15 — Multi-device/workspace concurrency**.

Phase 15 não deve ser iniciada implicitamente neste PR.
