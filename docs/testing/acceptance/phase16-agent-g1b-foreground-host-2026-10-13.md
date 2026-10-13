# G1-B — Executável Agent com pairing explícito e host foreground default-deny

**Data:** 2026-10-13 (America/Sao_Paulo)  
**Gate:** G1 / [issue #82](https://github.com/sylviohmartins/telechir/issues/82)  
**PR:** [#89](https://github.com/sylviohmartins/telechir/pull/89)  
**CI Windows aferida:** [#38437835854](https://github.com/sylviohmartins/telechir/actions/runs/38437835854) (validação anterior do lockfile); [#38438411637](https://github.com/sylviohmartins/telechir/actions/runs/38438411637) — **1/1 success** no código funcional antes deste aceite.

## Entrega comprovada na CI hospedada

O binário `telechir-agent` agora implementa três comandos opt-in, além do modo anterior sem parâmetros:

| Comando explícito | Ação autorizada |
|---|---|
| Sem argumentos | Validação de configuração e `core ready`; **sem keyring, pairing, conexão ou serviço** |
| `--help` | Mostra sintaxe e informa que o host ainda usa execução `deny-all` |
| `pair-start <https-origin> <display-name>` | Cria ou carrega identidade local no keyring, solicita pairing ao control plane e exibe código/URI apenas a quem iniciou explicitamente a ação |
| `pair-check <https-origin> <pairing-id>` | Consulta pairing previamente iniciado; assina challenge somente após `USER_VERIFIED`; persiste associação somente quando `ACTIVE` |
| `serve <https-origin>` | Foreground explícito: carrega identidade e vínculo existentes, obtém **nova** credential curta/nonce para cada tentativa, conecta via supervisor WebSocket e nega **todas** as operações remotas até G1-C |

A origem é validada pelo adapter HTTPS do G1-A (sem credenciais embutidas, redirects ou HTTP fora de loopback). O host recusa configuração com sandbox/screen/input/browser habilitados e não faz pareamento implícito. Falhas de armazenamento/provisionamento são redigidas, sem imprimir bearer, signing key, challenge ou payload do erro remoto. O Ctrl+C encerra de forma graciosa, e a reconexão é limitada a três tentativas, **sempre com credential nova**; não há replay de comandos.

O `DenyAllHostExecutor` implementa `CommandExecutor` e responde `POLICY_DENIED`, sem disparar filesystem, shell, Git, browser, screen ou input. Mesmo uma invocação direta indevida de `execute` retorna uma falha, não um efeito colateral.

### Marcadores de verificação

[Windows CI #38438411637](https://github.com/sylviohmartins/telechir/actions/runs/38438411637):

- `111 passed; 0 failed` na suíte unitária Rust; suites de integração e contratos também verdes;
- `PASS: AGENT_WINDOWS_CLIPPY` — Clippy `-D warnings`;
- `PASS: AGENT_WINDOWS_BINARY_BUILD` — executável MSVC;
- `PASS: AGENT_WINDOWS_BOOTSTRAP_SAFE_DEFAULTS` — sem argumentos mantém capacidades sensíveis desligadas;
- `PASS: AGENT_WINDOWS_INPUT_CONFIG_FAIL_CLOSED`;
- `PASS: AGENT_WINDOWS_FOREGROUND_HELP`;
- `PASS: AGENT_WINDOWS_FOREGROUND_ARGS_FAIL_CLOSED` — `serve` sem origem ou com HTTP remoto inseguro é recusado antes do keyring/rede;
- `RESULT: TELECHIR_AGENT_WINDOWS_NATIVE_PREFLIGHT_PASS`.

Os novos testes Rust unitários validaram parser explícito, default seguro, execução `deny-all`, rejeição de configurações sensíveis e **zero chamadas HTTP com identidade ausente ou shutdown anterior ao provisionamento**.

## Limitações e continuidade

- **Ainda não validado:** pairing humano realizado num ambiente hospedado ou dispositivo físico, autenticação e sessão real de ponta a ponta por CLI; os testes G1-B comprovam as peças em CI, não a jornada externa.
- **G1-C pendente:** o executor produtivo ainda não está ligado ao host. Esta é uma escolha de segurança; não habilitar leitura ou escrita até haver roots/workspaces, policy, approvals e audit verificados na composição operacional.
- **G1-D pendente:** sessão/execução integradas de ponta a ponta em loopback Worker/D1/Agent; **G2/G3/G4** permanecem abertos.
- Não foi instalado serviço do Windows, ativado autostart, executada ação local, criada conta, contratado staging ou realizado deploy.
- **Avast preservado:** compilação ocorreu apenas no GitHub Actions Windows; no computador pessoal o único comando permitido foi Rustfmt sem compilação.

**Status:** `G1-B_FOREGROUND_HOST_CI_PASS` com segurança `DENY_ALL`; `DEVICE_E2E_NOT_TESTED`. O **G1 geral permanece EM EXECUÇÃO** e a prioridade técnica passa ao G1-C (executor/policy/audit com gates fail-closed), não a novos clientes MCP.
