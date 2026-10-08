# Phase 16 — Plano de smoke externo sem credenciais pessoais

Data: 2026-10-08
Issue: #49
Status: plano operacional reprodutível; não representa execução.

## Separação das classes de evidência

1. **Testes in-process do SDK MCP**: verificam contratos internos do control plane sob Miniflare/Vitest; não são produto externo.
2. **Cliente independente MCP Inspector**: testa comunicação real via HTTPS a partir de outro processo, após provisionar ambiente de homologação. O comando executado e a versão devem ser registrados.
3. **CLI/host do fornecedor** (Codex, Claude Code, Gemini CLI, Copilot): exige uma sessão real do produto, scopes e consentimentos apropriados. A passagem do Inspector não certifica esses produtos.

## Pré-requisitos de homologação

- Endpoint remoto HTTPS isolado, com domínio e certificado validamente confiáveis, sem reaproveitamento de produção e sem expor máquina pessoal.
- IdP OAuth separado de produção, emissor e audience coerentes com o resource-server MCP; conta/test device com somente dados sintéticos.
- Teste inicial **somente leitura**, usando `list_devices`, `get_device` e `tools/list`; nenhuma tecla/mouse, shell host ou workflow mutável até policy e approval validados.
- Read-only token e token sem privilégios adicionais para provar `401/403` por falta de autorização; não copiar tokens para issue ou logs.
- Agressão de concurrência AB-028/029 validada com dois clientes antes de qualquer divulgação comercial de multi-IA.

## MCP Inspector CLI (independente)

Documentação oficial (2026):
- https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli
- https://github.com/modelcontextprotocol/inspector/tree/main/clients/cli

Com um endpoint e autenticação de homologação **já disponíveis**, executar em sessão isolada:

```bash
npx --yes @modelcontextprotocol/inspector --cli \
  https://<HOST_DE_HOMOLOGACAO>/mcp \
  --transport http --stored-auth-only --method tools/list --format json
```

`--stored-auth-only` impede abertura de OAuth interativo em CI e falha se não houver autenticação armazenada. Com sessão autorizada existente, também é possível usar `--use-stored-auth` conforme a documentação. Nunca incluir token literal em argumento/comando persistido, relatório ou YAML de CI.

Registrar: pacote+versão, método, transport, status/exit code, contagem de tools, diferenças de schema/annotations, sanitização de saída e comportamento 401/403. Sem endpoint ativo, registrar `BLOCKED`, não forjar resposta.

## Clientes oficiais

| Cliente | Configuração a validar (não executar sem ambiente) | Referência |
|---|---|---|
| Claude Code | `claude mcp add --transport http`, consentimento OAuth | https://code.claude.com/docs/en/mcp |
| Gemini CLI | `mcpServers.<nome>.httpUrl`, `/mcp auth`, evitar `trust: true` | https://geminicli.com/docs/tools/mcp-server/ |
| Codex | configuração de Remote MCP e login com CLI/host suportado | https://developers.openai.com/learn/docs-mcp |
| GitHub Copilot | settings MCP do host IDE, approvals e restrições corporativas | https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context |

Se os binários não estiverem no PATH, isso não demonstra incompatibilidade com o Telechir. Não alterar profiles pessoais de clientes, home ou armazenamento de credenciais para testes automatizados sem ambiente explicitamente isolado.

## Critérios mínimos de aceite de cada cliente

- Nome e versão exatos do host; transporte realmente utilizado; `tools/list` com 24 tools;
- permissão de leitura funciona, mutação com token somente de leitura é negada;
- device/workspace de outro usuário rejeitado; revogado/expirado falha fechado;
- UX de consentimento/approval não substitui enforcement do Telechir;
- side effect benigno demonstrado *somente* com identidade/policy/aprovação corretas;
- erro, desconexão, reconexão e idempotência reportados sem duplicação;
- logs/prints/telemetria sem conteúdo sensível.

O gate `PHASE_16_COMPLETE` permanece bloqueado até cobertura real e decisão explícita de suporte por cliente.
