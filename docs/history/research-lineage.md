# Linhagem da Pesquisa — Como o Projeto Nasceu

Este documento explica como o projeto evoluiu de uma limitação prática para um programa de pesquisa de produto e arquitetura. É uma narrativa histórica, não a especificação atual do produto.

## 1. Gatilho: continuar trabalhando quando a quota de um agente acaba

O gatilho inicial foi uma imagem capturada durante uso do ChatGPT mostrando a mensagem **“Limite Semanal do Codex acabou, mas...”** enquanto o Remote Desktop Commander era utilizado para continuar operando um ambiente de desenvolvimento. A evidência está registrada em `artifacts/evidence/` e no manifesto de proveniência.

A observação reformulou o problema: a capacidade útil não era “Codex” em si, mas uma camada reutilizável de execução que desse a uma IA autorizada “mãos” controladas sobre uma máquina.

## 2. Censo do ecossistema

A primeira grande fase mapeou o ecossistema em vez de tratar Remote Desktop Commander como produto isolado. O censo normalizou **181 ferramentas/projetos materialmente relevantes** entre:

- bridges e MCP servers;
- coding agents;
- ferramentas de computer-use/browser;
- sandboxes;
- execução remota;
- executores CI/CD.

A pesquisa consolidou o conjunto recorrente de capabilities: filesystem, terminal/process lifecycle, Git, browser/GUI, conectividade remota, sandboxing, auditabilidade e policy.

Fontes canônicas:
- `artifacts/reports/2026-09-29-ai-computer-control-ecosystem-census.md`
- `artifacts/datasets/2026-09-29-ai-computer-control-ecosystem-census.{csv,json}`

## 3. Primeiro blueprint completo

Depois foi produzido um primeiro blueprint técnico/de produto com o working name **MachinaPort**. Ele propôs uma camada de controle agnóstica a modelos e policy-first, com:

- control plane Cloudflare;
- conectividade outbound do dispositivo;
- autoridade de policy local;
- filesystem/process/Git primeiro;
- GUI/browser posteriormente;
- compatibilidade multi-device e multi-IA;
- auditabilidade e sandboxing progressivo.

MachinaPort foi explicitamente rejeitado como nome. O blueprint continua importante porque registra a primeira arquitetura coerente antes das correções seguintes.

Snapshot histórico:
- `artifacts/archive/2026-09-29-product-technical-blueprint-machinaport-draft.md`

## 4. Correção de viabilidade ChatGPT Plus/plugin

Uma descoberta crítica veio depois: a experiência-alvo não pode depender de usuário Plus registrar manualmente um custom MCP com full write.

A arquitetura passou a distinguir:

- **distribution layer:** plugin/app público do ChatGPT;
- **AI integration layer:** backend Remote MCP;
- **control plane:** routing/auth/policy metadata hospedados;
- **device plane:** agente local seguro.

Registros:
- `docs/discovery/feasibility/chatgpt-plus-public-plugin.md`
- `docs/architecture/adr/0002-chatgpt-plugin-and-remote-mcp.md`

O comportamento ponta a ponta no Plus permanece como release gate que deve ser revalidado antes da implementação final.

## 5. Naming discovery — rodada 1 (2026-09-29)

O projeto abandonou nomes compostos excessivamente pragmáticos e executou processo estruturado de naming.

A primeira rodada elevou **Telechir**, termo histórico de teleoperação para um manipulador remoto semelhante a uma mão, a `NAME_CONDITIONAL`. O fit semântico era forte, mas pronúncia, domínio/packages e trademark clearance permaneceram incompletos.

Artefatos:
- `artifacts/reports/naming/2026-09-29-naming-discovery-report.md`
- `artifacts/datasets/naming/2026-09-29-naming-discovery-candidates.json`

## 6. Naming discovery — rodada 2 (2026-10-01)

Uma segunda rodada ampliou territórios semânticos e candidatos. Finalistas criativos incluíram **Grapnel, Skeg, Nervo, Prehend e Hawse**, mas o gate terminou em `NAME_NOT_READY` porque os nomes mais fortes apresentaram colisões materiais ou pendências relevantes de clearance.

Artefatos:
- `artifacts/reports/naming/2026-10-01-naming-discovery-report.md`
- `artifacts/datasets/naming/2026-10-01-naming-discovery-catalog.json`
- `artifacts/datasets/naming/2026-10-01-naming-discovery-top20.csv`
- `artifacts/datasets/naming/2026-10-01-naming-discovery-raw-candidates.csv`

Exports de trabalho combinados ficam também consolidados em:
- `artifacts/datasets/naming/canonical-naming-candidates.csv`

## 7. Naming discovery — Stage 2 de nomes construídos (2026-10-01)

Após a saturação de palavras reais curtas, foi executada uma etapa específica de **Constructed Distinctive Names**.

A etapa:
- materializou 560 candidatos construídos/normalizados;
- preservou os melhores territórios semânticos das rodadas anteriores;
- fez collision screening antecipado;
- produziu shortlist e catálogo estruturados;
- comparou os finalistas sintéticos com Telechir.

Resultado: nenhum nome construído superou Telechir em autenticidade, narrativa e fit de produto. Telechir voltou a ser a recomendação primária, em estado `NAME_CONDITIONAL`.

Artefatos:
- `artifacts/reports/naming/2026-10-01-constructed-names-discovery-report.md`
- `artifacts/datasets/naming/2026-10-01-constructed-name-candidates.csv`
- `artifacts/datasets/naming/2026-10-01-constructed-name-shortlist.csv`
- `artifacts/datasets/naming/2026-10-01-constructed-name-catalog.json`

Naquele momento, o rename do repositório ainda estava bloqueado por decisão de processo. Em 2026-10-02, após `NAME_READY`, o repositório foi posteriormente renomeado para `telechir`; o clearance comercial permaneceu separado.

## 8. Naming discovery — seleção definitiva (2026-10-02)

A etapa final separou **decisão de marca** de **clearance jurídico/comercial**.

Após mais de mil candidatos entre rodadas de palavras reais e nomes construídos, nenhum candidato superou Telechir na combinação de autenticidade, semântica, storytelling, extensibilidade e baixa colisão contemporânea preliminar.

A marca foi formalmente selecionada:

- **Nome:** Telechir
- **Naming gate:** `NAME_READY`
- **Commercial/legal gate:** `COMMERCIAL_CLEARANCE_PENDING`

Essa distinção permite ao projeto adotar identidade estável sem alegar, incorretamente, que domínio, packages ou trademark já foram reservados.

Artefatos:
- `artifacts/reports/naming/2026-10-02-final-name-selection-report.md`
- `artifacts/datasets/naming/2026-10-02-final-name-selection.json`
- `docs/brand/README.md`

## 9. Por que o repositório existe antes e depois da marca final

O nome descritivo original `ai-computer-control-research` foi intencional enquanto o naming estava aberto. Após `NAME_READY`, o repositório foi renomeado para `telechir`, preservando todo o histórico Git e a linhagem documental.

Ele preserva:

- evidência original;
- decisões superadas;
- conclusões vivas;
- ADRs;
- raciocínio de segurança;
- gates de viabilidade;
- pesquisa de naming;
- planos futuros de implementação.

Isso evita que agentes ou colaboradores futuros confundam o documento mais recente com toda a história de por que o produto existe.

## 10. Da especificação ao vertical slice executável (2026-10-02 → 2026-10-05)

Após o discovery, o projeto atravessou as Phases 0–14 em sequência gated:

- Phase 0 congelou repository/protocol specifications;
- Phase 1 implementou o Local Agent Core;
- Phase 2 implementou o control plane Cloudflare;
- Phases 3–5 materializaram identity/pairing, realtime e Remote MCP/OAuth;
- Phases 6–8 adicionaram filesystem, process lifecycle e Git read-only;
- Phase 9 materializou policy/approvals/audit com autoridade final local;
- Phase 10 adicionou o Dashboard MVP;
- Phase 11 revalidou a distribuição pública OpenAI e criou package/review tooling fail-closed;
- Phase 12 adicionou sandbox Docker opt-in para process tools sem ampliar a autoridade local;
- Phase 13 adicionou Computer use tipado/bounded no Windows, com captura one-shot HIGH e input single-action CRITICAL com confirmação local;
- Phase 14 adicionou Browser automation tipada/isolada via Playwright, com `BROWSER` como authority própria, contexts efêmeros e egress anti-SSRF.

A Phase 11 confirmou que a arquitetura definida na correção de viabilidade continuava válida, mas atualizou o processo de release para o fluxo corrente de package ZIP, `plugin.json + mcp.json`, domain verification, tool scan e review estruturado.

Registros:
- `PROJECT_STATE.md`
- `docs/testing/acceptance/phase11-exit-review-2026-10-05.md`
- `docs/research/openai/phase11-public-plugin-revalidation-2026-10-05.md`

## 11. Sandbox como defense-in-depth (2026-10-05)

A Phase 12 adicionou uma distinção operacional que já existia conceitualmente no blueprint: execução protegida no host e execução em sandbox não são a mesma boundary.

O primeiro provider de sandbox usa Docker local opt-in, image imutável já presente, rede desabilitada, rootfs read-only, capabilities removidas e apenas o workspace autorizado como bind gravável. Policy e approval continuam fora do container e permanecem a autoridade real.

Registros:
- `docs/testing/acceptance/phase12-exit-review-2026-10-05.md`
- `docs/security/threat-model/phase12-sandbox-mode-2026-10-05.md`
- `docs/research/docker/phase12-sandbox-revalidation-2026-10-05.md`

## 12. Computer use com confirmação local (2026-10-05 → 2026-10-06)

A Phase 13 materializou a primeira superfície GUI do Telechir sem introduzir remote desktop genérico. A decisão foi dividir observação e ação: `capture_screen` é one-shot/HIGH; `control_computer` executa uma única ação CRITICAL por command e depende de confirmação humana local no device.

O primeiro adapter é Windows. O crate principal manteve `forbid(unsafe_code)` e o Win32 FFI foi isolado em `agent/platform/windows-computer/`. macOS/Linux permaneceram capability-unavailable até que adapters com mecanismos de consentimento nativos sejam implementados.

Registros:
- `docs/testing/acceptance/phase13-exit-review-2026-10-06.md`
- `docs/security/threat-model/phase13-computer-use-2026-10-05.md`
- `docs/research/computer-use/phase13-platform-revalidation-2026-10-05.md`

## 13. Browser automation como authority própria (2026-10-07)

A Phase 14 materializou browser automation sem reutilizar `INPUT_CONTROL` e sem expor Playwright/CDP/WebDriver diretamente.

A decisão central foi criar permission `BROWSER` própria e uma superfície de seis tools tipadas. O primeiro adapter é um sidecar Playwright local com context não persistente, Chromium sandbox ligado, snapshots semânticos bounded e egress anti-SSRF obrigatório.

O hardened smoke confirmou que redirects, subresources e WebSockets não alcançam um target `localhost` protegido; a prova válida precisou executar Chromium como usuário não-root porque o próprio Chromium recusou sandbox sob root.

Registros:
- `docs/testing/acceptance/phase14-exit-review-2026-10-07.md`
- `docs/security/threat-model/phase14-browser-automation-2026-10-07.md`
- `docs/research/browser-automation/phase14-playwright-revalidation-2026-10-07.md`

## 14. Estado atual

O projeto está em **`PHASE_14_COMPLETE`** no nível do repositório: runtime local/control plane/Dashboard existem, os materiais versionáveis de package/review OpenAI estão preparados, process tools podem selecionar guarded host/sandbox, Computer use Windows é capability explícita e Browser automation isolada é capability explícita quando o sidecar Playwright passa health.

Isso não significa produção ou publicação. Permanecem abertos:

1. `COMMERCIAL_CLEARANCE_PENDING`;
2. publisher verification/permissões OpenAI;
3. domínio, URLs legais e assets finais;
4. MCP HTTPS de produção;
5. domain verification e tool scan reais;
6. OIDC/UserInfo no IdP externo quando aplicável;
7. reviewer account/demo recording;
8. submission/review/approval/publicação;
9. validação de availability do plugin próprio no Plus;
10. quota/metering;
11. code signing/update path e demais release hardening;
12. hardening adicional de sandbox, como rootless/userns, quota de storage e orphan reconciliation;
13. adapters macOS/Linux de Computer use, screen streaming e target-window binding;
14. persistent authenticated browser, secret injection e raw browser passthrough permanecem fora da surface;
15. multi-device/workspace concurrency ainda não foi implementada.

O próximo item de implementação do roadmap é **Phase 15 — Multi-device/workspace concurrency**.

Artefatos históricos nunca devem ser silenciosamente reescritos para refletir decisões novas. Conclusões novas substituem antigas por documentação viva, exit reviews e ADRs.
