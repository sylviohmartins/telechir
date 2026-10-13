# G1-A — Local Agent provisioning: identidade, pairing e credential curta

**Data de aferição:** 2026-10-13 (America/Sao_Paulo)  
**Issue:** [#82](https://github.com/sylviohmartins/telechir/issues/82)  
**PR de implementação:** [#88](https://github.com/sylviohmartins/telechir/pull/88)  
**Execução:** TDD com RED/GREEN observados; Rust 1.99.0 MSVC em Windows CI hospedado (não no Windows pessoal).

## Resultado verificado no laboratório

A [CI Windows #38428031545](https://github.com/sylviohmartins/telechir/actions/runs/38428031545) aprovou **118 testes Rust** (107 unitários + 1 contrato credential + 1 pairing + 7 protocolo + 2 testes de integração), 0 falhas, Rustfmt, Clippy `-D warnings`, build e inicialização fail-closed. Na revisão anterior, o ensaio RED da sessão `#38426603208` terminou **103 testes aprovados e 4 falhas esperadas** antes da implementação. Os 4 negativos e a leitura de credencial passaram após o GREEN; a revisão de Clippy encontrou apenas um borrow supérfluo, corrigido antes da CI #38428031545.

**Evidência adicional de integração real em loopback:** `agent/tests/provisioning_contract.rs` inicializa um servidor HTTP em `127.0.0.1`, sem proxy, credenciais reais ou internet. O `ProvisioningHttp` faz `POST /pairings`, `GET /pairings/:id`, `POST /pairings/:id/proof` e `POST /devices/:id/connection-credential`. O servidor sintético responde `USER_VERIFIED` **simulado** (não finge login humano de verdade), verifica criptograficamente as assinaturas Ed25519 com a chave pública registrada para as mensagens canônicas de pairing e credential, devolve `ACTIVE` e uma credential efêmera de teste. O Agent persiste apenas a associação de dispositivo no `DeviceBindingStore` de teste e prepara `RealtimeClientConfig`/`SessionCredentials` **sem abrir WebSocket**.

## Contratos implementados

| Contrato | Comportamento e negativas |
|---|---|
| Identidade | `DeviceIdentityManager::load_existing()` não gera, não troca e não persiste chave; ausência retorna `None`, corrupção falha fechada e buffer do store é zerado |
| Vínculo | `DeviceBinding` versionado valida UUIDs, fingerprint SHA-256 da chave Ed25519 e key/installation ID; `NativeKeyringDeviceBindingStore` usa conta separada de identidade; não substitui vínculo diferente |
| HTTPS | `ProvisioningHttp` usa `reqwest`/rustls, timeout limitado, redirects desabilitados, HTTPS obrigatório fora de loopback, resposta JSON limitada, envelope/status esperado e erros redigidos |
| Pairing explícito | `begin_pairing` é a única ação que pode gerar identidade; verifica fingerprint, prazo, URI HTTPS e UUID. `advance_pairing` não gera chave, não assina em `CREATED`, só assina em `USER_VERIFIED` com challenge válido e persiste vínculo somente após resposta `ACTIVE` e ID correspondente |
| Credential curta | `prepare_connection` exige identidade já existente + associação compatível, nonce novo, assinatura Ed25519, caminho canônico, token não vazio e validade máxima de 60 s, fail-closed em revogação/expiração/origem inválida. `SessionCredentials` redige `Debug`; bearer não é persistido. **Não conecta** |
| Capabilities | O preparador G1-A aceita somente lista vazia de capacidades; políticas para filesystem, input, screen e browser serão integradas depois em G1-C |

## Limites que NÃO foram certificados

- O par `USER_VERIFIED → ACTIVE` foi **simulado pelo servidor do laboratório**, com validação real de assinatura, **não** comprova o consentimento humano numa instalação real, OIDC, produção ou autorização de outro usuário. A fronteira real de aprovação humana permanece no control plane e será verificada em G2/G4.
- O adapter nativo de keyring foi compilado no Windows CI; testes de serialização/integridade e fluxos usam stores em memória para não acessar credenciais de usuários reais. Persistência no OS keyring com conta de instalação real ainda pertence ao gate do host G1-B/G4.
- O `main.rs` continua **bootstrap-only**, sem chamar `begin_pairing`, `prepare_connection` ou `run_authenticated_session`; não há daemon residente nem dispositivo físico pareado ou conectado.
- Não se testou WebSocket real fora do loopback, TLS com certificado público de staging, nova conexão após revogação/rotating keys ou interface de aprovação local do usuário final. Esses são gates G1-B/G1-C/G2/G4.
- O `origin` passado pelo host para preparar a sessão deve ser o mesmo endpoint aprovado do adapter. Isso será vinculado estruturalmente quando `main.rs` for integrado em G1-B; até lá, não há ponto de entrada capaz de fornecer origem arbitrária a partir de usuário externo.

## Rastreabilidade e próximos gates

Código: `agent/src/identity.rs`, `agent/src/provisioning_store.rs`, `agent/src/provisioning_http.rs`, `agent/src/provisioning.rs`, `agent/tests/provisioning_contract.rs`. Design e plano aprovados: `docs/superpowers/specs/2026-10-12-agent-g1a-provisioning-design.md`, `docs/superpowers/plans/2026-10-12-agent-g1a-provisioning.md`.

**Status de entrega:** G1-A implementado e testado em CI, **aguardando aprovação da CI final no SHA documental e merge do PR #88**. **G1 geral permanece `EM EXECUÇÃO`**. Próximo incremento finito: **G1-B — host residente opt-in**, com identidade e vínculo existentes, origin fixada, estado e shutdown, sem ativar input/screen/browser por default.
