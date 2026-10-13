# G1-A — Agent identity, pairing and short-lived credential: design

**Data:** 2026-10-12  
**Status:** **PROPOSTO — revisão de design requerida antes de implementar**  
**Origem:** [issue #82](https://github.com/sylviohmartins/telechir/issues/82), [G1 no painel de conclusão](../../product/release-readiness-2026-10-09.md#painel-de-conclusão--fonte-única-de-verdade-12102026)  
**Superpowers:** design arquitetural anterior ao plano TDD. Não é certificado de funcionalidade.

## 1. Resultado pretendido e limites

Prover o módulo Rust já existente do Agent com um caminho seguro e explícito para:

1. cadastrar a identidade Ed25519 local **apenas por ação expressa de pairing**;
2. aguardar a confirmação humana na interface autenticada já existente, assinar o challenge e persistir um vínculo de dispositivo **somente quando o servidor informar `ACTIVE`**;
3. partir de identidade e vínculo previamente provisionados, assinar prova de conexão com nonce novo e obter, junto ao control plane, a credential curta de **60 segundos**;
4. devolver `RealtimeClientConfig` e `SessionCredentials` do supervisor já testado em `agent/src/runtime.rs`, mas **sem abrir WebSocket automaticamente** nesta etapa.

Se qualquer validação falhar, retornar erro sem segredo e **zero tentativas de conexão WebSocket**. O G1-A não cria um modo residente em `main.rs` (G1-B), nem ativa ações no computador físico, nem altera os protocolos.

### Contratos que não podem mudar

- [Pairing API v1](../../../../specs/auth/pairing-api-v1.md): `POST /api/v1/pairings`; `GET /api/v1/pairings/{pairing_id}` com os headers de identidade; `POST /api/v1/pairings/{pairing_id}/proof`; confirmação humana feita no control plane, não pelo Agent.
- [Pairing Proof v1](../../../../specs/auth/pairing-proof-v1.md): assinatura canônica Ed25519, audience `telechir-control-plane`; challenge somente após `USER_VERIFIED`; binding a `pairing_id`, `device_key_id` e `device_installation_id`.
- [Connection Credential v1](../../../../specs/auth/connection-credential-v1.md): `POST /api/v1/devices/{device_id}/connection-credential`, assinatura Ed25519 com audience `telechir-control-plane/realtime`, nonce 16–128 caracteres, timestamp RFC3339 ±60 s, credential válida 60 s e single-use.
- Os tipos públicos `DeviceIdentityManager`, `NativeKeyringIdentityStore`, `DevicePairingMetadata`, `PairingProof`, `ConnectionCredentialProof`, `RealtimeClientConfig` e `SessionCredentials` devem ser reutilizados.

## 2. Opções analisadas

| Opção | Benefício | Custo/risco | Decisão |
|---|---|---|---|
| A. Colocar HTTP/pairing/keyring em `main.rs` | Poucos arquivos | Mistura side effects, difícil testar e alto risco de iniciar rede sem intenção | Rejeitada |
| **B. Camada de provisionamento com portas de I/O** | Testável em CI, decisões de segurança isoladas, reaproveita contratos; sem network por default | Uma interface HTTP e um store de associação | **Recomendada** |
| C. Reimplementar pairing no WebSocket / usar JWT sintético para começar o Agent | Protótipo aparentemente rápido | Contorna user verification, introduz autoridade errada e inviabiliza E2E honesto | Rejeitada |

## 3. Arquitetura e arquivos propostos

| Arquivo | Responsabilidade |
|---|---|
| `agent/src/identity.rs` | Adicionar `DeviceIdentityManager::load_existing()`: leitura sem geração/rotação silenciosa; a criação continua limitada ao pairing iniciado explicitamente |
| `agent/src/provisioning.rs` (novo) | Orquestração tipada: iniciar pairing, validar status, assinar challenge, aceitar ativação somente `ACTIVE`, armazenar vínculo, obter credential curta e preparar a sessão. Não abre conexão |
| `agent/src/provisioning_http.rs` (novo) | Adapter HTTPS com `reqwest` + rustls/webpki-roots: JSON bounded, sem redirects automáticos, TLS validado e sem enviar credenciais para origem externa |
| `agent/src/provisioning_store.rs` (novo) | Store do vínculo `device_id` ↔ key/installation IDs no keyring, versão e validação de integridade; store em memória **somente nos testes** |
| `agent/src/lib.rs` e `agent/Cargo.toml`/`agent/Cargo.lock` | Exportar a API estritamente necessária e registrar a dependência de HTTP com lockfile reproduzível |
| `agent/tests/...` | Contratos e testes de falha fechada, com servidor HTTP(S) de CI e fixtures sintéticas (nenhum dispositivo real) |
| `agent/src/main.rs` | **Sem alterações neste escopo**; ligação opt-in em G1-B |

A composição deve operar em duas ações **separadas**:

**Pairing explícito (sem conexão):** `NativeKeyringIdentityStore` → identidade carregada/gerada de modo deliberado → registro → exibir apenas URI e user code (nunca chave privada) → polling limitado do estado → após `USER_VERIFIED` validar challenge → assinar proof → exigir resposta `ACTIVE` com device ID válido → persistir vínculo atômico com a identidade correspondente. Exposição de código na CLI futura (G1-B), não ativação implícita em `cargo run`.

**Preparar nova sessão (sem pairing automático):** carregar identidade *existente* e vínculo existente → validar key ID e installation ID iguais, `device_id` coerente → gerar nonce novo com `new_connection_nonce()` → usar relógio UTC e `sign_connection_credential_request` → `POST` protegido a endpoint do device ID → validar `expires_at` (presente, no futuro, não além do limite de 60 s), `websocket_path` exatamente `/api/v1/devices/{device_id}/realtime` e autoridade/origem → construir `SessionCredentials::new` e `RealtimeClientConfig`; retornar sem conectar. Cada tentativa requer novo nonce e token. Revogação no servidor gera `DEVICE_REVOKED` e não há fallback para identidade nova.

## 4. Decisões de segurança e erro

- **HTTPS obrigatório fora de loopback:** recusar URL com userinfo, fragment, host ambíguo, redirect entre origens e credenciais em query. `ws://` só loopback em CI já autorizado pelo `RealtimeClientConfig::validate`. Preferir `wss://` como padrão de construção do endpoint realtime. Sem `danger_accept_invalid_certs`, `NODE_TLS_REJECT_UNAUTHORIZED=0` ou exclusões do Avast.
- **Vínculo forte:** `ACTIVE` não é inferido da existência de fingerprint; o store fica ligado à key id/installation id. Não autocriar dispositivo se não houver vínculo. A API privada somente recebe a assinatura, nunca a private key. Erros/Debug/logs redigidos (inclusive token, code, challenge, Authorization).
- **Respostas adversariais:** validar status HTTP/envelope, formato JSON, tamanho máximo, estado/fingerprint/id/nonce quando aplicável e expiração contra relógio. Não seguir URL de WebSocket fornecida por resposta como URL absoluta; aceitar apenas caminho canônico e compor com origem confiável.
- **Revogação:** revogação/disabled é decidida pelo control plane na chamada de credential e no handshake; qualquer 401/403/DEVICE_REVOKED deve impedir `SessionCredentials` utilizáveis. Não reconectar com token anterior.
- **Resiliência:** polling de pairing limitado por TTL de 10 min (sem loop agressivo); timeout de HTTP; ausência de rede retorna erro sem trocar a identidade local; nenhum retry automático de POST mutável.
- **Persistência:** material secreto Ed25519 permanece no keyring existente. A associação com o device ID também usa keyring/OS secure store, não arquivo de configuração ou variáveis de ambiente. Não fazer persistência de bearer 60 s.

## 5. Testes de aceite obrigatórios (TDD)

| Caso | Resultado exigido |
|---|---|
| Store de identidade vazio no caminho de sessão | Falhar `NOT_PROVISIONED`, **não gerar chave** e **não executar HTTP** |
| Pairing apenas iniciado (CREATED) ou expirado/revogado | Não assinar challenge, não persistir device ID |
| Challenge trocado, fingerprint diferente ou pairing ID errado | Não prosseguir; prova fora do binding nunca aceita |
| Pairing ACTIVE com proof correto e device id válido | Persistir associação ligada à identidade, uma vez |
| Associação guardada com key ID trocado/identidade rotacionada | Falhar sem HTTP de emissão |
| Proof de credential com nonce repetido, timestamp antigo ou device revogado | O servidor recusa; nenhum fallback para token em cache |
| Credential ausente, expirada ou TTL maior que 60 s | Falhar, não entregar sessão |
| Endpoint HTTPS externo com redirect ou websocket_path adulterado | Falhar fechado, nenhum upgrade WebSocket |
| Sessão preparada com credential válida e nonce fresco | Construir exatamente `RealtimeClientConfig` + `SessionCredentials`, sem abrir WebSocket |
| Sanitização de erros/Debug | Sem token, challenge, user code, assinatura ou key privada em logs |

O TDD será feito na CI Linux/Windows; primeiro confirmar o teste negativo falhando pelo comportamento ausente, depois implementar a menor mudança e repetir o gate completo no último SHA. A segurança deve preferir erros tipados, não strings contendo o body HTTP.

## 6. Não escopo e ordem após aprovação

G1-A não inclui `--serve`, processo em background, reconexão, execução de ferramentas no PC, aprovação de ações críticas, publicação, staging paga ou novo protocolo.

**Conclui G1-A somente quando:** a integração de pairing e credential for demonstrada com respostas reais do adapter em laboratório de CI, casos negativos acima PASS, rustfmt/Clippy/testes e regressões do control plane verdes no último SHA, relatório de aceite e PR mergeado. **A mera criação deste design não conclui G1-A.**

Depois G1-B integra ao `main.rs` um host **opt-in** com estados, shutdown e credential fresca; G1-C liga a policy/executor/audit; G1-D fecha o aceite loopback. O painel G1–G7 permanece com **G1 EM EXECUÇÃO**, sem iniciar outros clientes opcionais.

## 7. Pontos para revisão humana

A direção acima reutiliza os protocolos congelados e não cria novo escopo do MVP. Antes de codificar, confirmar principalmente que **o pairing continua explicitamente disparado e confirmado pelo usuário** e que o host não deve tentar conectar por padrão. Os detalhes de HTTP/armazenamento de associação e a estratégia de teste serão consolidados no plano Superpowers após esta aprovação.
