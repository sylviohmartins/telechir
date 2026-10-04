# Instruções para Agentes

Este repositório pode ser utilizado por ChatGPT, Codex, Claude Code, Gemini CLI e outros agentes de IA. Estas regras valem para todo o repositório, salvo se um `AGENTS.md` mais específico for criado em um subdiretório.

## Guardrail da fase atual

O projeto concluiu discovery e as Phases 0–7. **Não inicie automaticamente a Phase 8 apenas porque `PROJECT_STATE.md` registra `PHASE_7_COMPLETE`: Basic Git deve começar somente em uma tarefa explicitamente dedicada a Build, Test & Iterate.** Não atravesse para policy/approvals/audit, dashboard ou fases posteriores sem o gate correspondente. Nunca faça deploy de produção, crie recursos pagos ou publique plugin sem autorização específica da fase correspondente.

## Ordem de fonte de verdade

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
