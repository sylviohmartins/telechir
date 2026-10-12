# Agent runtime — supervisor explícito de sessão realtime (issue #82)

**Data:** 2026-10-12 (America/Sao_Paulo)
**Escopo:** primeiro incremento P0 para o runtime operacional do Local Agent, em **loopback isolado de CI**.
**Relações:** [issue #82](https://github.com/sylviohmartins/telechir/issues/82), [Phase 16 #49](https://github.com/sylviohmartins/telechir/issues/49), [PR #85](https://github.com/sylviohmartins/telechir/pull/85).

## Evidência executada

Na [CI Windows #38211952240](https://github.com/sylviohmartins/telechir/actions/runs/38211952240), com Rust 1.99.0 MSVC, o build real do Agent passou **99 testes** no total, incluindo **90 testes unitários** no core (três novos testes em `runtime::tests`) e nove testes de contrato/integridade, com `rustfmt --check`, Clippy `-D warnings`, build nativo e preflight fail-closed aprovados.

Os novos testes cobrem:

- **Credenciais:** `SessionCredentials::new` exige Bearer gráfico sem caracteres de controle, tamanho limitado e nonce base64url de 16–128 caracteres; `Debug` sempre é redigido e o material secreto é zerado no drop.
- **TLS / configuração:** URL `ws://` para host externo é recusada antes de qualquer tentativa de rede. `ws://127.0.0.1` fica reservado ao ensaio de loopback isolado. A conexão real fora do loopback exige `wss://`.
- **Handshake, comando e shutdown:** um servidor WebSocket sintético recebe `agent.hello`, devolve um `agent.hello_ack` coerente, envia `command.request` tipado, obtém `command.failed` da implementação de `DenyAll` sem side effect e observa o encerramento controlado da sessão.

O novo supervisor executa `connect_realtime` já implementado, usa `handle_next_server_message` para preservar autorização local, espera o heartbeat negociado pelo servidor, descarta ticks perdidos e encerra com limite de dois segundos após shutdown. Falhas de transporte/protocolo interrompem a sessão; **não existe reconnect automático nem replay**. A integração futura deve obter nova credential/nonce por prova de dispositivo a cada conexão.

## Delimitação de segurança e dívida P0

- A API exige **credencial de sessão e executor explicitamente fornecidos pelo host**. O tipo não obtém OAuth, gera keys, faz pairing nem lê tokens de variáveis de ambiente ou disco.
- `agent/src/main.rs` ainda somente valida configurações, imprime `core ready` e encerra. O supervisor **não foi ligado à CLI**; nenhum dispositivo real, conta, domínio, staging, cloud, input, browser, tela ou execução remota foi conectado/ativado.
- O novo módulo **não implementa** ainda registro/pareamento, broker de connection credentials, root/workspace policy operacional, reconnect por fresh token, supervisor residente com shutdown do SO ou auditoria de ponta a ponta. Esses requisitos permanecem em [#82](https://github.com/sylviohmartins/telechir/issues/82).
- O ensaio com `DenyAll` prova a preservação da recusa local e do contrato wire nesse caminho, mas **não** valida a UX real de aprovação ou o fluxo MCP em dispositivo físico.
- Nenhuma compilação Rust ocorreu no PC pessoal. O [workflow Windows hospedado](https://github.com/sylviohmartins/telechir/actions/workflows/agent-windows-native.yml) mantém o opt-in exigido para compilações, evitando novos alertas Avast no host.

## Próximo incremento

Implementar o **bootstrap explicitamente opt-in do Agent** com `NativeKeyringIdentityStore`, gates de pairing/credencial curta e allowlist de capacidades, mantendo a conexão desabilitada se qualquer requisito estiver ausente; depois certificar em loopback com `LocalCommandExecutor` e policy default-deny antes do E2E físico.

**Status:** `AGENT_REALTIME_SESSION_SUPERVISOR_LOOPBACK_PASS`; `PHYSICAL_DEVICE_MCP_E2E_NOT_TESTED`; Phase 16 continua em andamento.
