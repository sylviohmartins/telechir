# Phase 16 — conexão MCP do Gemini CLI real via JWT assinado

**Data:** 2026-10-09
**Issue:** #49
**Cliente externo:** Google Gemini CLI `0.63.0` (versão fixa, lançamento estável 06/10/2026).
**Evidência:** CLI real retornou `Connected` em HTTPS com JWT assinado nos logs de CI do [PR #58](https://github.com/sylviohmartins/telechir/pull/58). A confirmação final depende de dois jobs verdes no commit de merge.

## Novo gate de cliente real

O teste de compatibilidade usa **o executável real do Google Gemini CLI**, não uma imitação ou chamada feita diretamente pelo SDK MCP. A ferramenta `gemini mcp list` verifica conexão ao Telechir com transporte HTTP streaming e autenticação Bearer, em processo independente no runner Ubuntu Linux do GitHub Actions.

O teste aproveita a mesma infraestrutura isolada comprovada no PR #56: `wrangler dev` sobre HTTPS de loopback com pinning/validação de cadeia TLS, `mcpHttpRoute` e `JwtAccessTokenVerifier` reais, JWKS/authorization-server metadata sintéticos, JWT RS256 efêmero, migrações D1 locais e usuário/dispositivo de teste.

O arquivo `scripts/interop/gemini-cli-authenticated-probe.sh` roda *por source* no fim do smoke autenticado já existente, somente quando `PHASE16_REAL_GEMINI_CLI=1`, para evitar copiar ou relaxar o mecanismo de inicialização e limpeza. O token read-only vem de arquivo temporário privado gerado pelo fixture, nunca de contas reais. O probe configura `GEMINI_CLI_HOME` em diretório exclusivo, cria `.gemini/settings.json` com permissão `0600`, define o servidor `telechir-fixture` (`httpUrl`, header Authorization, `trust=false`) e executa `npx --yes @google/gemini-cli@0.63.0 mcp list`. Captura toda saída em arquivos temporários privados e emite somente diagnóstico resumido de sucesso/falha.

## Critérios objetivos

1. O gate independente anterior (MCP Inspector com JWT, D1, 24 tools, leitura e negação de escrita) deve permanecer `PASS`.
2. O Gemini CLI real deve terminar `mcp list` com exit 0 e mostrar **`telechir-fixture - Connected`**, no TLS validado e com Bearer RS256.
3. `npm test` deve manter 125/125; TypeScript, Prettier, TLS unit tests, Wrangler dry-run e npm audit devem passar.
4. Ambiente de teste encerrado com exclusão de token, certificado e configuração do Gemini CLI. Nenhum deploy ou segredo de produção.

## Limites e status de certificação

Um eventual PASS atesta somente **conexão inicial e descoberta MCP com o Gemini CLI real, usando um Bearer sintético já emitido**. Não demonstra uso do modelo Gemini, tool call pelo LLM, prompt de usuário, OAuth PKCE executado pelo próprio Gemini CLI, login/consentimento, token refresh, servidor IdP externo ou compatibilidade com Codex/Claude/Copilot/ChatGPT. Não confundir configuração CLI com conexão: o `Connected` observado é obrigatório. Não marcar a Phase 16 concluída somente por esse gate.

Referências oficiais: [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/), [configuração e GEMINI_CLI_HOME](https://geminicli.com/docs/reference/configuration/), [release 0.63.0](https://geminicli.com/docs/changelogs/latest/).

**Diagnóstico de integração:** Gemini CLI 0.63.0 desabilita os MCP servers em workspace não confiável. O CI cria um diretório privado descartável e autoriza confiança **apenas para o processo do Gemini executado naquele diretório** com `GEMINI_CLI_TRUST_WORKSPACE=true`, seguindo [Trusted Folders — headless CI](https://geminicli.com/docs/cli/trusted-folders/). Essa opção não é usada para confiar no repositório, host ou qualquer diretório persistente. A CLI escreve o status `✓ telechir-fixture: ... (http) - Connected` em **stderr**, não stdout; o verificador aceita o texto somente com o alias correto em qualquer um dos dois canais, sem registrar bearer ou configuração privada.

**Evidência CI:** [checks do PR #58](https://github.com/sylviohmartins/telechir/pull/58/checks). Concluir somente com ambos os jobs `success`. Não converter essa conexão MCP numa homologação de login OAuth externo ou de chamada de ferramenta por modelo.
