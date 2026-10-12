# Phase 16 — Preflight nativo do Local Agent em host Windows físico

**Data:** 2026-10-12 (America/Sao_Paulo)
**Host de homologação:** Windows x86_64 MSVC autorizado, via Desktop Commander Remote, sem dados pessoais registrados.
**Issue de implementação:** [#82 — Operational Local Agent runtime](https://github.com/sylviohmartins/telechir/issues/82)
**Issue de certificação:** [#49 — Phase 16](https://github.com/sylviohmartins/telechir/issues/49)

## Resultado comprovado no Windows físico

Foi usado Rust **1.99.0** (`x86_64-pc-windows-msvc`) em checkout `main` limpo no merge `f0465b58b1ee3d3a951c14d1cf5e0b9805871bce`, depois validado o script desta branch sem alterações no código do Agent.

| Verificação | Resultado aferido |
|---|---|
| `cargo fmt --all -- --check` | **PASS**, sem mudanças |
| `cargo test --locked --all-features --offline` | **PASS: 96 testes**, 0 falhas (87 unitários do core + 1 credencial + 1 pairing + 7 protocolo) |
| `cargo clippy --locked --all-targets --all-features --offline -- -D warnings` | **PASS**, 0 avisos impeditivos |
| `cargo build --locked --all-features --offline --bin telechir-agent` | **PASS**, compilador Windows MSVC |
| Executável nativo com configuração limpa | **PASS**: exit 0 e capacidades `sandbox/screen/input/browser` desabilitadas |
| `TELECHIR_COMPUTER_INPUT_ENABLED=not-a-boolean` | **PASS fail-closed**: exit 2 e mensagem de configuração inválida |
| `git status` após as suites | **Limpo**; `CARGO_TARGET_DIR` mantido em diretório temporário |

O primeiro `cargo test --offline` não pôde iniciar porque o cache do Cargo não possuía `base64`. A única preparação necessária foi `cargo fetch --locked --target x86_64-pc-windows-msvc`; depois disso, toda a compilação/suite foi executada offline. O antivírus permaneceu ativo; não foi criada exclusão ou desabilitada proteção do sistema. O Windows possuía execução de scripts PowerShell restrita; a execução de preflight utilizou **somente um subprocesso PowerShell com política temporária**, sem alterar `CurrentUser` ou `LocalMachine`.

## Reprodutibilidade

- `scripts/interop/windows-agent-native-preflight.ps1`: valida Rustfmt, testes, Clippy, build e boot/invalidação de configuração, usando `CARGO_TARGET_DIR` temporário, subprocessos com ambiente `TELECHIR_*` limpo, sem executar ações de mouse/teclado.
- `.github/workflows/agent-windows-native.yml`: CI específica em Windows MSVC hospedado, toolchain `1.99.0` pinado, acionada em mudanças no `agent/` ou harness e por despacho manual. Sua aprovação prova reprodutibilidade de build/tests em runner Windows, **não** o E2E físico do produto.
- Para executar o mesmo teste **intencionalmente no Windows local**, após autorização explícita e com cache de dependências preparado: `./scripts/interop/windows-agent-native-preflight.ps1 -Offline -AllowLocalBuild`. **Por padrão, sem `-AllowLocalBuild`, o preflight falha fechado antes de qualquer compilação**, pois os crates geram vários executáveis `build-script-build.exe` analisados pelo Avast CyberCapture; prefira a CI Windows hospedada. A CI valida também que uma execução desassistida sem o flag é bloqueada. Se as políticas locais restringirem a execução, use o mecanismo aprovado para scripts assinados ou política restrita ao processo, **nunca** altere as políticas globais por conveniência.

## Bloqueio confirmado: executável não é serviço operacional

A inspeção de `agent/src/main.rs` comprovou que o binário atual chama somente `AgentConfig::from_env()`, imprime `telechir-agent 0.1.0 core ready` e encerra. **Não** instancia `DeviceIdentityManager`, não faz pairing, não obtém connection credential, não chama `connect_realtime`, não cria um runtime residente nem despacha comandos MCP ao executor local.

O core Rust implementa componentes relevantes nas Phases 1–15, mas **o encadeamento operacional do entrypoint não está implementado**. Não declarar `LOCAL_AGENT_E2E_PASS`, `PHASE_16_COMPLETE`, `BETA_READY` ou `PRODUCTION_READY` com base nesta evidência.

A [issue #82](https://github.com/sylviohmartins/telechir/issues/82) reúne os critérios: bootstrap seguro, identity/keyring, pairing, conexão outbound, dispatch tipado, enforcement local de policy/aprovações, audit, reconnect bounded, encerramento seguro e, depois, E2E com dispositivo autorizado e staging segregada. Não há autorização implícita para cloud, domínio, custo, plugin, input real ou publicação.

## Próximo gate real

Implementar o runtime local conforme #82, validá-lo inicialmente em **loopback com fixture isolada**, e somente então executar o vertical slice com pairing real e ambiente staging autorizado. Os testes de clientes OAuth/Keycloak existentes na Phase 16 **não** substituem esse gate.

**Estado do aceite:** `WINDOWS_NATIVE_CORE_PREFLIGHT_PASS` (host físico); `DEVICE_MCP_E2E_NOT_TESTED` (bloqueio operacional explícito).
