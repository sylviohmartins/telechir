# Phase 14 — Revalidação de Browser Automation

**Data:** 2026-10-07
**Escopo:** Browser automation isolada, tipada e bounded
**Status:** arquitetura revalidada contra documentação oficial corrente

## Objetivo

A Phase 14 adiciona browser automation como autoridade própria do Telechir, separada de `INPUT_CONTROL`, shell, filesystem e Network permission genérica.

A superfície pública não expõe Playwright, CDP, WebDriver ou JavaScript arbitrário. Ela expõe somente seis operações tipadas:

1. `open_browser_session`;
2. `get_browser_snapshot`;
3. `navigate_browser`;
4. `click_browser`;
5. `fill_browser`;
6. `close_browser_session`.

## Playwright — isolamento e browser binaries

A documentação oficial corrente do Playwright continua tratando `BrowserContext` como primitive de isolamento e diferencia contexts não persistentes de `launchPersistentContext(userDataDir)`, que grava/reutiliza cookies e local storage.

A Phase 14 usa apenas context não persistente e não oferece `storageState`, profile import/export ou `userDataDir` público.

Playwright também documenta que sua versão funciona melhor com a versão de Chromium que acompanha o package e não garante compatibilidade com browsers arbitrários. Por isso o adapter fixa:

```text
playwright = 1.63.0
```

e o operador instala o browser correspondente por Playwright.

Fonte:
- https://playwright.dev/docs/api/class-browsertype
- https://playwright.dev/docs/api/class-browsercontext

## Chromium sandbox

A opção `chromiumSandbox` existe explicitamente no Playwright e seu default é `false`.

Telechir configura:

```text
chromiumSandbox: true
```

A documentação Docker do Playwright alerta que executar browser como root desabilita o Chromium sandbox e recomenda usuário separado + seccomp com user namespaces para crawling/scraping de páginas não confiáveis.

Esse ponto foi comprovado durante os gates:

1. smoke executado como root com `chromiumSandbox:true` falhou fechado com mensagem do Chromium de que root sem `--no-sandbox` não é suportado;
2. o runtime **não** foi relaxado para `chromiumSandbox:false`;
3. o smoke válido foi repetido como usuário não-root, com user namespace permitido no runner de teste, e passou.

Fonte:
- https://playwright.dev/docs/api/class-browsertype
- https://playwright.dev/docs/next/docker

## Routing e Service Workers

A documentação Playwright informa que requests interceptados por Service Worker não passam necessariamente pelo routing da página/context e recomenda `serviceWorkers: "block"` quando request interception é usada.

Telechir usa:

```text
serviceWorkers: "block"
```

Embora o principal enforcement de egress da Phase 14 seja um proxy próprio do adapter — e não `page.route()` — bloquear Service Workers reduz outra rota de comportamento de rede persistente/indireto.

Fonte:
- https://playwright.dev/docs/api/class-browsercontext
- https://playwright.dev/docs/network

## WebSockets

Playwright expõe `browserContext.routeWebSocket()` e recomenda registrar a route antes da criação de WebSockets.

Telechir registra a regra imediatamente após criar o context e antes da page principal. Toda tentativa de WebSocket é fechada com policy violation.

Além disso, o proxy HTTP local rejeita `Upgrade`, oferecendo uma segunda camada.

Fonte:
- https://playwright.dev/docs/api/class-browsercontext
- https://playwright.dev/docs/network

## Egress anti-SSRF

A policy de rede fica fora da página e é aplicada por proxy loopback próprio.

Produção:

- somente HTTP/HTTPS;
- somente portas 80/443;
- sem URL com userinfo/credentials;
- sem localhost/intranet/single-label hostnames;
- sem RFC1918;
- sem loopback;
- sem link-local;
- sem carrier-grade NAT;
- sem multicast;
- sem unspecified/documentation/benchmark ranges;
- sem IPv4-mapped IPv6;
- DNS resolve all: qualquer address não público causa deny;
- conexão upstream é feita para o IP já validado, preservando `Host`;
- redirects/subresources passam novamente pelo proxy;
- CONNECT também resolve/valida antes de tunelar;
- proxy credentials não são encaminhadas;
- env `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` são removidas pelo agent;
- QUIC é desabilitado;
- WebTransport/WebRTC ficam desabilitados/bloqueados na Phase 14.

O target inicial de `navigate_browser` também passa por resolução explícita antes do `page.goto`, e a URL final é revalidada depois da navegação.

## Smoke real hardened

O smoke usa apenas servidor fixture local e ativa uma exceção de loopback **somente para teste**.

A prova validou:

- health ready;
- context isolado/non-persistent;
- open;
- navigate;
- semantic snapshot;
- bounded fill;
- bounded click;
- close idempotente;
- redirect permitido -> `localhost` protegido;
- subresource para `localhost` protegido;
- WebSocket para `localhost` protegido.

Resultado:

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

O teste foi executado como usuário não-root com Chromium sandbox ativo. O `seccomp=unconfined` foi usado **somente no runner Docker local** para permitir user namespaces na prova; não altera o código, a configuração do adapter ou o perfil de produção.

## Chrome 136+

O Chrome passou a ignorar `--remote-debugging-port` / `--remote-debugging-pipe` quando usados contra o diretório de dados padrão a partir do Chrome 136, exigindo `--user-data-dir` não padrão. A própria equipe Chrome recomenda Chrome for Testing em cenários de automação.

Essa mudança reforça a decisão da Phase 14 de nunca controlar o profile pessoal/default do usuário e de manter browser binary/profile sob ownership do adapter.

Fonte:
- https://developer.chrome.com/blog/remote-debugging-port

## WebDriver / WebDriver BiDi

O W3C mantém WebDriver como família de especificações, com Recommendation de 2018 e Working Draft mais recente em 2026.

WebDriver BiDi foi publicado como **Working Draft em 30 de setembro de 2026**. Portanto ele permanece direção relevante para interoperabilidade futura, mas não é contrato público do Telechir Phase 14.

A superfície pública continua typed Telechir; o adapter Playwright pode ser substituído sem mudar Device Wire/MCP.

Fontes:
- https://www.w3.org/TR/webdriver/
- https://www.w3.org/TR/webdriver-bidi/

## Chrome/Playwright não são authority

A presence de Node, Chrome ou Playwright no host não habilita nada por si só.

Capability só é anunciada se:

1. `TELECHIR_BROWSER_ENABLED=true`;
2. Node binary e adapter script explícitos são válidos;
3. sidecar inicia;
4. request `health` consegue lançar Chromium com o sandbox configurado;
5. health retorna `ready=true`.

Falha em qualquer passo mantém Browser indisponível.

## Decisão

Playwright 1.63.0 + Chromium controlado pelo adapter é aceitável como provider inicial da Phase 14, desde que:

- context permaneça ephemeral/non-persistent;
- Chromium sandbox permaneça ligado;
- egress proxy seja obrigatório;
- raw Playwright/CDP/WebDriver/JS não seja exposto;
- BROWSER continue permission própria e HIGH;
- página/snapshot sejam sempre tratados como untrusted data.

WebDriver BiDi fica como futura direção de adapter/interoperabilidade, não como dependência do contrato atual.
