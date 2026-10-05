# ChatGPT Plus, Plugins Públicos e Remote MCP — Gate de Viabilidade

**Data da pesquisa:** 2026-10-01  
**Status:** caminho técnico validado; review/distribuição do plugin próprio permanecem como release gates

## Decisão

O produto **não deve depender** de um usuário ChatGPT Plus cadastrar manualmente um custom MCP com write completo.

No ChatGPT, a distribuição planejada é:

```text
usuário Plus
  -> instala plugin público aprovado
  -> plugin usa Remote MCP
  -> control plane hospedado
  -> agente local autorizado
```

## Evidência oficial atual

- plugins podem incluir Remote MCP, skills ou ambos;
- existe fluxo oficial de submission/review para plugin público com Remote MCP;
- o diretório de plugins está disponível entre planos, mas a disponibilidade/capabilities de cada plugin variam por plano/surface/conta;
- o Remote Desktop Commander é publicamente descrito pela OpenAI como plugin que usa Remote MCP para filesystem, terminal, processos e edição de documentos.

## Evidência empírica em conta Plus

Nesta conta Plus, em 2026-10-01:

- Remote Desktop Commander está disponível e instalado;
- `list_devices` retornou um dispositivo online;
- `start_process` executou um `echo` inofensivo com sucesso;
- `write_file` criou um arquivo temporário;
- `read_file` leu de volta o conteúdo;
- o arquivo foi removido ao final.

Portanto, **write + process via plugin público aprovado em uma conta Plus foram demonstrados na prática**.

## O que permanece pendente

Não extrapolar essa evidência para qualquer plugin futuro.

Ainda precisam de validação no nosso produto:

- aprovação no review público;
- elegibilidade/disponibilidade no Plus após publicação;
- aceitação das nossas tools específicas;
- comportamento de approvals;
- surfaces efetivamente suportadas;
- quota/metering.

## Gates

- [x] `OPENAI-ARCH-001`: plugin público pode usar Remote MCP.
- [x] `OPENAI-PLUS-REFERENCE-001`: plugin público aprovado com write/process funciona em conta Plus de referência.
- [ ] `OPENAI-PRODUCT-001`: nosso plugin é aprovado e disponibilizado ao Plus.
- [ ] `OPENAI-PRODUCT-002`: nosso conjunto mínimo de tools write/process passa review e funciona na surface-alvo.
- [ ] `OPENAI-QUOTA-001`: quota/metering medidos no plugin próprio.

## Revalidação posterior — 2026-10-05

A evidência empírica desta nota permanece histórica e válida para a conta/surface observada em 2026-10-01. O processo oficial de publicação foi revalidado em 2026-10-05 e agora está consolidado em `docs/research/openai/phase11-public-plugin-revalidation-2026-10-05.md`.

A arquitetura plugin público + Remote MCP permanece suportada, mas o release do Telechir agora explicita package ZIP, `plugin.json + mcp.json`, domain verification, scan, exatamente 5 casos positivos + 3 negativos para MCP review, demo recording e gates de publisher/produção. Nada disso implica que o plugin Telechir já tenha sido submetido ou aprovado.

## Implicação

O risco de viabilidade foi reduzido de **arquitetural** para **review/distribuição específica do produto**.

Isso é suficiente para prosseguir ao Blueprint v2 sem exigir Developer Mode full MCP no Plus.

## Fontes

- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- https://help.openai.com/en/articles/20001256-plugins-in-chatgpt
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/deploy/app-review
- https://openai.com/business/plugins/remote-desktop-commander/
- `artifacts/reports/feasibility/2026-10-01-chatgpt-plus-public-plugin-validation.md`
