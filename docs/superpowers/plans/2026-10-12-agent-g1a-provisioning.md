# G1-A — Agent Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preparar, sem abrir WebSocket, uma identidade Ed25519 explicitamente pareada com o Telechir e obter uma credencial de conexão curta, vinculada ao dispositivo, validada e descartável.

**Architecture:** Preservar os contratos Pairing API v1 e Connection Credential v1; adicionar portas de persistência e transporte separadas da orquestração, com adapters HTTPS/keyring e um caminho de sessão fail-closed. `agent/src/main.rs` e o supervisor `runtime.rs` permanecem sem comportamento novo: o primeiro ainda não conecta e o segundo recebe apenas `SessionCredentials` já verificadas.

**Tech Stack:** Rust 2024, Rust 1.99.0 MSVC, `keyring 4.2`, `tokio`, `serde`, `chrono`, `thiserror`, `reqwest 0.12` (`default-features = false`, `json`, `rustls-tls`), `async-trait 0.1` para portas async, `zeroize`; GitHub Actions Windows hospedado e regressão do control plane.

**Spec:** [G1-A approved design](../specs/2026-10-12-agent-g1a-provisioning-design.md)  
**Issue:** [#82](https://github.com/sylviohmartins/telechir/issues/82)  
**Status:** PLANO EM REVISÃO — sem implementação autorizada por este arquivo. O usuário já aprovou o design anterior; o plano/método de execução precisam de revisão separada.

## Global Constraints

- **Não executar `cargo test/build/clippy/run` no Windows pessoal**. Usar CI Windows hospedada; manter Avast/CyberCapture ativo. Mesmo o ciclo RED do TDD deve ocorrer no runner da CI, nunca no host Windows via DCR.
- Nunca alterar `agent/src/main.rs`, iniciar daemon, conectar dispositivo real, provisionar Cloudflare/staging ou ampliar a lista de ferramentas e capacidades nesta etapa.
- Pareamento somente por ação explícita, concluído após `USER_VERIFIED` da sessão humana no servidor; **`CREATED` não autoriza prova nem conexão**.
- Proofs Ed25519 e formatos canônicos existentes permanecem imutáveis. Nenhum token/assinatura/challenge/código de usuário/chave em logs, `Debug` ou exceções de HTTP.
- Credential de conexão tem TTL **60 segundos**, **uso único**, nonce **16–128 caracteres** e requested_at **±60 s**. Não persistir bearer nem reconectar com material anterior.
- HTTPS obrigatório fora de loopback; não permitir redirecionamentos ou alteração de origem. Nunca usar bypass de TLS, exclusões do antivírus ou credenciais de usuário de produção.
- Usar Rustfmt, Clippy `-D warnings`, testes Rust completos + regressões do control plane no **último SHA do PR** antes do merge; cada tarefa exige RED observado, GREEN observado e revisão do diff.

## File Structure and Ownership

| Arquivo | Responsabilidade |
|---|---|
| `agent/src/identity.rs` | Leitura estrita da identidade pré-existente; geração somente no pairing explícito |
| `agent/src/provisioning_store.rs` (novo) | `DeviceBinding` e `DeviceBindingStore` com keyring nativo e store de teste |
| `agent/src/provisioning.rs` (novo) | Estados e orquestração de pairing/credential, sem I/O direto fora das portas |
| `agent/src/provisioning_http.rs` (novo) | `ProvisioningApi` async e adapter HTTPS bounded para as três rotas pairing + rota de credential |
| `agent/src/lib.rs` | Exports públicos mínimos; `main.rs` intocado |
| `agent/Cargo.toml` e `agent/Cargo.lock` | HTTP/TLS e portas async, lockfile reproduzível |
| `agent/tests/provisioning_contract.rs` (novo) | Provas e negatives de pairing, emissão e ausência de WebSocket |
| `agent/tests/provisioning_http_contract.rs` (novo) | HTTP adversarial (status, URL, redirects, TLS, payload, limits) |
| `docs/testing/acceptance/phase16-agent-g1a-provisioning-2026-10-12.md` | Evidência REAL de CI, links do último SHA e limites claros de G1-A |
| `docs/product/release-readiness-2026-10-09.md`, `PROJECT_STATE.md` | Atualizar subetapa G1-A sem marcar G1 global concluído |

## Review Focus — inputs adversariais que precisam estar em testes

1. **Retorno de pairing com ID/fingerprint divergentes** — rejeitar e nunca persistir vínculo. Teste T4.
2. **HTTP 3xx ou host que muda origem** — não seguir redirect e não enviar proof/bearer. Teste T3.
3. **Store de vínculo corrompido ou identidade trocada/rotacionada** — rejeitar antes de HTTP. Testes T2 e T5.
4. **Credencial que vence durante validação / TTL acima de 60s / path adulterado** — rejeitar sem `SessionCredentials`. Teste T5.
5. **Resposta muito grande, JSON malformado ou campos com CR/LF** — bloquear, redigir erros e impedir side effects. Testes T3 e T4.

---

## Sequência de execução (RED → GREEN → review)

**Comandos de CI:** no checkout limpo do runner Windows executar `cd agent && cargo test --locked --all-features provisioning_ -- --nocapture` para filtro direcionado, seguido da suíte oficial `./scripts/interop/windows-agent-native-preflight.ps1 -AllowLocalBuild`. O workflow atual usa o segundo comando; durante o RED criar um workflow temporário/etapa de CI para executar o teste de filtro na branch e demonstrar falha esperada **sem confundir um check vermelho de desenvolvimento com prontidão de merge**. As assinaturas mínimas/stubs de tipos públicos devem compilar para o teste falhar **por asserção do comportamento ausente**, não por símbolos ou dependências inexistentes. Corrigir até GREEN, retirar o passo temporário antes da integração. No Linux repetir `cargo test --locked --all-features` em runner compatível, caso necessário por diferenças keyring; não assumir que verde no Windows cobre Linux.

### Task 1: Identidade existente, sem autogeração durante conexão

**Files:**
- Modify: `agent/src/identity.rs:233-270`
- Test: `agent/src/identity.rs` módulo `tests`

**Interfaces:**
- Consumes: `DeviceIdentityStore::load`, `decode_identity` já existentes.
- Produces: `DeviceIdentityManager<S>::load_existing(&self) -> Result<Option<DeviceIdentity>, IdentityError>`.
- `load_or_generate()` mantém seu contrato histórico, mas é chamado **apenas no fluxo explícito de pairing**.

- [ ] **Step 1 — RED:** escrever `provisioning_missing_identity_does_not_generate`: store vazio → `Ok(None)`, nenhum `save`; store contendo bytes corrompidos → `Err(CorruptStore)`, sem geração; identidade existente → mesma public identity. Criar store de teste com contadores se necessário.
- [ ] **Step 2 — verify RED (hosted CI):** executar `cargo test --locked --all-features provisioning_missing_identity_does_not_generate`; exigir falha de asserção contra stub compilável (ausência de carregamento estrito), não por erro de compilação, instalação ou runner.
- [ ] **Step 3 — GREEN:** implementar `load_existing()` lendo apenas `store.load()`; zerar buffer secreto sempre após decode; não escrever e não regenerar em caso de ausência/corrupção.
- [ ] **Step 4 — verify GREEN:** mesmo teste PASS e suite `identity::tests` PASS no runner; verificar `cargo fmt` e diff.
- [ ] **Step 5 — commit:** `git add agent/src/identity.rs && git commit -m "feat(agent): load existing device identity without implicit generation"`.

### Task 2: Vínculo ativo persistido e acoplado à identidade

**Files:**
- Create: `agent/src/provisioning_store.rs`
- Modify: `agent/src/lib.rs`
- Test: `agent/src/provisioning_store.rs` módulo `tests`

**Interfaces:**
- Produces: `DeviceBinding { device_id: String, device_key_id: String, device_installation_id: String }`, com encoding versionado `v=1`.
- Produces: `trait DeviceBindingStore: Send + Sync { fn load(&self) -> Result<Option<DeviceBinding>, ProvisionError>; fn save(&self, binding: &DeviceBinding) -> Result<(), ProvisionError>; }`.
- Produces: `NativeKeyringDeviceBindingStore::new() -> Result<Self, ProvisionError>` usando serviço `telechir-agent` e account específico `device-binding-v1`, distinto de `device-identity-v1`; `MemoryDeviceBindingStore` somente nos testes/exports condicionais.
- Consumes: `DevicePublicIdentity` e `Uuid::parse_str`.

- [ ] **Step 1 — RED:** testes `provisioning_binding_roundtrip`, `provisioning_binding_rejects_corrupt_or_mismatched_key`, `provisioning_binding_rejects_blank_or_invalid_uuid`. Exigir que o store rejeite bytes quebrados/versão desconhecida, e não retorne vínculo quando fingerprint/key/installation divergirem.
- [ ] **Step 2 — verify RED:** `cargo test --locked --all-features provisioning_binding_` falha de asserção de persistência/matching contra API stub que compila.
- [ ] **Step 3 — GREEN:** implementar o tipo versionado e `DeviceBinding::matches(&self, public: &DevicePublicIdentity) -> bool`; `NativeKeyringDeviceBindingStore` persiste JSON via `keyring::Entry`, sem bearer; evitar alteração de store de identidade existente. Não tentar rollback automático de identidades por falha de persistência.
- [ ] **Step 4 — verify GREEN:** testes positivos e corrupt-store/rotated-key PASS; `cargo clippy` sem warnings; revisar erros redigidos.
- [ ] **Step 5 — commit:** `git add agent/src/provisioning_store.rs agent/src/lib.rs && git commit -m "feat(agent): persist identity-bound device association in native keyring"`.

### Task 3: HTTP adapter TLS estrito e limites de protocolo

**Files:**
- Create: `agent/src/provisioning_http.rs`, `agent/tests/provisioning_http_contract.rs`
- Modify: `agent/Cargo.toml`, `agent/Cargo.lock`, `agent/src/lib.rs`

**Interfaces:**
- Produces: DTOs versionados `PairingStart { pairing_id, user_code, verification_uri, expires_at, fingerprint }`, `PairingStatus { pairing_id, state, expires_at, fingerprint, challenge, device_id }`, `PairingActivation { pairing_id, state, device_id }`, `CredentialResponse { credential, expires_at, websocket_path }` e `ProvisionError` tipado/redigido.
- Produces: `#[async_trait] trait ProvisioningApi: Send + Sync` com métodos `create_pairing(&self, registration: &PairingRegistration) -> Result<PairingStart, ProvisionError>`, `get_pairing(&self, pairing_id: &str, key_id: &str, installation_id: &str) -> Result<PairingStatus, ProvisionError>`, `prove_device(&self, pairing_id: &str, proof: &PairingProof) -> Result<PairingActivation, ProvisionError>`, `issue_credential(&self, device_id: &str, proof: &ConnectionCredentialProof) -> Result<CredentialResponse, ProvisionError>`.
- Produces: `ProvisioningHttp::new(origin: Url) -> Result<Self, ProvisionError>`; origem absoluta `https://` (ou HTTP **apenas loopback de teste**), `reqwest::Client` sem redirect, timeout limitado (10s), corpo controlado (pairing max 16 KiB, credential max 8 KiB, respostas max 16 KiB). 
- Consumes: envelopes JSON oficiais `{ ok: true, data: ..., meta: ... }`; status `201` criar pairing/credential; `200` status/proof, inclusive as respostas negativas de control plane.

- [ ] **Step 1 — RED:** `provisioning_http_rejects_non_loopback_plaintext_or_url_credentials`, `provisioning_http_does_not_follow_redirect`, `provisioning_http_rejects_oversize_or_invalid_json`, `provisioning_http_escapes_path_segment_and_blocks_cross_origin`, `provisioning_http_redacts_remote_error`. Use servidor `127.0.0.1:0` com protocolo HTTP local apenas no runner CI; TLS externo rejeitado no construtor sem rede.
- [ ] **Step 2 — verify RED:** `cargo test --locked --all-features provisioning_http_` deve falhar por comportamento inseguro/sem validação no adapter stub compilável.
- [ ] **Step 3 — GREEN:** adicionar dependências definidas no header, atualizar `agent/Cargo.lock` **na CI/worktree isolada**; `ProvisioningHttp` implementa a porta, desliga redirects, valida HTTP status + envelope e limita bytes antes de desserializar. Nunca usar o body remoto como erro/log. Compor paths por segmentos escapados e origem fixada. Não há fallback a HTTPS inseguro.
- [ ] **Step 4 — verify GREEN:** HTTP tests PASS; revisão de `Cargo.lock` para dependências transitivas e MSRV Rust 1.99.0; CI Windows `fmt/test/clippy/build`, sem permitir exceções Avast locais.
- [ ] **Step 5 — commit:** `git add agent/Cargo.toml agent/Cargo.lock agent/src/provisioning_http.rs agent/src/lib.rs agent/tests/provisioning_http_contract.rs && git commit -m "feat(agent): add bounded fail-closed HTTPS provisioning adapter"`.

### Task 4: Orquestrar pairing explícito e autorização humana

**Files:**
- Create: `agent/src/provisioning.rs`
- Modify: `agent/src/lib.rs`
- Test: `agent/tests/provisioning_contract.rs`

**Interfaces:**
- Consumes: `DeviceIdentityManager<S>::load_or_generate` **somente aqui**, `DeviceIdentity::pairing_registration`, `sign_pairing_proof`, `DeviceBindingStore` e `ProvisioningApi`/DTOs já definidos na Task 3.
- Produces: `PairingProgress::WaitingForUser | Active(DeviceBinding) | Expired | Revoked`; utiliza `PairingStart` do adapter definido na Task 3.
- Produces: `async fn begin_pairing<S: DeviceIdentityStore, B: DeviceBindingStore, A: ProvisioningApi>(identity: &DeviceIdentityManager<S>, binding: &B, api: &A, metadata: DevicePairingMetadata) -> Result<PairingStart, ProvisionError>`.
- Produces: `async fn advance_pairing<...>(...) -> Result<PairingProgress, ProvisionError>` recebendo `pairing_id` explicitamente; `advance` lê a mesma identidade sem regenerar, compara `pairing_id`, fingerprint e key/install ids e **nunca cria a identidade**.

- [ ] **Step 1 — RED:** `provisioning_pairing_created_requires_user_verification` (sem assinatura/sem save), `provisioning_pairing_rejects_expired_or_revoked`, `provisioning_pairing_rejects_mismatched_fingerprint_or_id`, `provisioning_pairing_active_persists_once`. Servidor/porta fake somente no teste, com chamadas registradas; criar fixture que emite challenge apenas após estado `USER_VERIFIED`.
- [ ] **Step 2 — verify RED:** `cargo test --locked --all-features provisioning_pairing_` deve falhar por asserção da transição de pairing não implementada, mantendo assinaturas compiláveis.
- [ ] **Step 3 — GREEN:** implementar uma ação `begin` explícita + uma transição `advance` por chamada (polling bounded fica no host G1-B, não loop interno infinito); assinar challenge com audience constante existente; persistir somente resposta `ACTIVE` com device_id UUID válido, fingerprint e ids consistentes; não duplicar vínculo de outra identidade.
- [ ] **Step 4 — verify GREEN:** suite `provisioning_pairing_` PASS; simular challenge reutilizado/trocado e verificar que não produz outro device nem registra vínculo.
- [ ] **Step 5 — commit:** `git add agent/src/provisioning.rs agent/src/lib.rs agent/tests/provisioning_contract.rs && git commit -m "feat(agent): orchestrate explicit user-verified device pairing"`.

### Task 5: Preparar credential de sessão curta, sem conectar

**Files:**
- Modify: `agent/src/provisioning.rs`
- Test: `agent/tests/provisioning_contract.rs`

**Interfaces:**
- Consumes: `DeviceIdentityManager<S>::load_existing`, `DeviceBindingStore::load`, `DeviceIdentity::sign_connection_credential_request`, `new_connection_nonce()`, `ProvisioningApi::issue_credential`.
- Produces: `PreparedConnection { config: RealtimeClientConfig, credentials: SessionCredentials }` sem `Clone`, `Debug` redigido e lifetime ligado ao retorno consumido uma única vez.
- Produces: `async fn prepare_connection<S: DeviceIdentityStore, B: DeviceBindingStore, A: ProvisioningApi>(identity: &DeviceIdentityManager<S>, binding: &B, api: &A, origin: &Url, metadata: AgentMetadata, now: DateTime<Utc>) -> Result<PreparedConnection, ProvisionError>`.
- `AgentMetadata` contém `agent_version`, `os`, `arch`, `capabilities` aprovadas pelo host; defaults não devem incluir screen/input/browser/sandbox.

- [ ] **Step 1 — RED:** `provisioning_session_missing_identity_never_calls_api`, `provisioning_session_mismatched_binding_never_calls_api`, `provisioning_session_revoked_credential_denied`, `provisioning_session_rejects_expired_or_long_ttl_or_altered_ws_path`, `provisioning_session_valid_credential_does_not_connect`.
- [ ] **Step 2 — verify RED:** `cargo test --locked --all-features provisioning_session_` falha por asserção da sessão não preparada, sem erro de compilação.
- [ ] **Step 3 — GREEN:** não chamar `load_or_generate` neste caminho; exigência de vínculo e identidade; nonce novo, RFC3339 UTC fresco e assinatura Ed25519; aceitar token apenas se `0 < expires_at - now <= 60s` (inclusive boundary), `websocket_path` canônico, resposta `device_id`/nonce se presentes iguais; construir `RealtimeClientConfig` com URL baseada **só na origin aprovada** e chamar `validate()` antes de devolver. Não abrir socket.
- [ ] **Step 4 — verify GREEN:** positivos/negativos PASS, testes de nonce fresco por duas invocações, fail-closed por 401/403 e sem `SessionCredentials` em caso de erro.
- [ ] **Step 5 — commit:** `git add agent/src/provisioning.rs agent/tests/provisioning_contract.rs && git commit -m "feat(agent): prepare single-use short-lived realtime credential without connecting"`.

### Task 6: Contrato integrado, matrix segurança e release evidence

**Files:**
- Modify: `agent/src/provisioning.rs`, `agent/src/provisioning_http.rs` (somente bugs comprovados)
- Test: `agent/tests/provisioning_contract.rs`, `agent/tests/provisioning_http_contract.rs`
- Create: `docs/testing/acceptance/phase16-agent-g1a-provisioning-2026-10-12.md`
- Modify: `PROJECT_STATE.md`, `docs/product/release-readiness-2026-10-09.md`

**Interfaces:**
- Consumes: todas as tarefas anteriores e os contratos congelados; nenhuma API de `main.rs`.
- Produces: evidência rastreável de que o Agent **prepara** a sessão, porém **não a inicia**; linha do painel G1-A `COMPLETE` só quando a CI final aprovar.

- [ ] **Step 1 — RED:** teste integrado `provisioning_e2e_lab_user_approved_pairing_to_fresh_credential`, com HTTP local real e fake do control plane apenas para credenciais e confirmação humana simulada no runner; `CREATED → USER_VERIFIED → ACTIVE → credential`. Testar também `CREATED → DENIED`, 403 revogado, replay/nonce e caminho alterado. Contratos wire e assinaturas devem corresponder exatamente às fixtures Rust/TypeScript.
- [ ] **Step 2 — verify RED:** CI direcionada falha por asserção de integração ausente usando stubs compiláveis; não confundir RED TDD com CI final.
- [ ] **Step 3 — GREEN:** corrigir somente as divergências provadas, executar o fluxo completo em runner; revisar que nenhum teste depende de credencial real, clock wall não controlado ou localhost pessoal.
- [ ] **Step 4 — final validation:** `cargo fmt --all -- --check`, `cargo test --locked --all-features`, `cargo clippy --locked --all-targets --all-features -- -D warnings`, build nativo e `scripts/interop/windows-agent-native-preflight.ps1 -AllowLocalBuild` na CI Windows; regressões MCP/Keycloak e control plane **3/3** no último SHA; conferir warnings, mocks, números de testes e logs redigidos. Não usar build Cargo por DCR no computador pessoal.
- [ ] **Step 5 — review & commit:** revisão independente de fronteiras keyring/HTTP/TLS, credentials e testes negativos; gravar aceite com links de runs/commit, atualizar `PROJECT_STATE.md` e painel **somente da subetapa G1-A**. Abrir PR de implementação separado, aguardar CI verde no último SHA, merge/delete/sync e comentário #82. **Não declarar G1 operacional**.

## Completion / handoff

**G1-A DONE** exige: adapter HTTPS verificado, identidade carregada sem geração automática durante conexão, pairing comprovadamente confirmado pelo humano na fronteira do control plane, associação no keyring, credencial de 60s e sessão preparada sem abertura de socket, negativos RED→GREEN observados, CI Windows/Linux/Keycloak do último commit e aceite/merge documentados.

**G1 continua EM EXECUÇÃO depois de G1-A.** Próximos compromissos já definidos no painel: G1-B host residente explicitamente opt-in em `main.rs`, G1-C executor/policy/audit e G1-D aceite integrado loopback; depois G2 local, G3 staging autorizada e G4 E2E físico (MVP). Não inaugurar Phase 17 nem pesquisa opcional de clientes MCP.

**Execução e revisão:** aguardar o responsável ler este plano e selecionar método `subagent-driven` ou `native`, conforme o Superpowers `writing-plans`; antes disso não modificar produto Rust.
