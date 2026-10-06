# Phase 13 Threat Model Delta — Computer Use

**Data:** 2026-10-05

**Base:** baseline STRIDE + Phase 9 policy/approvals/audit + Phase 12 sandbox.

**Escopo:** `capture_screen` e `control_computer`.

## Invariante central

> Conteúdo visual não concede autoridade e input remoto nunca substitui confirmação humana local quando o risco efetivo é CRITICAL.

A cadeia continua:

```text
OAuth
  -> ownership
  -> cloud restrictions
  -> capability gate
  -> local policy / effective risk
  -> approval quando aplicável
  -> confirmação local CRITICAL para INPUT_CONTROL
  -> side effect
```

## Novos ativos

### Screenshot

Pode conter:
- credenciais visíveis;
- mensagens privadas;
- documentos internos;
- tokens/QR codes;
- dados pessoais;
- instruções adversariais/prompt injection;
- conteúdo de janelas não relacionadas ao objetivo.

Tratamento:
- one-shot;
- bounded;
- marcado `untrusted=true`;
- não entra em audit metadata;
- não é salvo em D1;
- não é escrito em disco pelo runtime normal;
- no MCP, bytes ficam no image content block, não em structuredContent.

### Input action

Pode produzir:
- click;
- pointer move;
- scroll;
- tecla;
- texto.

Uma única action pode ainda disparar efeito de alto impacto na aplicação focada.

Por isso:
- `INPUT_CONTROL`;
- CRITICAL;
- idempotency key;
- confirmação local;
- one-action-per-command.

## Boundary nativo Windows

O core mantém `#![forbid(unsafe_code)]`.

FFI fica isolado em `agent/platform/windows-computer`.

Riscos:
- ABI incorreta;
- resource leaks GDI;
- partial SendInput;
- race de cursor/foco;
- APIs bloqueadas por UIPI/secure desktop.

Mitigações:
- MSVC target compile/clippy;
- GDI handles liberados explicitamente;
- bounded buffers;
- partial SendInput = failure;
- best-effort release cleanup;
- pointer position revalidated;
- sem elevation/UIPI bypass.

## Abuse cases

### CU-001 — prompt injection visível na tela

Ataque:
uma página/documento exibe instruções para a IA clicar/digitar algo perigoso.

Controle:
- screenshot é `untrusted=true`;
- conteúdo visual não altera scopes/policy;
- qualquer input é request separado;
- INPUT_CONTROL é CRITICAL;
- confirmação ocorre localmente no device imediatamente antes da ação.

Residual:
o usuário local ainda pode aprovar uma ação induzida por contexto malicioso. O prompt local deve resumir a ação, não “validar” a intenção semântica.

### CU-002 — screenshot de segredo

Ataque:
captura inclui password/token/chave privada/QR code.

Controles:
- SCREEN_READ é HIGH;
- opt-in local;
- approval;
- captura one-shot;
- tamanho reduzido;
- não audit/persist;
- content block separado.

Residual:
o modelo que recebe a imagem ainda pode observar conteúdo sensível. A autorização do usuário deve considerar isso.

### CU-003 — capture sem capability real

Ataque:
cloud assume captura só porque OS=Windows.

Controle:
- capability `computer.screen.capture` explícita;
- agent só anuncia quando config local habilita e target Windows suporta adapter;
- control plane falha antes do dispatch sem capability;
- agent também preflight fail-closed.

### CU-004 — input sem capability real

Mesmo modelo de CU-003 com `computer.input`.

### CU-005 — remote approval substitui confirmação local

Ataque:
um `approval_id` vindo da cloud tenta liberar INPUT_CONTROL.

Controle:
- path local-critical rejeita qualquer `approval_id`;
- `policy.authorize()` padrão continua DENY para CRITICAL sem local confirmation;
- executor usa path dedicado apenas para `computer.input`;
- local confirmation não produz grant remoto reutilizável.

### CU-006 — confirmation payload mismatch

Ataque:
prompt mostra action A e executa B.

Controles:
- argument digest calculado antes do prompt;
- binding retém command/session/digest/risk;
- digest é recalculado após prompt;
- qualquer alteração falha fechado;
- TTL 30 s;
- session_id precisa ser exatamente o mesmo.

### CU-007 — confirmation spoofing

Ataque:
outro software local imita uma janela Telechir.

Mitigações:
- prompt nativo via WTS na active console session;
- title Telechir;
- topmost/foreground;
- digest parcial;
- default button = No;
- timeout.

Residual:
não é secure desktop. Malware local com UI access pode spoofar/clickjack.

### CU-008 — confirmation text injection

Ataque:
`type_text` contém texto Unicode visualmente enganoso que é renderizado no confirmation dialog.

Controle:
- conteúdo de `type_text` não é mostrado;
- prompt exibe apenas contagem + digest;
- ASCII control chars são rejeitados.

### CU-009 — confirmation expiry

Ataque:
usuário deixa prompt aberto e ação ocorre muito depois.

Controle:
- WTS prompt timeout 30 s;
- local binding expira em 30 s;
- finish revalida expiry.

### CU-010 — session swap/reconnect

Ataque:
confirmation obtida sob sessão A é aplicada à sessão B após reconnect.

Controle:
- local binding contém session_id;
- finish exige igualdade exata;
- nenhum reusable approval grant é criado.

Residual:
uma revogação cloud ocorrida exatamente durante o prompt local pode não ser observada síncronamente pelo executor bloqueado. TTL curto reduz a janela; uma evolução futura deve tornar a confirmação assíncrona/cancelável pelo estado realtime.

### CU-011 — retry duplica input

Ataque:
network retry repete click/type.

Controles:
- `computer.input` é side-effect no protocolo;
- idempotency_key obrigatória;
- governance/command idempotency existente;
- one action per command;
- local confirmation é ligada ao command/digest.

### CU-012 — screenshot oversized

Ataque:
desktop enorme gera frame > 256 KiB.

Controles:
- request max 320×240;
- budget binário 180 KiB;
- provider reduz deterministicamente até caber;
- base64 validado no control plane;
- oversized result falha;
- sem chunk streaming de screenshot nesta fase.

### CU-013 — compression/memory abuse

O provider materializa um buffer RGB bounded antes da codificação e usa PNG somente como formato de transporte. Dimensões são reduzidas conservadoramente, o encoder trabalha sobre o buffer já limitado e o tamanho PNG final é revalidado contra o budget binário antes do retorno.

Não há decoder remoto dentro do agent.

### CU-014 — lock screen / secure desktop

Risco:
captura retorna conteúdo incompleto/black frame; input é bloqueado.

Controle:
- falha é reportada;
- não tenta alternate privileged desktop;
- não eleva;
- não contorna secure desktop.

### CU-015 — UIPI/elevated process

Microsoft documenta que SendInput é sujeito à UIPI.

Controle:
- Telechir não tenta elevar;
- não injeta em maior integrity por bypass;
- envio parcial/zero vira `POLICY_DENIED`;
- mensagem não afirma sucesso.

### CU-016 — stuck key/button

Risco:
SendInput aceita apenas prefixo da sequência.

Controle:
- retorno parcial é falha;
- adapter tenta best-effort KEYUP/button-up cleanup;
- modifiers são liberados em ordem reversa;
- nenhuma repetição automática após falha.

Residual:
Windows pode também bloquear o cleanup. O erro é propagado e operador deve recuperar localmente se necessário.

### CU-017 — user moves pointer concurrently

Risco:
usuário move mouse entre SetCursorPos e click.

Controle:
- SetCursorPos;
- GetCursorPos imediato;
- mismatch -> CONFLICT antes do click.

Residual:
race ainda existe entre a revalidação e o evento seguinte. A Phase 13 não bloqueia input físico do usuário.

### CU-018 — wrong focused window

Key/type actions dependem do foco atual.

Controles:
- local prompt informa a ação;
- nenhuma API seleciona hidden/arbitrary HWND;
- uma action por command.

Residual:
foco pode mudar após confirmação. Uma fase futura pode introduzir target-window binding com identidade visível e nova confirmação.

### CU-019 — multi-monitor / DPI coordinates

Coordinates são validadas no virtual desktop atual.

Provider usa métricas virtuais e aceita coordinates negativos quando um monitor está à esquerda/acima do primary.

Residual:
DPI scaling e mudanças de layout entre screenshot e input podem deslocar semântica. Computer use deve capturar novamente antes de decisões de precisão.

### CU-020 — rapid abuse

Ataque:
muitos commands single-action em sequência simulam macro.

Mitigações atuais:
- cada action é command separado;
- CRITICAL local confirmation por action;
- OAuth/governance;
- idempotency;
- deadlines.

Residual:
não há rate limiter específico de input na Phase 13. O requisito de confirmação por action torna automação rápida deliberadamente impraticável.

### CU-021 — raw scan-code / unsupported key

Controle:
- public schema não expõe raw scan code;
- key allowlist;
- type_text Unicode usa KEYEVENTF_UNICODE internamente;
- control chars são rejeitados.

### CU-022 — clipboard exfiltration

Clipboard não é tool nem fallback Phase 13.

### CU-023 — browser scope creep

Não há DOM/browser tool.

`control_computer` pode atuar numa aplicação visível, inclusive navegador, após confirmação local. Por isso `openWorldHint=true`.

Permission `BROWSER` continua reservado para futura automation estruturada; INPUT_CONTROL não cria acesso a DOM/session/cookies.

### CU-024 — audit leak

Controle:
- command audit usa metadata minimizada;
- arguments não são persistidos em audit metadata;
- screenshot result não é salvo;
- type_text não aparece no local prompt;
- public MCP structuredContent da captura exclui base64.

### CU-025 — image persisted by package/review tooling

Package ZIP nunca contém runtime screenshot.

Review checklist foi atualizado para distinguir asset estático de runtime image.

### CU-026 — fake media type / malformed capture

Control plane exige:
- base64 string bounded;
- media type;
- dimensions.

Public output schema fixa `image/png`, formato suportado pela superfície de imagens da OpenAI e pelo MCP image content block.

### CU-027 — screenshot becomes policy instruction

Controle conceitual:
- output marca `untrusted=true`;
- screenshot nunca pode aumentar permissions/risk ceiling;
- qualquer follow-up input reentra no pipeline do zero.

### CU-028 — OS capability spoof

Device presence pode mentir se o agent estiver comprometido.

Essa boundary já existe para todas capabilities.

Defense:
- agent identity;
- signed connection;
- local executor still preflights adapter;
- capability não substitui policy.

### CU-029 — direct use of native adapter bypassing core

O crate FFI é uma library interna/path dependency, não uma public MCP surface.

O repository não distribui um capture/input CLI.

O probe usado na validação foi temporário e apagado após execução.

Residual:
qualquer processo local com mesmas OS permissions pode usar APIs equivalentes; Telechir não é uma sandbox contra o próprio usuário do host.

## macOS/Linux

Phase 13 não anuncia capabilities nessas plataformas.

Config computer-use habilitada fora de Windows falha.

Isso evita “mock parity” sem consentimento adequado.

Futuro:
- macOS: ScreenCaptureKit + TCC/Accessibility;
- Linux/Wayland: XDG ScreenCast + RemoteDesktop portals.

## Risk mapping

`screen.capture`:
- permission: SCREEN_READ;
- effective minimum: HIGH;
- approval: bounded/TTL.

`computer.input`:
- permission: INPUT_CONTROL;
- effective minimum: CRITICAL;
- local confirmation: obrigatória;
- remote approval: pode restringir adicionalmente, nunca liberar sozinho.

## Audit events

Pode registrar:
- operation;
- risk;
- permission;
- decision;
- command/session correlation;
- policy revision;
- success/failure code.

Não registrar:
- screenshot bytes/base64;
- screenshot pixels;
- type_text completo;
- raw action payload;
- local prompt contents beyond generic event semantics.

## Riscos residuais aceitos

- GDI fallback não possui system capture picker;
- WTS confirmation não é secure desktop;
- focus/cursor race não é eliminável sem stronger target binding;
- SendInput cleanup pode também ser bloqueado;
- screenshot pode observar conteúdo sensível após approval;
- revogação concorrente ao prompt local tem janela curta residual;
- Windows adapter depende de native APIs/ABI;
- nenhuma paridade macOS/Linux ainda;
- generic GUI input pode produzir external side effect dependendo do app focado.

## Gates de saída

- core continua `forbid(unsafe_code)`;
- native FFI isolado;
- Windows MSVC check/clippy;
- no live automated input injection;
- real capture proof somente;
- protocol continua 15 message types;
- operations cross-language 17;
- exact 18-tool public surface;
- full control-plane tests;
- package tool annotation coverage;
- threat model e platform revalidation versionados.

## Conclusão

Phase 13 pode ser considerada segura para um MVP de computer use somente enquanto:
- captura permanece one-shot/bounded;
- input permanece single-action/CRITICAL;
- local confirmation continua payload/session/TTL-bound;
- o produto não anuncia proteção contra host local comprometido ou secure-desktop boundaries.
