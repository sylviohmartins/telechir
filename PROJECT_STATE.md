# Estado do Projeto

**Atualizado em:** 2026-10-08

## Fase atual

**Discovery concluído / Phases 0–15 integradas / Phase 16 — Multi-AI compatibility certification em andamento (issue #49)**

A implementação possui Local Agent Core, control plane, identidade/pairing Ed25519, canal realtime outbound, Remote MCP/OAuth, seis typed filesystem tools, shell/process lifecycle, Basic Git read-only, governança de policy/approvals/audit, Dashboard MVP, tooling fail-closed para package/review do plugin público OpenAI, sandbox Docker local opt-in, Computer use tipado/bounded no Windows e Browser automation Playwright isolada com egress anti-SSRF. A superfície MCP pública possui 24 tools. O projeto **não possui deploy de produção**, plugin submetido, aprovado ou publicado.

## Gates atuais

- [x] Naming discovery: **`NAME_READY` — produto oficialmente chamado Telechir**.
- [~] Clearance jurídico/comercial da marca: **`COMMERCIAL_CLEARANCE_PENDING`** — domínio, packages, handles e trademark precisam de consulta/reserva autoritativa antes de lançamento.
- [x] ChatGPT/Codex public-plugin path: arquitetura revalidada em 2026-10-05; package/review tooling do Telechir em **`PHASE_11_SUBMISSION_READY`**.
- [~] Publicação OpenAI do plugin próprio: **`EXTERNAL_GATES_PENDING`** — publisher/permissões, domínio/URLs/assets, produção, verification/OIDC, reviewer materials, scan, submission/review/approval, Plus availability e quota precisam de evidência real.
- [x] Blueprint técnico/de produto v2 consolidado.
- [x] Estratégia de licenciamento/open source definida em ADR-0005.
- [x] Acceptance criteria formais do vertical slice MVP.
- [x] Definition of Ready para Phase 0: **`READY_FOR_PHASE_0`**.
- [x] Phase 0 — Repository & Protocol Specifications: **`PHASE_0_COMPLETE`**.
- [x] Exit review da Phase 0: **`READY_FOR_PHASE_1`**.
- [x] Phase 1 — Local Agent Core: **`PHASE_1_COMPLETE`**.
- [x] Phase 2 — Hosted Control-Plane Skeleton: **`PHASE_2_COMPLETE`**.
- [x] Phase 3 — Pairing and Device Identity: **`PHASE_3_COMPLETE`**.
- [x] Phase 4 — Device Realtime Channel: **`PHASE_4_COMPLETE`**.
- [x] Phase 5 — Remote MCP Integration and OAuth: **`PHASE_5_COMPLETE`**.
- [x] Phase 6 — Filesystem Tools: **`PHASE_6_COMPLETE`**.
- [x] Phase 7 — Shell/Process Lifecycle: **`PHASE_7_COMPLETE`**.
- [x] Phase 8 — Basic Git: **`PHASE_8_COMPLETE`**.
- [x] Phase 9 — Policy, Approvals and Audit: **`PHASE_9_COMPLETE`**.
- [x] Phase 10 — Dashboard: **`PHASE_10_COMPLETE`**.
- [x] Phase 11 — ChatGPT/Codex public-plugin submission readiness: **`PHASE_11_SUBMISSION_READY`**.
- [x] Phase 12 — Sandbox mode: **`PHASE_12_COMPLETE`**.
- [x] Phase 13 — Computer use: **`PHASE_13_COMPLETE`**.
- [x] Phase 14 — Browser automation: **`PHASE_14_COMPLETE`**.
- [x] Phase 15 — Multi-device/workspace concurrency: **`PHASE_15_COMPLETE`**.
- [~] Phase 16 — Multi-AI compatibility certification em andamento: discovery oficial, matriz e harness MCP moderno/legado testados; CI GitHub Actions com regressões aprovada; integração do SDK cliente com JWT RS256/JWKS reais (documentos OAuth sintéticos, 3/3 testes locais PASS); **MCP Inspector CLI 2.5.0 real** comprovou o caminho HTTPS/OAuth **sem token** (401 e `auth_required`, run #37845791616) em runner Ubuntu descartável, sem relaxar TLS. No Windows, Avast substitui certificado de loopback. **MCP Inspector autenticado** comprovou descoberta das 24 tools, `list_devices` e escopo fail-closed com JWT RS256/JWKS sintéticos em HTTPS real isolado (run #37881808611, ambos jobs CI success). **PKCE S256 Authorization Code** com emissor OAuth sintético HTTPS loopback, TLS pinning, JWKS pública, assinatura RS256, vínculo client/resource/redirect e defesa contra replay comprovado em GitHub Actions #37887181576. **Google Gemini CLI 0.63.0 real** exibiu conexão MCP autenticada `Connected` em Streamable HTTPS isolado com JWT RS256 de fixture, sem conta Gemini ou execução de LLM (PR #58). **Claude Code CLI 2.1.295 real** também conectou ao MCP do Telechir em HTTPS validado, com JWT sintético RS256, configuração privada e sem login de modelo (CI #37890233252, PR #60). **Codex CLI 0.162.0 real (App Server)** executou `mcpServer/tool/call` para `list_devices` através do MCP autenticado por HTTPS com JWT sintético, validando o device semeado em D1 local (CI #37892176590, PR #61). Isso comprova chamada direta do runtime Codex, mas não a escolha de ferramenta por modelo de IA. **Negativas no Codex App Server real** também comprovadas: ausência de Bearer bloqueada pelo cliente, JWT com audience incorreta e token malformado recusados no handshake (`Auth required`), e `write_file` com JWT somente leitura recusado por `Insufficient scope` (CI #37964924397, PR #62); perfis e processos independentes, sem credenciais reais. **Codex App Server 0.162.0** validou ainda token expirado e a desativação de usuário vinculado em D1: após uma leitura positiva, mesma thread/processo com mesmo JWT foi recusada após `disabled_at`, assim como outro processo Codex com o mesmo JWT ainda válido (`CODEX_IN_SESSION_USER_DISABLED_PASS`, `CODEX_DISABLED_USER_NEW_SESSION_PASS`, CI #37967586920, PR #63). **Isto não é revogação por `jti`** nem desconexão de sessões ociosas. **Keycloak 26.8.0 real** em contêiner CI HTTPS publicou OIDC/JWKS e emitiu JWT de `client_credentials` verificado por JWKS pública, claims `iss/sub/azp/aud/exp`, escopo de leitura mapeado e rejeição de audience errada (CI #37975016365, PR #65). **Verificação do JWT Keycloak pelo `JwtAccessTokenVerifier` de produção** (com subject hashado e adaptador D1 in-process) foi comprovada no CI #37979177621 (3/3 jobs success), com negativos de audience, assinatura e sujeito; não certifica Worker/D1 HTTP. **Não há ainda consumo do JWT do Keycloak pelo Worker, nem fluxo Authorization Code+PKCE real**, consentimento ou IdP gerenciado externo. Homologação OAuth E2E, invocação mediada por modelos e dispositivos não sintéticos continuam pendentes.

## Decisões atuais

- **Telechir é a marca oficial do produto.**
- O repositório físico já foi renomeado para `telechir`.
- Naming criativo está encerrado; nova rodada só ocorre se surgir impedimento material/jurídico.
- O produto é agnóstico a modelos e multi-IA por design.
- Distribuição no ChatGPT/Codex: plugin público + Remote MCP; o caminho técnico está preparado para package/submission, mas publisher verification, produção, review, publicação, availability por plano e quota continuam gates externos.
- Cloudflare foi aceito como primeiro control plane hospedado em ADR-0004, mantendo protocolo e agent independentes do provedor.
- O agent local aplica a autoridade final de policy.
- Approval remoto pode restringir o dispatch, mas nunca se transforma em autoridade local do agent.
- Operações `CRITICAL` permanecem fail-closed por default; `computer.input` é a primeira exceção explícita e só executa após confirmação humana local session/digest/TTL-bound no próprio device.
- `guarded_host` permanece o execution mode default; `sandbox` é opt-in, exige `sandbox.docker` e nunca faz fallback para host.
- Sandbox Docker é defense-in-depth, não VM boundary nem substituto de policy/approval.
- Computer use one-shot/single-action entrou na Phase 13 somente no Windows.
- Browser automation entrou na Phase 14 como authority `BROWSER` própria, com seis tools tipadas, context Playwright efêmero/non-persistent e egress proxy anti-SSRF; ela não implica `INPUT_CONTROL`, `NETWORK`, filesystem, clipboard ou secrets.
- A Phase 15 materializa workspace ownership durável e serializa somente side effects concorrentes do mesmo workspace via lease/fencing no `DeviceCoordinator`; reads, workspaces distintos e devices distintos permanecem concorrentes.
- Streaming de tela, clipboard, persistent authenticated browser, raw JavaScript/CDP/WebDriver/BiDi passthrough, uploads/downloads e adapters macOS/Linux de Computer use permanecem fora do escopo atual.
- O core público usa **Apache License 2.0**, com trademark Telechir separado; `LICENSE` já está na raiz.
- Artefatos históricos permanecem imutáveis; conclusões atuais vivem em `docs/`.
- Artefatos originados no ChatGPT são rastreados em `artifacts/provenance/source-manifest.json`.

## Estado do naming

- 2026-09-29: Telechir chegou a `NAME_CONDITIONAL`.
- 2026-10-01, palavras reais: Grapnel, Skeg, Nervo, Prehend e Hawse bloqueados por colisões.
- 2026-10-01, Stage 2: 560 nomes construídos; nenhum superou Telechir.
- 2026-10-01, Stage 3: screening final preliminar; sem colisão contemporânea material em AI/dev tooling.
- 2026-10-02, Stage 4: **Telechir selecionado definitivamente; gate `NAME_READY`.**
- Clearance comercial permanece separado como `COMMERCIAL_CLEARANCE_PENDING`.

## Identidade atual

**Produto:** Telechir
**Descriptor:** *Secure computer control for AI agents*
**Tagline:** *Give AI a secure hand on your machines.*

## Rejeições explícitas

- **MachinaPort** como nome de produto. Permanece somente em snapshots históricos.

## Readiness

As avaliações relevantes estão em:

- `docs/testing/acceptance/definition-of-ready-2026-10-02.md`
- `docs/testing/acceptance/phase0-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase0-contract-audit-2026-10-02.md`
- `docs/testing/acceptance/phase1-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase2-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase3-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase4-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase5-exit-review-2026-10-02.md`
- `docs/testing/acceptance/phase6-exit-review-2026-10-03.md`
- `docs/testing/acceptance/phase7-exit-review-2026-10-04.md`
- `docs/testing/acceptance/phase8-exit-review-2026-10-04.md`
- `docs/testing/acceptance/phase9-exit-review-2026-10-05.md`
- `docs/testing/acceptance/phase10-exit-review-2026-10-05.md`
- `docs/testing/acceptance/phase11-exit-review-2026-10-05.md`
- `docs/testing/acceptance/phase12-exit-review-2026-10-05.md`
- `docs/testing/acceptance/phase13-exit-review-2026-10-06.md`
- `docs/testing/acceptance/phase14-exit-review-2026-10-07.md`
- `docs/testing/acceptance/phase15-exit-review-2026-10-08.md`
- `docs/security/threat-model/phase9-policy-approvals-audit-2026-10-05.md`
- `docs/security/threat-model/phase10-dashboard-2026-10-05.md`
- `docs/security/threat-model/phase11-openai-plugin-readiness-2026-10-05.md`
- `docs/security/threat-model/phase12-sandbox-mode-2026-10-05.md`
- `docs/security/threat-model/phase13-computer-use-2026-10-05.md`
- `docs/security/threat-model/phase14-browser-automation-2026-10-07.md`
- `docs/security/threat-model/phase15-workspace-concurrency-2026-10-08.md`
- `docs/research/openai/phase11-public-plugin-revalidation-2026-10-05.md`
- `docs/research/docker/phase12-sandbox-revalidation-2026-10-05.md`
- `docs/research/computer-use/phase13-platform-revalidation-2026-10-05.md`
- `docs/research/browser-automation/phase14-playwright-revalidation-2026-10-07.md`
- `docs/research/cloudflare/phase2-revalidation-2026-10-02.md`
- `docs/research/cloudflare/phase4-revalidation-2026-10-02.md`
- `docs/research/cloudflare/phase15-durable-objects-revalidation-2026-10-08.md`
- `docs/research/mcp/phase5-revalidation-2026-10-02.md`
- `docs/research/mcp/phase16-multi-ai-client-revalidation-2026-10-08.md`
- `docs/testing/acceptance/phase16-certification-matrix-2026-10-08.md`
- `docs/testing/acceptance/phase16-progress-review-2026-10-08.md`
- `docs/testing/acceptance/phase16-interop-regression-ci-2026-10-08.md`
- `docs/testing/acceptance/phase16-verified-ci-and-local-tls-2026-10-08.md`
- `docs/testing/acceptance/phase16-independent-inspector-gate-2026-10-08.md`
- `docs/testing/acceptance/phase16-oauth-fail-closed-regression-2026-10-08.md`
- `docs/testing/acceptance/phase16-signed-jwt-client-integration-2026-10-09.md`
- `docs/testing/acceptance/phase16-authenticated-inspector-ci-2026-10-09.md`
- `docs/testing/acceptance/phase16-pkce-https-isolated-2026-10-09.md`
- `docs/testing/acceptance/phase16-gemini-cli-authenticated-2026-10-09.md`
- `docs/testing/acceptance/phase16-claude-code-cli-authenticated-2026-10-09.md`
- `docs/testing/acceptance/phase16-codex-app-server-authenticated-readonly-2026-10-09.md`
- `docs/testing/acceptance/phase16-codex-auth-boundary-negatives-2026-10-09.md`
- `docs/testing/acceptance/phase16-codex-user-disable-reconnect-2026-10-09.md`
- `docs/testing/acceptance/phase16-keycloak-real-idp-token-contract-2026-10-09.md`
- `docs/testing/acceptance/phase16-keycloak-production-verifier-2026-10-09.md`
- `docs/research/mcp/phase16-external-client-smoke-plan-2026-10-08.md`
- `docs/security/threat-model/phase16-client-interoperability-2026-10-08.md`

Resultado atual:

> **PHASE_16_IN_PROGRESS** — a Phase 15 permanece concluída.

A Phase 16 possui issue #49, matriz de certificação, pesquisa atualizada e harness MCP moderno/legado. O segundo ciclo adicionou regressões de isolamento entre OAuth clients, equivalência de metadata/schema legacy, negação de token inválido e uma pipeline CI sem deploy (`.github/workflows/mcp-interop.yml`). A certificação externa continua separada de testes locais e CI. O resultado `PASS` do harness não implica compatibilidade de clientes reais; ChatGPT/Codex, Claude, Gemini e Copilot continuam sem homologação Telechir end-to-end até os gates de endpoint/IdP/conta e testes autorizados. Referências: `docs/research/mcp/phase16-multi-ai-client-revalidation-2026-10-08.md`, `docs/testing/acceptance/phase16-certification-matrix-2026-10-08.md` e `docs/security/threat-model/phase16-client-interoperability-2026-10-08.md`.

A Phase 15 transforma `workspace_id` em boundary durável de ownership e concorrência sem adicionar novas tools públicas. Cada device possui default workspace determinístico; commands e approvals persistem workspace, e policy passa a avaliar scope `workspace` junto de account/device/session.

Side effects do mesmo workspace são serializados por lease exclusivo persistido no Durable Object Storage, com fencing token monotônico. Reads continuam concorrentes; workspaces distintos no mesmo device e devices distintos do mesmo usuário não são globalmente bloqueados. Approval, idempotency, lease e fencing permanecem mecanismos separados.

AB-028 prova exclusão mútua + read concorrente + avanço de fencing. AB-029 prova que reconnect não replaya side effect aceito e que o lease sobrevive à troca de conexão. O Dashboard expõe default/active workspace e workspace/fence na timeline, sem criar UI administrativa.

Os gates finais e números exatos estão em `docs/testing/acceptance/phase15-exit-review-2026-10-08.md`. Nenhum deploy remoto foi executado.

Os 11 gates externos do plugin OpenAI continuam **`EXTERNAL_GATES_PENDING`** e não foram alterados pela Phase 15.

## Próximos trabalhos

1. Continuar **Phase 16 — Multi-AI compatibility certification** (issue #49), validando harness de protocolo e executando ensaios de clientes reais quando endpoint/IdP/consentimento permitirem. Não ampliar authority/runtime; não atribuir PASS de cliente a teste de SDK/wire.
2. Em paralelo, avançar os 11 gates externos do plugin OpenAI quando publisher, domínio, IdP, assets e produção estiverem disponíveis.
3. Completar/reservar ativos comerciais de Telechir antes de lançamento e manter os gates de signing, CSP/headers, custos e segurança operacional antes de beta/publicação.

## Histórico

Consulte `docs/history/research-lineage.md` para a evolução completa desde o gatilho inicial com Remote Desktop Commander até Telechir.
