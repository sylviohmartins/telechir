# Telechir — Auditoria de prontidão para beta, produção e lançamento

**Data da auditoria:** 2026-10-09 (America/Sao_Paulo)
**Baseline revalidado:** `main` em `7362d348dea9bbcbb4431582e9c291514a2f3120` (PR #72 integrado após PR #73), checkout Windows limpo.
**Natureza:** plano de gates verificáveis, **não** autorização para implantar, contratar serviços, publicar plugin ou abrir uma Phase 17.
**Fontes duráveis:** [estado](../../PROJECT_STATE.md), [roadmap](roadmap.md), [regras](../../AGENTS.md), [matriz Phase 16](../testing/acceptance/phase16-certification-matrix-2026-10-08.md), [issue #49](https://github.com/sylviohmartins/telechir/issues/49), [#15](https://github.com/sylviohmartins/telechir/issues/15), [#14](https://github.com/sylviohmartins/telechir/issues/14).

## Painel de conclusão — fonte única de verdade (12/10/2026)

**Meta:** transformar módulos e testes em um produto Telechir funcional, homologado e distribuível. Este quadro, e não a quantidade de PRs ou fases históricas, define o progresso. O [roadmap](roadmap.md) registra o histórico das fases; `PROJECT_STATE.md` resume o status corrente; este documento controla os **gates de saída até a conclusão**.

**Etapa atual: G1 — Agent operacional / [issue #82](https://github.com/sylviohmartins/telechir/issues/82). Próxima entrega obrigatória:** ligar identidade/pareamento e credencial de conexão curta a um host Agent residente, com executor/policy, desligamento gracioso e conexão **somente opt-in**. O supervisor de sessão isolado do [PR #85](https://github.com/sylviohmartins/telechir/pull/85) já está integrado, mas `agent/src/main.rs` ainda termina após imprimir `core ready`. Não confundir isto com um Agent conectado.

### Linhas de chegada (três definições, não intercambiáveis)

- **MVP funcional:** um Windows autorizado, um cliente MCP independente e o control plane em staging segregada completam pairing → conexão outbound → OAuth → `list_devices` → ferramenta tipada **read-only** → policy/audit; negativas e recuperação comprovadas. **Status: NÃO ATINGIDO.**
- **Beta fechado:** MVP + pacote instalável/verificável, atualização/rollback, controles de segurança e incidentes, observabilidade e ensaio com usuários convidados consentidos. **Status: NÃO ATINGIDO.**
- **Produto lançado publicamente:** beta aprovado + canal/planos efetivamente disponíveis, publicação e aprovações externas necessárias e clearance de marca/distribuição resolvido. **Status: NÃO ATINGIDO.** Publicação ChatGPT não é pré-requisito do **MVP técnico**, mas é pré-requisito da promessa de aplicativo público no ChatGPT.

**Baseline mínimo proposto para evitar paralisia por certificação ilimitada:** Windows Agent + Codex CLI App Server como cliente de execução real + MCP Inspector para diagnóstico; as conexões OAuth já testadas de Claude/OpenCode permanecem documentadas. Gemini, Copilot e hosts secundários podem constar `BLOCKED`/`NOT_TESTED` na primeira entrega, desde que não sejam anunciados como suportados. **A decisão de quais clientes entrarão no beta/publicação deve ser aprovada antes do gate G5**, sem alterar retroativamente o significado de testes anteriores.

### Trilha finita de entrega e critérios que encerram cada gate

| Gate | Entrega obrigatória | Evidência exigida para encerrar | Situação atual / dependência |
|---|---|---|---|
| **G1 — Agent operacional** | Implementar [#82](https://github.com/sylviohmartins/telechir/issues/82): host residente, identidade segura/keyring, pairing explícito, credencial curta, WebSocket TLS, executor tipado com policy local, lifecycle e shutdown. Capabilities perigosas desligadas por padrão | Agent permanece ativo, reporta estados corretos, recebe chamada read-only via loopback, aplica recusa por policy, para sem recurso órfão; testes negativos e CI Windows/Linux verdes | **EM EXECUÇÃO.** Supervisor `runtime.rs` passou 99 testes, mas não é invocado pelo `main.rs` |
| **G2 — Vertical slice local integrado** | Rodar Agent + Worker/D1/DO + um cliente MCP autorizado num laboratório controlado, sem credencial simulada na fronteira entre módulos do produto | Teste automatizado de ponta a ponta em loopback: pairing → OAuth → `list_devices` → operação read-only → audit; negativas owner/scope/revogação/replay; registro da execução e falha fechada | **BLOQUEADO por G1** |
| **G3 — Staging segregada** | Provisionar ambiente não produtivo, OIDC/IdP, TLS, Worker/D1/DO, migrar, configurar IAM/secrets, custo máximo, backup/rollback e telemetria redigida | URL/conta de teste verificáveis, acesso isolado, migrar e fazer rollback/restore em teste, orçamento/limites e logs adequados. **Depende de autorização expressa para criar recursos externos e assumir custos** | **BLOQUEADO por autorização/infra; preparação documental pode ocorrer em paralelo a G1–G2** |
| **G4 — MVP funcional em dispositivo real** | Instalar Agent em Windows consentido, parear em staging, autenticar cliente MCP e executar o fluxo completo com autorização local e auditoria | Sessão real registrada: pairing, conexão outbound, leitura read-only, negação de operação fora do escopo, desconexão/reconexão sem replay, revogação, rastreabilidade; nenhum segredo em log | **BLOQUEADO por G1, G2 e G3** |
| **G5 — Exit review técnico e Phase 16** | Fechar escopo mínimo de compatibilidade na [#49](https://github.com/sylviohmartins/telechir/issues/49), reconsolidar matriz atual, threat model e release/security gates. Não ampliar a lista indefinidamente | Matriz por cliente/versão `PASS/BLOCKED/NOT_TESTED` justificada; suíte candidata integral Rust/Worker/Dashboard, policy/approvals, TLS, owner/workspace, SSRF, concorrência, SBOM/audit; zero blocker severo não resolvido | **PARCIAL** (OAuth/interop comprovados em CI; consolidar e certificar no release candidate após G4) |
| **G6 — Beta fechado** | Pacote Agent com integridade, instalação/desinstalação/upgrade/rollback, onboarding, consentimento, alertas, privacidade/retention, operação/incident response, custo e metas | Usuários convidados conseguem completar a jornada; logs/auditoria/revogação/recuperação/rollback verificados; métricas e achados documentados | **NÃO INICIADO; exige G4–G5** |
| **G7 — Lançamento por canal** | Quando escolhido, resolver publicação/approval OpenAI [#15](https://github.com/sylviohmartins/telechir/issues/15), clearance de marca/distribuição [#14](https://github.com/sylviohmartins/telechir/issues/14), produção, privacidade/termos/suporte e release assinado | Publicação efetiva no canal/plano prometido, onboarding real e rollback, verificações de marca e status legal; evidência de aprovação do fornecedor, não apenas `submission ready` | **BLOQUEADO por G6, aprovação externa e decisões comerciais** |

**Caminho crítico:** G1 → G2 → (G3 autorizado) → G4 = **MVP funcional** → G5 + G6 = **beta** → G7 = **lançamento público**. Segurança/release engineering de G5 pode ser preparada em paralelo; nenhum gate é automaticamente aprovado por concluir outro.

### Regras de execução e antiescopo (adaptadas do Superpowers)

1. **Trabalho próximo:** concluir G1/#82 antes de novas baterias de compatibilidade de clientes opcionais. Começar pela ligação efetiva do `main.rs` a identity/pairing/credential broker e ao supervisor, sem ativação remota implícita.
2. **Uma entrega verificável por PR:** requer teste que falha antes, implementação mínima, teste positivo/negativo, revisão e CI no último SHA. Um PR só de documentação não passa a contar como gate do produto.
3. **Definição de encerrado:** o campo muda de `BLOQUEADO`/`EM EXECUÇÃO` para `CONCLUÍDO` **somente com link da evidência de aceite end-to-end daquele gate**. Teste de módulo não quita o gate operacional.
4. **A cada rodada de trabalho:** mostrar `ETAPA ATUAL | ENTREGA DESTA RODADA | EVIDÊNCIA | PRÓXIMA AÇÃO | BLOQUEIO EXTERNO`. Atualizar este painel e `PROJECT_STATE.md` quando um gate mudar, evitando gerar documentos paralelos e relatórios repetitivos.
5. **Congelamento de escopo do MVP:** não adicionar clientes, ferramentas, plataformas, frameworks, automações ou novas fases só para gerar avanço aparente; novos requisitos passam a backlog pós-MVP com justificativa e aceite explícito.
6. **Respeitar guardrails existentes:** nenhuma produção/publicação/custo sem autorização; não executar `cargo build/test/clippy/run` no Windows pessoal sem opt-in (Avast), usar CI hospedada. Não classificar incompatibilidade de fornecedor como defeito do Telechir sem evidência.
7. **Sem percentual arbitrário nem data fabricada:** publicar gates concluídos/pendentes e motivos. Prazos dependem do trabalho restante e dos recursos/autorizações; diferenciar esforço estimado de prazo de calendário quando for calculado.

### Próximas entregas técnicas dentro de G1 (não criar fases adicionais)

- **G1-A — Bootstrap provisionado: IMPLEMENTADO / VALIDADO EM LABORATÓRIO (PR #88).** Interfaces de keyring/identity, pairing e credencial de 60 s preparam sessão sem abrir WebSocket. [Aceite técnico](../testing/acceptance/phase16-agent-g1a-provisioning-2026-10-13.md), [CI Windows #38428031545](https://github.com/sylviohmartins/telechir/actions/runs/38428031545), 118 testes Rust. **Não** comprova pairing humano real, keyring pessoal nem E2E; manter G1 aberto. G1-B é a próxima entrega.
- **G1-B — Host residente:** `main.rs` com `--serve`/modo explícito equivalente, estados `UNPAIRED/READY/CONNECTED/BLOCKED`, shutdown/heartbeat/reconnect bounded com **credencial nova**; seguir a API `runtime.rs` existente, sem trabalho de fundo permanente por padrão.
- **G1-C — Executor seguro:** encaixar executor existente, roots/workspaces e policy/approvals/audit ao runtime com default-deny, testes de side effects, deduplicação e falha fechada.
- **G1-D — Aceite do Agent:** loopback completo em CI Windows/Linux com credenciais sintéticas **somente para teste**, sem acesso ao dispositivo pessoal; review e exit evidence da #82. Só então iniciar G2.

Os nomes de interfaces e flags em G1-A/B são **direção de planejamento**, não contratos técnicos já implementados; serão fixados no spec/TDD antes do código. Não há sinal verde implícito para executar comandos no dispositivo físico.

---

## Atualização P0 — Agent Windows e entrypoint operacional (2026-10-12)

No Windows físico autorizado, o core Rust passou 96/96 testes, `rustfmt`, Clippy, build MSVC e bootstrap fail-closed com capacidades de input desligadas. A prova está em [aceite Windows](../testing/acceptance/phase16-windows-agent-native-preflight-2026-10-12.md). **Isso não é E2E físico:** `agent/src/main.rs` apenas carrega e valida configuração, imprime `core ready` e encerra sem criar identidade, pairing ou sessão realtime. A [issue #82](https://github.com/sylviohmartins/telechir/issues/82) é dependência bloqueante do vertical slice real; concluir a Phase 16 de clientes MCP não substitui implementar o entrypoint residente. Um workflow Windows cobre build/tests em CI e também não prova dispositivo remoto. Staging segue dependente de autorização específica.

## 1. Diagnóstico executivo: três conceitos diferentes

- **Implementado:** Phases 0–10 e 12–15 marcadas completas em seus escopos; a Phase 11 entregou `PHASE_11_SUBMISSION_READY`, não publicação. Agent Rust, Worker, D1, Durable Objects, Dashboard MVP e 24 MCP tools compõem a implementação de referência.
- **Certificado:** Phase 16 permanece `PHASE_16_IN_PROGRESS`. Laboratório CI comprovou OAuth interativo iniciado pelo Inspector MCP oficial e pelo Codex CLI real, contra Keycloak real e Workerd/D1 locais, **com identidade sintética**. Gemini ainda só possui preflight RFC 9207 e conexão com Bearer de fixture; Claude Code só conectividade com Bearer de fixture. Nenhum desses PASS constitui uso por modelo em inferência ou acesso a dispositivo físico.
- **Operável/publicado:** sem evidência de ambiente público de staging/produção, autenticação e dispositivos reais, distribuição assinada do agent, review/approval OpenAI ou disponibilidade pública. Clearance comercial separado e pendente.

**Critério de verdade:** `PASS` deve identificar cliente, versão, caminho de autenticação, transporte, ambiente, ferramenta executada e negativas. `BLOCKED` e `NOT_TESTED` não podem virar `PASS` com base em CI sintética ou documentação.

## 2. Pendências e saídas verificáveis

| Prioridade | Frente | Situação em 2026-10-09 | Gate de saída com evidência exigida | Dependência |
|---|---|---|---|---|
| P0 | Consolidar Phase 16 / #49 | Em andamento | Matriz por cliente/versão atualizada; negativa de autorização/owner/workspace; testes de interop modernos/legado; threat model; exit review explícito | CI de último head e clientes reais viáveis |
| P0 | Integração Gemini CLI | Preflight de issuer PASS, `/mcp auth` não comprovado | Gemini inicia seu próprio OAuth, gera PKCE, recebe callback/token e chama `list_devices` read-only; negativas de scope/usuário desativado | Terminal CLI e capacidade real de autenticação da interface |
| P0 | Integração Claude Code e outros hosts relevantes | Conectividade JWT/fixture ou NOT_TESTED | OAuth/tool call real pelo host conforme suporte; quando inviável, `BLOCKED` documentado com motivo e versão | Conta/UI/limitações oficiais, sem credenciais pessoais em CI |
| P0 | Security/release regressions | Gates históricos existem, não constituem ensaio geral de release | Reexecutar Rust, Worker, Dashboard e integração; cross-owner/workspace, replay, reconnect, fencing, policy local, approval crítico, SSRF e TLS fail-closed; revisão independente de achados | Ambiente controlado e fixture não sensível |
| P0 | Staging público (sem produção) | Não comprovado | Worker HTTPS, D1 e migrações, DO, IdP/OIDC, DNS/TLS válidos, IAM mínimo, secrets, limites de custo, observabilidade e rollback testados; inventário de recursos | Domínio/conta, autorização explícita para provisionamento e custos |
| P0 | E2E com agent/dispositivo real autorizado | Não comprovado | Instalação/identidade/pairing, outbound WebSocket, chamada MCP, leitura e escrita bounded, confirmação local humana, isolamento owner/workspace, desativação, reconexão e trilha auditável | Staging + máquina de homologação consentida |
| P1 | Beta fechado | Não iniciado/comprovado | Usuários convidados consentidos, onboarding, suporte, backup/restore, alertas, retenção/redação de logs e SLOs definidos/medidos, ensaio de rollback | Staging, E2E e revisão de segurança |
| P1 | Publicação do plugin OpenAI / #15 | `EXTERNAL_GATES_PENDING` | Publisher e permissões, domínio/verificação, assets, OAuth/OIDC + UserInfo, demo/reviewer, scan, submissão, review, approval, instalação e uso real nas surfaces/planos-alvo; quota medida | Produção estável e requisitos externos do fornecedor |
| P1 | Marca e distribuição comercial / #14 | `COMMERCIAL_CLEARANCE_PENDING` | Verificações/reservas autoritativas de domínio/namespaces/handles e marca; decisão legal documentada | Decisão de distribuição/mercados e orçamento |
| P2 | Plataforma extra (macOS/Linux computer use, streaming, clipboard etc.) | Fora do escopo comprovado | Somente se priorizado em nova decisão arquitetural, threat model e aceite independentes | Autorização específica do escopo |

**P0/P1/P2 aqui ordenam trabalho recomendado, não declaram que todos os clientes e itens opcionais sejam necessários a qualquer MVP.** O conjunto mínimo de hosts homologados para o primeiro beta deve ser decidido explicitamente na conclusão da Phase 16.

## 3. Caminho crítico sugerido (workstreams, não novas fases oficiais)

1. **A — Fechar certificação mínima:** consolidar matrizes e versões. Validar clientes que conseguem fazer OAuth próprio, `tools/list` e `list_devices`, preservando negativos. Registrar impedimentos sem simular suporte.
2. **B — Preparar release security:** baseline de regressão no agent, Worker, Dashboard e plugin package; SBOM/audit, revisão de capabilities, proteção de segredos e cadeia de build, assinatura/distribuição e rollback. Não aceitar apenas 3 jobs de interop como teste total.
3. **C — Provisionar staging autorizado:** recursos segregados, custos monitorados, configuração IAM/TLS/IdP, migração/rollback/backup e telemetria redigida. Exigir autorização específica antes de criar recursos externos.
4. **D — Validar vertical slice com dispositivo real:** pairing → agente outbound → OAuth real do cliente → `list_devices` → operação tipada autorizada → confirmação local quando crítica → auditoria/revogação, inclusive reconexão/replay.
5. **E — Beta fechado e critérios de operação:** documentar responsabilidade por incidentes, observabilidade, custo, limites, recuperação, privacidade, consentimento e segurança; colher evidência de sessões reais.
6. **F — Publicação por canal:** completar #15 para OpenAI e #14 para comercial quando aplicável; aprovação externa e experiência final são resultados a verificar, não consequências automáticas de um PR.

**Dependências importantes:** C antecede D; B e D antecedem beta E; D/E e gates externos antecedem F. Parte de A pode ocorrer em paralelo com B. Não presumir que todas as certificações da Phase 16 exigem produção hospedada: laboratórios isolados ainda agregam cobertura.

## 4. Definição de pronto por marco

### Beta técnico interno
- [ ] Revisão de Phase 16 define e justifica conjunto mínimo de clientes (além de Inspector), testes positivos e negativos, `PASS/BLOCKED/NOT_TESTED` auditáveis.
- [ ] Regressões do agent Rust, control plane, dashboard e segurança aprovadas no commit candidato, não apenas em PRs históricos.
- [ ] Staging autorizado, com identidade, TLS, gestão de segredos e rollback comprovados.
- [ ] Dispositivo autorizado completa jornada MCP→agent; local policy e aprovação para ações críticas são observadas.
- [ ] Falhas de owner/workspace, escopo, expiração/desativação, replay, concurrent side effects/lease, SSRF e input inseguro negadas no ambiente E2E.
- [ ] Logs sanitizados, retenção e exclusão de dados, alertas, limites de custo e procedimentos de incidente definidos.

### Beta fechado com usuários
- [ ] Checklist interno acima concluído, achados de segurança severos resolvidos ou release explicitamente bloqueado.
- [ ] Instalação/atualização e rollback do agent documentados, integridade de artefatos verificada.
- [ ] Onboarding, consentimento informado, revogação, suporte e recuperação demonstrados com usuários autorizados.
- [ ] Metas de latência, disponibilidade, custos, retenção, RTO/RPO **definidas antes da medição**; resultados reais documentados.

### Plugin publicado / lançamento comercial (quando escolhido)
- [ ] Gates externos #15 e aprovação/disponibilidade efetiva verificados por superfície/plano, sem confundir com `PHASE_11_SUBMISSION_READY`.
- [ ] Marca/domínio/packages avaliados na fonte autoritativa; #14 concluída ou risco comercial aceito formalmente.
- [ ] Termos, privacidade, segurança do usuário, monitoramento e canal de suporte apropriados à distribuição definidos.
- [ ] Publicação e rollback de release executados somente após aprovação explícita do respectivo gate.

## 5. Lacunas de evidência e próximos atos verificáveis

- **Já comprovado:** [PR #73](https://github.com/sylviohmartins/telechir/pull/73) integrado (`dbd4bf8`); [PR #72](https://github.com/sylviohmartins/telechir/pull/72) integrado (`7362d34`); CI Codex [#38000131102](https://github.com/sylviohmartins/telechir/actions/runs/38000131102) com 3/3 jobs `success`. Estes resultados abrangem laboratório, não produção.
- **Cliente independente:** [Inspector interativo](../testing/acceptance/phase16-inspector-interactive-oauth-2026-10-09.md) e [Codex CLI interativo](../testing/acceptance/phase16-codex-cli-interactive-oauth-2026-10-09.md) demonstrados; Gemini possui apenas [preflight RFC 9207](../testing/acceptance/phase16-gemini-oauth-rfc9207-preflight-2026-10-09.md).
- **A fazer imediatamente:** selecionar um próximo gate exequível de OAuth/tool call nativo; atualizar a matriz agregada que ainda conserva algumas frases históricas `NOT_TESTED` após PRs recentes; executar negativas e atualizar #49 por evidência.
- **A fazer antes de release:** abrir planejamento/aceites específicos para B–F após aprovação do escopo; **não** criar Phase 17 ou infraestrutura em decorrência deste documento.
- **Bloqueadores humanos/externos:** contas autorizadas, domínio e IdP hospedado, billing/infra, dispositivos de homologação e publisher/review exigem permissão/ações verificáveis; nunca mascará-los por testes sintéticos.

## 6. Decisões que faltam, sem bloquear o desenvolvimento atual

Antes de dar status `DONE` ao produto, registrar: (i) quais hosts/surfaces compõem o MVP, (ii) se o alvo é beta privado, plugin público ou lançamento comercial, (iii) orçamentos/limites e responsável por recursos, (iv) plataformas/distribuição do agent, (v) SLO/RTO/RPO/retention e (vi) grau de avaliação de segurança exigido. Esses valores **não constam como aprovados** no corte auditado. Nenhuma percentagem de prontidão ou data de lançamento é inferida.

---
**Resultado desta auditoria:** arquitetura e escopo técnico avançados, mas `PRODUCT_RELEASE_READY = false`; o bloqueio principal para demonstrar um produto operacional é o **E2E hospedado com dispositivo autorizado, segurança e operação**, enquanto a publicação OpenAI e clearance comercial são trilhas adicionais, com gates externos próprios.
