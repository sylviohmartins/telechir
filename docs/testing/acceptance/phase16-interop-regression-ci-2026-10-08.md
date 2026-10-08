# Phase 16 — Gate incremental de interoperabilidade e CI

Data: 2026-10-08
Issue: #49
Status: implementação de CI e novos regressions; certificação real de clientes permanece pendente.

## Entrega incremental

- Workflow `.github/workflows/mcp-interop.yml`, sem publicação/deploy, permissões restritas a `contents:read`, triggers PR/push main/manual, serializado por ref.
- Node.js 24, `npm ci` a partir de `apps/control-plane/package-lock.json`, formatação, typecheck, Vitest em Miniflare/Cloudflare, dry-run Wrangler e npm audit de vulnerabilidades altas.
- Novos testes `mcp.test.ts` para clientes legacy independentes de sessão: descriptor/schema/annotations/security-schemes nas 24 tools; dois OAuth owners concorrentes sem vazamento cruzado; ausência/invalidez do bearer e tentativa de usar browser com somente scope de arquivos.
- Os resultados de protocolo não constituem prova de clientes externos Claude/Gemini/Copilot/Codex.

## Análise de um falso negativo do fixture

A primeira execução ampliada retornou 17/18: token inválido lançava `Error` genérico no **fake verifier** usado pelo teste, mapeando o erro simulado para HTTP 500. O `JwtAccessTokenVerifier` real já converte erros de verificação em `OAuthError(InvalidToken)`. Corrigiu-se a equivalência do verifier fake, preservando o runtime. Reexecução local do arquivo MCP: **18/18 PASS**.

## Evidência e critérios

- **Evidência local no PREDATORH300 (2026-10-08):** formatação PASS; typecheck PASS; Vitest 18 arquivos/**119 testes PASS** (MCP 18/18, incluindo os 3 novos; AB-028/AB-029); Wrangler 4.148.0 dry-run PASS (942,66 KiB / gzip 175,75 KiB); npm audit --audit-level=high PASS, 0 vulnerabilidades. YAML parse pelo Prettier: PASS. Nenhum deploy.
- **GitHub Actions:** status independente da execução local; registrar workflow run/checks no PR antes de declarar CI PASS. A presença do YAML não é sucesso por si só.
- Sem novas ferramentas, transportes internos ou permissões; AB-028/029 são regressões obrigatórias.
- O status remoto de CI foi comprovado posteriormente: run #37843796029 (PR #51) e run #37843837500 (push da main), ambos com **conclusão success em todos os steps**; fonte: `docs/testing/acceptance/phase16-verified-ci-and-local-tls-2026-10-08.md`. O workflow novo acrescenta testes unitários de preflight TLS na sequência, sem executar tráfego de rede nem obter segredos em CI.
- O fluxo Git exige branch curta, PR, verificação de head/checks/mergeability, merge, exclusão de branches e `main` limpa.
- **Não** encerrar #49 nem avançar à Phase 17 com base neste workflow: clientes reais exigem ambiente de homologação apropriado.

Fonte do runner GitHub: https://github.com/actions/setup-node
Fonte do Vitest Workers: https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/
