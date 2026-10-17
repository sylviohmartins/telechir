# G1-D — Aceite integrado do Local Agent em loopback

**Data:** 2026-10-17 (America/Sao_Paulo)
**Gate:** G1-D, [issue #82](https://github.com/sylviohmartins/telechir/issues/82)
**PR:** [#92](https://github.com/sylviohmartins/telechir/pull/92)
**Escopo:** integração real entre módulos do **Agent Rust** em loopback, com `ProvisioningApi` simulando exclusivamente o control plane. Nenhuma máquina de usuário, nuvem ou modelo de IA foi acessado.

## Resultado no Windows CI

O novo teste `agent/tests/g1d_agent_loopback.rs` passou na [CI Windows #39052105110](https://github.com/sylviohmartins/telechir/actions/runs/39052105110), head `88b29d457d828b44f9efe02b1de46e30c78e159f`, juntamente com **121 unitários + 12 de integração/contratos = 133 testes Rust**, Rustfmt, Clippy `-D warnings`, build MSVC e bootstrap fail-closed.

O teste `g1d_agent_pairing_credential_readonly_revoke_and_durable_audit_loopback` executou uma jornada integrada usando o código do Agent:

1. **Antes do pairing:** `serve_foreground_with_executor` falhou com `InvalidState`; não solicitou conexão ao backend e não abriu WebSocket.
2. **Pairing explícito:** `begin_pairing` em memória gerou identidade Ed25519 para o dispositivo de teste; estado `CREATED` fez `advance_pairing` permanecer `WaitingForUser`, sem salvar vínculo ou emitir assinatura de aprovação.
3. **Consentimento simulado:** o fake mudou para `USER_VERIFIED` no laboratório, sem pessoa real nem Dashboard. O Agent assinou `PairingProof`, o mock **verificou criptograficamente** Ed25519 contra a chave pública do cadastro e retornou `ACTIVE`; o vínculo foi salvo uma vez.
4. **Sem transferência silenciosa:** nova tentativa de pairing com vínculo ativo retornou `InvalidState`, preservando a identidade.
5. **Revogação:** mock negou `issue_credential`; o host retornou `Provisioning(Denied)` antes do upgrade WebSocket.
6. **Conexão autorizada:** o mock validou assinatura Ed25519 da `ConnectionCredentialProof`, audience `telechir-control-plane/realtime`, timestamp recente, nonce novo e unicidade; devolveu credential sintética válida por 30 segundos e path canônico. O mesmo `serve_foreground_with_executor` iniciou WebSocket **real em 127.0.0.1**, com apenas seis capacidades read-only.
7. **Policy em operação:** `agent.hello/ack` foi negociado; `fs.list` recebeu `command.accepted` e `command.completed`; uma solicitação com `FS_WRITE` recebeu `command.failed` com `POLICY_DENIED`.
8. **Audit durável:** após encerramento por sinal local, o arquivo JSONL externo à raiz continha `Allowed → Completed → Denied`, sem IDs crus, caminho do workspace ou conteúdo do arquivo.
9. **Encerramento:** `serve_foreground_with_executor` retornou normalmente após o sinal de shutdown, sem reusar credential nem persistir Bearer.

**Cobertura de risco:** fail-closed pré-pairing, gating por confirmação simulada, binding de identidade, proof Ed25519 efetivamente verificada, rejeição de revoked/disabled na emissão, nonce único, read-only, auditoria persistente e shutdown.

## Limites do aceite e próximos gates

- **G1-D = aceite integrado em loopback do Agent**, usando a mesma composição `host::serve_foreground_with_executor` usada na CLI. A confirmação humana, status de usuário, provisionamento HTTP e emissão OAuth no control plane foram **simulados** por `VerifiedLoopbackApi` local. O teste não prova rede TLS externa, Keycloak, D1/DO, nem um usuário confirmar pairing na interface.
- A integração real **Agent ↔ Worker/D1/DO ↔ Remote MCP/OAuth** com permissão por owner/workspace e auditoria ponta a ponta será testada no **G2**; G1-D não substitui esse gate.
- Não foi configurado staging, dispositivo pessoal, serviço Windows, input remoto, shell mutável, browser automation ou publicação.
- **Concluir G1-D somente após as duas pipelines verdes no último head** (Windows 1/1, MCP/Keycloak 3/3), merge e limpeza de branch; até então, evidência é da CI inicial descrita acima.
- **G1 completo** significa A/B/C/D integrados e aceitos; a conclusão de G1 **não** significa MVP. O MVP técnico ainda requer G2, G3 autorizado e G4 físico.

**Proteção Avast:** todas as compilações Cargo foram executadas no GitHub-hosted Windows runner, não no computador pessoal.
