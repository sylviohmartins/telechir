# Phase 13 — Revalidação de Computer Use por Plataforma

**Data:** 2026-10-05
**Escopo:** captura de tela one-shot + uma ação tipada de input
**Status:** Windows implementado; macOS/Linux permanecem fail-closed nesta fase

## Conclusão

A Phase 13 não cria um remote desktop genérico. Ela adiciona dois primitives:

- `capture_screen` — observação pontual, bounded, HIGH;
- `control_computer` — uma ação tipada, CRITICAL, com confirmação humana local.

A arquitetura varia por plataforma porque os mecanismos oficiais de captura/input e consentimento também variam.

## Windows

### Captura moderna recomendada

A API moderna oficial é `Windows.Graphics.Capture`. A documentação recomenda:

- testar `GraphicsCaptureSession.IsSupported()`;
- usar o picker do sistema para o usuário escolher uma tela/janela;
- obter um `GraphicsCaptureItem`;
- iniciar a sessão de captura somente após consentimento explícito.

Fonte:
- https://learn.microsoft.com/windows/uwp/audio-video-camera/screen-capture
- https://learn.microsoft.com/uwp/api/windows.graphics.capture.graphicscaptureitem

### Decisão Phase 13: fallback GDI one-shot

O agent atual não possui UI WinUI nem window handle apropriado para hospedar o picker moderno. Para não construir uma UI host artificial nesta fase, a implementação Windows usa primitives Win32/GDI oficiais como fallback:

- desktop virtual via `GetSystemMetrics`;
- `StretchBlt`/capture DC;
- `GetDIBits`;
- pixels GDI 24-bit convertidos e codificados como PNG bounded.

Fontes:
- https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-bitblt
- https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-getdibits

Trade-off importante:

> GDI não oferece o picker/consentimento visual de Windows.Graphics.Capture.

Por isso o Telechir exige simultaneamente:
- opt-in local `TELECHIR_COMPUTER_SCREEN_ENABLED=true`;
- capability explícita `computer.screen.capture`;
- permission `SCREEN_READ`;
- risk mínimo HIGH;
- approval bounded/TTL;
- captura one-shot e reduzida;
- nenhuma persistência da imagem no audit.

Uma fase futura pode substituir o provider por Windows.Graphics.Capture sem alterar o contrato público.

### Input

A primitive oficial escolhida é `SendInput`.

Microsoft documenta que:
- sintetiza eventos de teclado/mouse;
- retorna quantos eventos conseguiu inserir;
- está sujeita a UIPI;
- só pode injetar em processos no mesmo ou menor integrity level;
- falha de UIPI não é distinguida de forma confiável por `GetLastError`;
- estado de teclas já pressionadas pode interferir.

Fonte:
- https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput

Decisões Telechir:
- não contornar UIPI;
- não elevar processo;
- retorno parcial é falha;
- em retorno parcial, tentar release cleanup de mouse/modifiers/keys;
- uma ação por command;
- sem raw scan-code público;
- sem clipboard fallback;
- sem script/macro arbitrária.

### Cursor/coordinates

Pointer move usa APIs Win32 e revalida a posição imediatamente após a mudança. Coordinates fora do virtual desktop atual falham antes da ação.

Isso reduz, mas não elimina, race com o usuário local movendo o mouse simultaneamente.

### Confirmação local CRITICAL

`WTSGetActiveConsoleSessionId` retorna a sessão anexada ao console físico; quando não existe sessão ativa retorna `0xFFFFFFFF`.

Fonte:
- https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-wtsgetactiveconsolesessionid

`WTSSendMessageW` permite apresentar uma message box na sessão alvo, esperar resposta e aplicar timeout.

Fonte:
- https://learn.microsoft.com/windows/win32/api/wtsapi32/nf-wtsapi32-wtssendmessagew

Phase 13 usa:
- active console session;
- Yes/No;
- botão default = No;
- topmost/foreground;
- timeout 30 s;
- resumo bounded;
- digest parcial;
- texto de `type_text` oculto;
- fail-closed se prompt não puder ser exibido.

Esse prompt é uma confirmação Telechir local, não secure-desktop UI. Ele reduz risco de side effect remoto silencioso, mas não é imune a spoofing por outro software local comprometido.

## Boundary de código nativo Windows

O crate principal `telechir-agent` mantém:

```rust
#![forbid(unsafe_code)]
```

Win32 FFI foi isolado em:

```text
agent/platform/windows-computer/
```

O core usa apenas uma wrapper API segura e converte tipos/resultados.

Objetivos:
- não relaxar `forbid(unsafe_code)` no agent;
- tornar FFI pequeno e revisável;
- facilitar substituição futura por Windows.Graphics.Capture;
- permitir gate Windows dedicado com clippy.

## Prova real de captura

Foi executado no PREDATORH300 um probe Win32 não destrutivo equivalente ao caminho GDI adotado pelo adapter, usando a desktop surface atual, downscale bounded e PNG temporário.

Nenhuma ação de input foi disparada.

Resultado:

```text
virtual desktop = 1920x1080
bounded capture = 256x144
PNG bytes = 37454
PNG signature = 89504E470D0A1A0A
binary budget = 184320
temporary artifact removed = true
```

O PNG foi apagado imediatamente após a validação; a screenshot não foi aberta, analisada ou commitada.

Separadamente, o **crate Rust real** `telechir-windows-computer` passou:
- `cargo clippy --target x86_64-pc-windows-msvc -- -D warnings`;
- `cargo check --locked --all-features --target x86_64-pc-windows-msvc`.

Assim, a evidência de runtime prova o comportamento Win32/GDI no host e a evidência Rust prova que o adapter nativo implementado compila/linta para o target oficial. A Phase 13 não afirma que o binário Rust do adapter foi executado diretamente no Windows nesta sessão.

## macOS

A API oficial atual é ScreenCaptureKit.

Apple recomenda:
- permission de Screen Recording;
- `NSScreenCaptureUsageDescription`;
- seleção de conteúdo pelo `SCContentSharingPicker`;
- ScreenCaptureKit para displays/apps/windows.

Fontes:
- https://developer.apple.com/documentation/ScreenCaptureKit
- https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos

Para input, Core Graphics expõe `CGEvent` e `post(tap:)`.

Fonte:
- https://developer.apple.com/documentation/coregraphics/cgevent
- https://developer.apple.com/documentation/coregraphics/cgevent/post(tap:)

Phase 13 **não** implementa adapter macOS. Configuração computer-use em plataforma não suportada falha fechado e capabilities não são anunciadas.

Uma futura implementação precisa respeitar:
- Screen Recording permission;
- Accessibility/Input Monitoring conforme API adotada;
- system selection/consent;
- nenhuma tentativa de burlar TCC.

## Linux / Wayland

O caminho oficial interoperável é XDG Desktop Portal.

### ScreenCast portal

Lifecycle:
- `CreateSession()`;
- `SelectSources()`;
- `Start()` normalmente mostra dialog ao usuário;
- `OpenPipeWireRemote()` entrega o stream.

Fonte:
- https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html

### RemoteDesktop portal

Lifecycle:
- `CreateSession()`;
- `SelectDevices()` para keyboard/pointer/touch;
- `Start()` apresenta dialog ao usuário;
- o resultado indica quais devices foram concedidos.

Pode ser integrado com ScreenCast na mesma sessão.

Fonte:
- https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html

Phase 13 não implementa X11 fallback nem tenta contornar Wayland/portal consent.

## Capabilities

As capabilities são de runtime, não inferidas pelo nome do OS:

```text
computer.screen.capture
computer.input
```

Somente um agent configurado com adapter real as anuncia.

O control plane rejeita a tool antes do dispatch quando a capability dedicada não está presente.

## Wire e limites

Nenhum novo Device Wire message type.

Continuam exatamente 15 message types.

O enum de `command_operation` passa a incluir:
- `screen.capture`;
- `computer.input`.

Captura:
- máximo solicitado 320×240;
- budget binário 180 KiB;
- output padrão 256×144;
- dimensões são reduzidas conservadoramente antes da codificação PNG e o tamanho codificado é revalidado antes do retorno;
- base64 + envelope precisam permanecer abaixo de 256 KiB.

Input:
- uma action;
- `type_text` <= 2.000 chars;
- click_count <= 2;
- scroll <= |1200|;
- key allowlist;
- modifiers allowlist/unique;
- sem controls em `type_text`.

## O que Phase 13 deliberadamente não faz

- screen streaming;
- remote desktop session contínua;
- OCR;
- accessibility tree;
- clipboard;
- browser DOM automation;
- macros;
- arrays de actions;
- raw scan-code API;
- UAC/secure desktop bypass;
- elevation;
- input em processo de maior integrity;
- macOS/Linux adapters.

## Conclusão

A implementação Windows é útil para one-shot capture e single-action input com confirmação local, mas permanece defense-in-depth e depende das garantias/permissões do Windows.

Computer use continua subordinado a OAuth, ownership, policy, approvals e consentimento local — nunca o contrário.
