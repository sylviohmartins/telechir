# Instruções para Agentes

Este repositório pode ser utilizado por ChatGPT, Codex, Claude Code, Gemini CLI e outros agentes de IA. Estas regras valem para todo o repositório, salvo se um `AGENTS.md` mais específico for criado em um subdiretório.

## Guardrail da fase atual

O projeto concluiu discovery e integrou as Phases 0–15 à `main`. A Phase 16 — Multi-AI compatibility certification está em execução via issue #49, com matriz de clientes reais e protocolo; os resultados de SDK/wire não equivalem a certificação de produtos externos. **Não declare `PHASE_16_COMPLETE` sem evidência real dos clientes previstos e validações de segurança**, nem atravesse automaticamente para a Phase 17. Nunca faça deploy de produção, crie recursos pagos ou publique plugin sem autorização específica do gate correspondente.

## Ordem de fonte de verdade
## Contrato de conclusão e reporte — evitar progresso indefinido

O **painel G1–G7** em [`docs/product/release-readiness-2026-10-09.md`](docs/product/release-readiness-2026-10-09.md#painel-de-conclusão--fonte-única-de-verdade-12102026) é a fonte oficial de **etapa atual, próxima ação, dependências, entrega de MVP/beta/lançamento**. Os PRs das Phases 0–15 provam módulos, não um produto E2E. Estado atual: **G1 — Agent operacional, issue #82;** não reabrir certificações opcionais de outros clientes enquanto `agent/src/main.rs` não operar o supervisor de sessão com pairing e policy por padrão fail-closed.

- Para cada `prossiga`/rodada de desenvolvimento, publicar no início e ao fim: **ETAPA ATUAL; ENTREGA DA RODADA; EVIDÊNCIA/PR/CI; PRÓXIMO PASSO ÚNICO; BLOQUEIOS/HUMAN GATES**. Quando não houver entrega de um gate, afirmar claramente que o gate permanece aberto, mesmo que o PR tenha sido integrado.
- Não criar novas fases ou ferramentas sem necessidade para o MVP. Marcar explicitamente `NOT_TESTED`/`BLOCKED` em integrações secundárias inviáveis, com justificativa, sem permanecer indefinidamente explorando.
- Uma tarefa técnica exige critérios de aceite, teste positivo e negativo, revisão do diff, CI no último head e PR integrado apenas depois dos checks. Aplicar quando disponíveis as práticas do **Superpowers**: design objetivo, TDD, plano por entregáveis, verificação antes de alegar conclusão e revisão final. **O plugin não substitui** GitHub Issues/CI, nem é pré-requisito de instalação para outros colaboradores.
- Atualizar **o painel existente** quando G1–G7 avançarem; não produzir novos roadmaps paralelos nem percentuais arbitrários. Separar claramente **MVP técnico, beta e publicação externa**. Nunca declarar MVP `DONE` sem G4/E2E físico aprovado.
- Toda compilação Rust continua CI-first, especialmente no Windows pessoal com Avast; nenhum serviço, produção, Cloudflare pago, publicação ou conta externa sem autorização específica.



1. `PROJECT_STATE.md`
2. ADRs aceitos em `docs/architecture/adr/`
3. documentação viva em `docs/`
4. linhagem histórica em `docs/history/`
5. snapshots imutáveis e proveniência em `artifacts/`

Se um documento vivo entrar em conflito com um artefato arquivado, prefira o documento vivo e preserve o artefato. Antes de redesenhar escopo, naming, distribuição ou arquitetura central, leia `docs/history/research-lineage.md` e a proveniência correspondente.

## Padrões de pesquisa

- Date afirmações mutáveis.
- Prefira fontes primárias para capacidades, preços, limites e segurança.
- Separe fatos verificados, hipóteses e decisões propostas.
- Registre URLs relevantes no documento correspondente.
- Nunca declare domínio, package, marca ou capability como disponível sem verificação atual.

## Padrões de arquitetura

- Registre decisões duráveis como ADRs.
- Não reescreva ADRs históricos para esconder mudança; crie um ADR que substitua o anterior.
- Mantenha o protocolo externo de integração com IA separado do transporte interno de dispositivos, conforme ADR-0006.
- Trate enforcement local de policy como invariante de segurança, conforme ADR-0003.
- Considere `specs/` fonte de verdade para contratos cross-language durante a implementação.
- Mudança breaking em `specs/` exige versionamento e, quando arquitetural, ADR.

## Prevenção de alertas de antivírus no desenvolvimento Windows

- **Não execute** `cargo test`, `cargo build`, `cargo clippy`, `cargo run`, `cargo clean` seguido de build, nem qualquer recompilação Rust no **host Windows pessoal por automação**, salvo autorização explícita do usuário para **aquele** build local. Dependências de crates geram diversos `build-script-build.exe`, que podem disparar janelas repetidas do Avast CyberCapture.
- Para novos gates Windows use a CI hospedada [`.github/workflows/agent-windows-native.yml`](.github/workflows/agent-windows-native.yml) (workflow dispatch/PR), e [`scripts/interop/windows-agent-native-preflight.ps1`](scripts/interop/windows-agent-native-preflight.ps1), que por padrão não executa compilação no host e exige `-AllowLocalBuild` no runner. `cargo fmt --check` não executa build scripts e pode ser usado localmente.
- Não desabilite, suspenda, automatize bypass do Avast/CyberCapture, inclua diretórios do Cargo/Temp em exceções, nem trate alertas de AV como prova de arquivo seguro. Não abra `build-script-build.exe` manualmente. Se houver detecção, preserve a proteção e investigue antes de rodar.
- Não crie `CARGO_TARGET_DIR` novo a cada execução local nem apague caches como rotina, pois isso força rebuild e repete análises. O preflight já aprovado em CI deve ser preferido ao host físico até o runtime operacional do Agent ser implementado.

## Higiene do repositório

- Use commits focados com mensagens no estilo Conventional Commits.
- Não misture pesquisa, arquitetura e implementação sem relação em um único commit.
- Não faça commit de secrets, tokens, credenciais, identificadores privados de infraestrutura ou dados do usuário.
- Não altere arquivos em `artifacts/` salvo para adicionar novo snapshot imutável, melhorar metadados de proveniência ou corrigir corrupção acidental explicitamente documentada.
- Ao importar saídas de ChatGPT/pesquisa, preserve a fonte em `artifacts/source/` quando útil e mapeie-a em `artifacts/provenance/source-manifest.json`.

## Convenção de idioma

- nomes de arquivos, diretórios, branches e identificadores técnicos: inglês;
- documentação e texto explicativo mantidos pelo projeto: português do Brasil;
- nomes oficiais de produtos, APIs, comandos e schemas permanecem no idioma original quando necessário;
- artefatos históricos podem preservar seu conteúdo original quando alterá-los destruiria valor de proveniência.
