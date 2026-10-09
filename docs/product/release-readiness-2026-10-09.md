# Telechir — Auditoria de prontidão para beta, produção e lançamento

**Data da auditoria:** 2026-10-09 (America/Sao_Paulo)
**Baseline revalidado:** `main` em `7362d348dea9bbcbb4431582e9c291514a2f3120` (PR #72 integrado após PR #73), checkout Windows limpo.
**Natureza:** plano de gates verificáveis, **não** autorização para implantar, contratar serviços, publicar plugin ou abrir uma Phase 17.
**Fontes duráveis:** [estado](../../PROJECT_STATE.md), [roadmap](roadmap.md), [regras](../../AGENTS.md), [matriz Phase 16](../testing/acceptance/phase16-certification-matrix-2026-10-08.md), [issue #49](https://github.com/sylviohmartins/telechir/issues/49), [#15](https://github.com/sylviohmartins/telechir/issues/15), [#14](https://github.com/sylviohmartins/telechir/issues/14).

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
