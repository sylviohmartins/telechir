# Telechir Browser Playwright Adapter

Adapter local da Phase 14 para browser automation tipada. Ele é executado pelo `telechir-agent` como subprocesso stdio; não abre listener público.

## Segurança por default

- Playwright `BrowserContext` não persistente;
- sem import/export de profile, cookies ou `storageState`;
- Chromium headless controlado pelo adapter;
- egress por proxy loopback próprio com resolução DNS validada e conexão pinada ao IP aprovado;
- somente HTTP/HTTPS em portas 80/443 no modo normal;
- loopback/private/link-local/documentation/multicast/intranet bloqueados;
- service workers bloqueados;
- WebSocket bloqueado na Phase 14;
- WebRTC/WebTransport desabilitados no contexto;
- downloads cancelados;
- popups/new pages fechados;
- dialogs descartados;
- sem CSS/XPath/arbitrary JavaScript/CDP/WebDriver na interface;
- stderr do sidecar é descartado pelo agent.

## Instalação local

Use a versão de Node configurada pelo agent e instale exatamente o lockfile:

```bash
npm ci
npx playwright install chromium
```

Em produção o agent recebe caminhos explícitos para o binário Node e `src/server.mjs`; nenhuma capability é anunciada até o health-check do sidecar confirmar o browser instalado.

## Testes

```bash
npm run check
node test/smoke.mjs
```

O smoke usa um servidor fixture em loopback com uma exceção interna exclusiva de teste. O agent remove `TELECHIR_BROWSER_TEST_ALLOW_LOOPBACK` ao iniciar o sidecar real.
