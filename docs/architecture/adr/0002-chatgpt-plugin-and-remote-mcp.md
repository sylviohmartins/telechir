# ADR-0002: Tratar o Plugin do ChatGPT como Distribuição e o Remote MCP como Backend de Integração

- **Status:** Accepted
- **Data:** 2026-10-01
- **Evidência atualizada:** 2026-10-05

## Contexto

O usuário-alvo pode possuir somente ChatGPT Plus. O produto não pode depender de ele registrar manualmente um custom MCP com write completo.

A documentação oficial permite publicar plugins cujo backend é um Remote MCP. O Remote Desktop Commander é uma implementação pública desse padrão.

## Decisão

No ChatGPT:

- o **plugin público** é a camada de distribuição/onboarding;
- o **Remote MCP** é a interface de tools hospedada;
- o **control plane** roteia as chamadas ao dispositivo autorizado;
- o usuário final não precisa cadastrar manualmente um custom MCP.

Para outros clientes, o Remote MCP pode ser consumido diretamente quando compatível.

## Evidência

Em uma conta Plus durante este discovery, o Remote Desktop Commander:

- estava disponível/instalado;
- listou dispositivo autorizado;
- executou processo;
- escreveu e leu arquivo temporário com sucesso.

Isso valida a arquitetura de referência, sem garantir a aprovação futura do nosso plugin específico.

## Consequências

### Positivas
- onboarding compatível com usuário Plus por plugin publicado;
- core continua multi-IA;
- não dependemos de Developer Mode full MCP no Plus;
- arquitetura reproduz padrão já usado por plugin público existente.

### Custos/riscos
- dependência de review e políticas de distribuição da OpenAI;
- availability/capabilities podem variar por plano/surface;
- quota não pode ser inferida;
- tools específicas podem ser restringidas ou bloqueadas durante review.

## Revalidação de 2026-10-05

A arquitetura permanece válida. O fluxo oficial atual foi refinado: distribuição pública usa o diretório universal de plugins ChatGPT/Codex e um package ZIP; para novo package, o formato portátil `plugin.json + mcp.json` é o caminho recomendado. Remote MCP público exige endpoint HTTPS estável, domain verification, scan das tools, material de review e publisher identity verificada.

Esses requisitos não alteram o boundary arquitetural da decisão; alteram o processo de release. A revalidação completa está em `docs/research/openai/phase11-public-plugin-revalidation-2026-10-05.md`.

## Release gates

A decisão arquitetural é Accepted, mas lançamento depende de:

- `OPENAI-PRODUCT-001`: aprovação e disponibilidade do plugin próprio no Plus;
- `OPENAI-PRODUCT-002`: tools mínimas write/process habilitadas;
- `OPENAI-QUOTA-001`: quota/metering documentados empiricamente.
