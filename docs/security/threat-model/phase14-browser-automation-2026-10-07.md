# Phase 14 Threat Model Delta — Browser Automation

**Data:** 2026-10-07
**Base:** baseline + Phase 9 policy/approvals/audit + Phase 13 Computer use
**Escopo:** browser automation tipada por Playwright local

## Invariante central

> Conteúdo web é dado não confiável; Browser authority não é shell, Network genérica, filesystem, clipboard, secret broker ou Computer use.

A cadeia continua:

```text
OAuth/ownership
  -> cloud governance
  -> capability gate
  -> agent local / policy final
  -> sidecar Playwright local
  -> egress proxy Telechir
  -> browser context isolado
```

## Superfície pública

Somente:

- `open_browser_session`;
- `get_browser_snapshot`;
- `navigate_browser`;
- `click_browser`;
- `fill_browser`;
- `close_browser_session`.

Não existem public inputs para:

- JavaScript/evaluate;
- CSS/XPath/raw selector engine;
- CDP;
- WebDriver/BiDi passthrough;
- cookies/storageState;
- clipboard;
- uploads/downloads;
- auth credentials;
- browser extensions;
- network body dump;
- arbitrary page handles;
- browser screenshot primitive;
- raw HTTP client.

## Permission separation

As seis operations exigem exatamente `BROWSER`.

Controles:

- `INPUT_CONTROL` não autoriza browser;
- `BROWSER` não autoriza mouse/keyboard genérico;
- `NETWORK` continua permission distinta;
- todas as operations browser têm risk floor HIGH;
- side-effects exigem idempotency;
- permission/operation mismatch falha fechado.

## Prompt injection e conteúdo malicioso

Ameaça: página/snapshot instrui o modelo a ignorar policy, revelar secrets ou usar outra authority.

Controles:

- snapshot marca `untrusted=true`;
- snapshot é somente representação semântica bounded;
- browser executor não interpreta conteúdo como authority;
- nenhuma página pode alterar requested permissions;
- nenhuma página pode ativar INPUT_CONTROL/shell/filesystem;
- sidecar não recebe OAuth token, secret broker ou environment sensível do agent.

Risco residual: o modelo pode interpretar conteúdo malicioso e escolher uma ação browser semanticamente ruim. Policy/approval e annotations reduzem impacto, não solucionam prompt injection semanticamente.

## Snapshot / malicious accessibility names

Ameaça: texto ARIA enorme, control chars, conteúdo manipulativo, resource exhaustion.

Controles:

- snapshot máximo 48 KiB UTF-8;
- truncation preserva boundary de code point;
- result total bounded no Rust e control plane;
- title bounded;
- output sempre untrusted;
- nenhum HTML/source completo.

## Locator confusion / TOCTOU

Ameaça: locator identifica elemento diferente após rerender, duplicidade ou alteração entre observação e click.

Controles:

- locators user-facing allowlisted;
- sem CSS/XPath/JS;
- sem raw element handles persistentes;
- quando `index` não existe, locator precisa resolver exatamente um elemento;
- `index` máximo 9;
- cada tool executa uma única ação;
- Playwright auto-wait/actionability permanece ativo.

Residual: uma página pode rerender imediatamente antes/durante a ação e alterar semântica. HIGH risk e idempotency continuam necessários.

## Click side effects

Ameaça: click envia mensagem, compra, publica ou remove conteúdo.

Controles:

- HIGH;
- BROWSER;
- idempotency;
- uma interação por command;
- `destructiveHint=true`;
- `openWorldHint=true`.

Não há garantia de reversibilidade.

## Fill / auto-submit

Ameaça: fill dispara handlers ou auto-submit sem click separado.

Controles:

- texto máximo 2.000;
- control chars negados;
- um locator por command;
- sem clipboard;
- sem secret broker;
- HIGH;
- annotations destructive/open-world conservadoras.

Residual: eventos `input/change` podem produzir efeito externo automaticamente.

## Popup / new tab

Ameaça: página abre nova janela/tab e expande authority silenciosamente.

Controle:

- context observa `page`;
- qualquer page diferente da principal é fechada.

Residual: navegação da própria page principal depois de click continua possível e permanece dentro da mesma egress policy.

## Iframe / cross-origin

Ameaça: conteúdo cross-origin introduz outra origem.

Controles:

- network do browser continua atravessando proxy obrigatório;
- não há frame handle público;
- locator API pública não recebe selector/frame arbitrário.

Residual: locators user-facing do Playwright podem refletir composição acessível da página; cross-origin content continua untrusted.

## Navigation / redirect SSRF

Ameaça: URL pública redireciona para localhost/private/metadata.

Controles:

- URL inicial shape+DNS validada;
- browser usa proxy Telechir;
- proxy resolve cada HTTP request/CONNECT;
- se qualquer DNS address não for público, deny;
- upstream conecta no IP validado;
- redirects precisam passar novamente pelo proxy;
- URL final é revalidada;
- portas 80/443 apenas em produção.

Smoke comprovou public/test-loopback -> `localhost` bloqueado, com zero hits no endpoint protegido.

## Subresource SSRF

Ameaça: HTML permitido carrega imagem/script/font privada.

Controle:

- todo tráfego HTTP(S) passa pelo proxy;
- cada subresource recebe a mesma validação DNS/range.

Smoke comprovou subresource `localhost` bloqueado com zero hits.

## DNS rebinding

Ameaça: hostname resolve público na validação e privado na conexão.

Controles:

- proxy resolve imediatamente antes da conexão;
- valida todos os addresses;
- conexão é feita para address validado, não para hostname novamente;
- Host header preserva hostname lógico.

Residual: infra DNS/proxy/runtime comprometida fica fora da boundary da aplicação.

## Alternate IP notation

Ameaça: decimal/hex/octal IPv4, IPv4-mapped IPv6 ou outras formas para esconder loopback.

Controles:

- URL parser canonicaliza host;
- testes cobrem decimal/hex/octal loopback;
- mapped IPv6 é negado;
- ranges especiais explícitos são negados.

## Metadata endpoints / private ranges

Negados:

- loopback;
- RFC1918;
- link-local;
- CGNAT;
- benchmark;
- documentation ranges;
- multicast;
- unspecified;
- private IPv6;
- link-local IPv6;
- documentation IPv6;
- IPv4-mapped IPv6.

Isso inclui classes usadas por metadata services locais/link-local.

## WebSockets

Ameaça: página contorna HTTP proxy por WebSocket.

Controles:

1. `BrowserContext.routeWebSocket("**")` fecha a conexão;
2. proxy rejeita HTTP Upgrade;
3. rule é registrada antes da page principal.

Smoke confirmou zero WebSocket upgrades no server protegido.

## WebTransport / QUIC / WebRTC

Controles:

- QUIC desabilitado no Chromium;
- WebTransport feature desabilitada;
- `WebTransport`, `RTCPeerConnection` e `webkitRTCPeerConnection` removidos via init script antes da page;
- não há permission surface para camera/microphone.

Residual: browser/runtime future APIs precisam de revalidação ao atualizar Playwright/Chromium.

## Service Workers

Ameaça: Service Worker intercepta/faz fetch fora de route enforcement.

Controle:

- `serviceWorkers: "block"`.

A principal boundary de egress ainda é o proxy; bloquear SW evita estado/background network adicional.

## Proxy/environment bypass

Ameaça: browser herda corporate/user proxy ou variável apontando para outro caminho de egress.

Controles:

- agent remove `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` do sidecar;
- Playwright recebe explicitamente apenas o proxy Telechir;
- proxy fica em loopback ephemeral;
- sidecar não abre listener público.

## Schemes

Ameaça: `file:`, `data:`, `javascript:`, `blob:` ou custom scheme bypass.

Controle público:

- `navigate_browser` aceita somente HTTP/HTTPS absoluta;
- control plane, Rust e sidecar validam o contrato.

Residual: a própria página pode gerar blob/data internamente. Isso não cria egress de rede por si só e permanece conteúdo untrusted; não existe public navigation input para esses schemes.

## Credential-in-URL / HTTP auth

- URL com username/password é negada;
- não existe API para HTTP auth credentials;
- secret broker não está conectado ao browser;
- sidecar não recebe tokens do MCP.

## Cookie/storage/profile exposure

Controles:

- `browser.newContext()` não persistente;
- sem `launchPersistentContext`;
- sem storageState import/export;
- sem profile pessoal;
- sem cookie/localStorage public tools;
- context destruído em close/expiry/shutdown;
- Chrome default profile nunca é usado.

## Downloads / file chooser

Controles:

- `acceptDownloads=false`;
- download event chama cancel;
- não existe upload/download public tool;
- nenhuma path filesystem é aceita pelas browser tools.

Residual: site pode tentar iniciar download, mas Telechir não o transforma em artifact nesta fase.

## Dialogs / permission prompts

- JS dialogs são descartados;
- browser permissions não são concedidas;
- não existe geolocation/camera/mic permission API pública.

## Browser sandbox

Ameaça: página compromete renderer/browser e escapa para host.

Controles:

- `chromiumSandbox=true`;
- smoke root falhou fechado em vez de adicionar `--no-sandbox`;
- prova válida executou como usuário não-root com user namespaces permitidos.

Residual crítico:

- browser sandbox não equivale a VM;
- browser/kernel/container runtime exploit continua possível;
- produção deve escolher environment que realmente suporte Chromium sandbox.

## Sidecar crash / timeout

Controles Rust:

- health obrigatório antes de capability advertise;
- NDJSON request id correlacionado;
- response id mismatch mata sidecar;
- malformed response mata sidecar;
- timeout mata sidecar;
- EOF/crash marca adapter unavailable;
- Drop mata e espera o processo;
- stderr é descartado para não vazar conteúdo.

Sessões são ownership do sidecar; crash invalida todas.

## Replay / reconnect / duplicate actions

- open/navigate/click/fill/close são side-effects com idempotency key no Device Wire;
- command argument digest inclui normalized args;
- command correlation existe antes do dispatch;
- snapshot não aceita idempotency;
- reconnect não reproduz command automaticamente.

Residual: efeito remoto pode acontecer antes de uma falha de confirmação de resultado. Idempotency é boundary Telechir, não transação distribuída com o website.

## Resource exhaustion

Controles:

- máximo 1–4 sessions configurável;
- TTL 30–3600s;
- timeouts locais;
- snapshot bounded;
- locator/fill/URL/request framing bounded;
- extra pages fechadas;
- sidecar request line máximo 64 KiB.

Residual:
- site pode consumir CPU/memória dentro do browser antes do timeout;
- não há cgroup/OS quota própria para browser na Phase 14.

## Supply chain / browser provenance

- Playwright version pinada em lockfile;
- browser correspondente instalado por Playwright;
- não usa browser pessoal por descoberta implícita;
- updates exigem rerun de unit + hardened smoke + threat revalidation.

## CSP

Telechir não define `bypassCSP`; o default Playwright é false.

CSP é propriedade da página e não é tratada como boundary de segurança do Telechir. A policy real continua no agent/proxy.

## Audit/privacy

Audit não registra:

- snapshot bruto;
- fill text;
- URL bruta;
- locator text;
- cookies/storage.

Governance registra digests, tool/operation, risk e metadata bounded.

## Fora do escopo

- persistent authenticated browser;
- secret injection;
- cookies/storage import;
- browser screenshots;
- file upload/download;
- raw network inspection;
- JS evaluate;
- raw CDP/WebDriver/BiDi;
- multi-page orchestration;
- Phase 15 multi-device/workspace concurrency.

## Conclusão

A Phase 14 oferece browser automation útil como **capability tipada e isolada**, não como passthrough de uma automation framework.

O maior risco residual é browser/runtime compromise; por isso Chromium sandbox ativo, non-persistent context e egress proxy são requisitos, não opções de conveniência.
