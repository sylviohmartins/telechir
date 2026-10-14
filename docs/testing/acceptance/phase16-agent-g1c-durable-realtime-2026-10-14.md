# G1-C — Agent read-only: auditoria persistente e autorização no WebSocket

**Data:** 2026-10-14 (America/Sao_Paulo)  
**Escopo:** encerramento **técnico do G1-C no perfil read-only**, condicionado à CI final e merge do [PR #91](https://github.com/sylviohmartins/telechir/pull/91).  
**Issue:** [#82](https://github.com/sylviohmartins/telechir/issues/82)  
**Histórico do perfil:** [PR #90](https://github.com/sylviohmartins/telechir/pull/90) e [aceite inicial](phase16-agent-g1c-readonly-2026-10-14.md).

## Entrega funcional

O executável do Agent já tem comandos de pairing e de sessão foreground com opt-in, control plane HTTPS e credenciais curtas (G1-A/G1-B). O perfil conservador read-only mantém somente seis capacidades: `fs.list`, `fs.stat`, `fs.read`, `fs.search`, `git.status`, `git.diff`; outras 17 operações são recusadas. `serve` sem permissão de leitura permanece deny-all, e iniciar a CLI sem argumentos não cria conexão.

Neste incremento, o perfil read-only **exige um arquivo de auditoria novo** em diretório já existente e **fora** do workspace autorizado. A sintaxe muda intencionalmente para:

```text
telechir-agent serve-readonly <https-origin> <absolute-root> <new-absolute-audit-file>
```

Sem esse quarto argumento, com audit path relativo, audit file preexistente (inclusive symlink), diretório de audit dentro do root, localização inacessível ou diretório de root inválido, a CLI falha sem abrir WebSocket.

O journal registra, em JSONL, `schema_version=1`, sequência monotônica por sessão, operação, decisão (`Allowed`/`Denied`/`Completed`/`Failed`), instante UTC e digest SHA-256 base64url do command ID. **Não** guarda IDs crus, argumentos, caminhos, conteúdo de arquivos, bearer tokens, URLs de OAuth ou códigos de pairing. Para cada decisão o registro é persistido com `sync_data()` **antes** da resposta de autorização ou conclusão; a gravação de um evento de conclusão que falhar impede a resposta de sucesso. Se uma gravação/sync falhar, o executor fica permanentemente **fail-closed durante a sessão**. A auditoria em memória continua limitada a 256 eventos e o replay guard a 1.024 command IDs.

O arquivo usa `OpenOptions::create_new`; no Unix a criação solicita modo `0600`, e no Windows a proteção de acesso depende da ACL herdada do diretório previamente escolhido pelo operador. **Não é uma trilha criptograficamente inviolável**, não existe hash-chain ancorada nem evidência de imutabilidade perante um administrador local. O objetivo comprovado é persistência entre processos e negativa de operações se o journal não estiver gravável. Uma nova sessão requer um **novo nome de arquivo**; não sobrescrever um journal anterior.

## Evidências executadas e limites

A [CI Windows #38609665975](https://github.com/sylviohmartins/telechir/actions/runs/38609665975), no head `11df6fe8e8f6d26242a3209662e45af730a66397`, concluiu com **1/1 success** e:

- **119 testes unitários**, 0 falhas, mais **11 testes de integração/contrato** (total 130), Rustfmt, Clippy `-D warnings`, build MSVC e validações de argumentos da CLI.
- `readonly_host_durable_journal_persists_redacted_outcomes_outside_root`: grava `Allowed → Completed → Denied` em arquivo real e confirma que o conteúdo não inclui caminhos nem identificadores privados.
- `readonly_host_journal_failure_permanently_revokes_read_authority`: falha de escrita simulada resulta em negativa permanente dentro da sessão, sem resultados positivos.
- `readonly_loopback_executes_only_allowed_reads_and_persists_audit`: WebSocket real `127.0.0.1`, handshake `agent.hello`/ack, comando `fs.list` permitido e concluído, solicitação com `FS_WRITE` negada, replay de command ID negado, encerramento pelo host e quatro eventos persistidos e redigidos.
- `AGENT_WINDOWS_READONLY_ARGS_FAIL_CLOSED`: CLI recusa início sem a configuração completa e com TLS/raiz inválidos.

**Atenção:** esse ensaio WebSocket roda em **loopback com credencial sintética**. O CI prova a política/read-only/audit no protocolo existente, mas **não** uma sessão OAuth/pairing de ponta a ponta conectada ao Worker/DO real. A prova completa de pairing → connection credential → WebSocket → MCP e auditoria em laboratório sem mock na fronteira do produto é responsabilidade de **G1-D/G2**. Não houve dispositivo físico, ambiente staging pago, ações de escrita, execução no Windows pessoal ou inferência de IA.

## Critérios para encerrar G1-C

- [x] Workspace raiz explícita e seis capacidades limitadas com default-deny.
- [x] 17 operações privilegiadas negadas, approval e workspace falsificados recusados; autorização local.
- [x] Auditoria em disco fora do root, dados redigidos, persistidos por evento e falha fechada.
- [x] Leitura permitida, negativa de escalonamento, negativa de replay e shutdown em WebSocket de laboratório.
- [x] CI Windows no head inicial com 130 testes aprovados.
- [ ] **CI final Windows + MCP/Keycloak no último SHA e merge do PR #91**; registrar a evidência no painel G1–G7.

G1-C não autoriza ação mutável nem publicação. Após integração, **G1-D será a próxima etapa do G1**, com o aceite local completo de Agent/Control Plane/pairing/OAuth. G1 geral, G2–G7, E2E físico e publicação permanecem abertos.

**Guarda Avast:** todos os builds e testes Cargo foram executados somente no runner Windows hospedado, nunca no PC pessoal via DCR.
