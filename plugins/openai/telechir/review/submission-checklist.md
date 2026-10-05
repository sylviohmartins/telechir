# Checklist de Submissão Pública — Telechir

**Objetivo:** distinguir readiness técnica local de publicação real no diretório OpenAI.

## 1. Identidade e permissões OpenAI

- [ ] publisher individual ou business verificado com o nome que será exibido;
- [ ] organização/projeto corretos selecionados;
- [ ] membro que submete possui `api.apps.write`;
- [ ] membro que acompanha review possui `api.apps.read`.

## 2. URLs e identidade pública

- [ ] domínio comercial/final definido;
- [ ] website HTTPS publicado;
- [ ] support URL HTTPS publicado;
- [ ] privacy policy HTTPS publicada;
- [ ] terms of service HTTPS publicada;
- [ ] todas as páginas identificam o mesmo publisher da submissão;
- [ ] logo final quadrado >= 48×48;
- [ ] composer icon final quadrado >= 48×48.

A privacy policy deve explicar no mínimo categorias de dados, finalidades, recipientes, retenção e controles do usuário. Não declarar coleta que o produto não faz.

## 3. Remote MCP de produção

- [ ] endpoint público HTTPS estável em `/mcp`;
- [ ] Streamable HTTP funcional;
- [ ] production secrets somente no secret manager;
- [ ] logs não contêm bearer tokens ou conteúdo sensível;
- [ ] timeouts/rate limits/monitoring de produção validados;
- [ ] MCP Inspector valida initialize, tools, schemas, annotations, auth, results e errors;
- [ ] nenhuma dependência de tunnel temporário para review.

## 4. OAuth / OIDC

- [ ] OAuth 2.1 authorization code + PKCE S256;
- [ ] resource metadata público;
- [ ] security schemes por tool;
- [ ] scopes validados em toda tool call;
- [ ] `openid` e `email` anunciados e habilitados no IdP;
- [ ] OpenID Connect discovery publicado;
- [ ] UserInfo Endpoint publicado;
- [ ] UserInfo retorna `email` e `email_verified: true`;
- [ ] callback/client registration vigente da OpenAI revalidado;
- [ ] demo reviewer login funciona sem MFA/SMS/email code/magic link inacessível.

Telechir continua resource server. Não construir authorization server próprio para satisfazer esta checklist; configurar um IdP apropriado.

## 5. Domain verification

Quando o portal gerar o token:

- [ ] configurar `OPENAI_APPS_CHALLENGE_TOKEN` como secret de produção;
- [ ] confirmar `GET /.well-known/openai-apps-challenge` retorna somente o token;
- [ ] confirmar `POST` retorna 405;
- [ ] concluir **Verify Domain** no portal;
- [ ] remover/rotacionar token quando operacionalmente apropriado sem quebrar um challenge pendente.

## 6. Tool scan

- [ ] conectar MCP de produção no draft;
- [ ] executar Scan/Rescan;
- [ ] 16 tools esperadas detectadas;
- [ ] titles/descriptions/schemas corretos;
- [ ] `securitySchemes` corretos;
- [ ] `readOnlyHint`, `destructiveHint`, `openWorldHint` explícitos;
- [ ] findings de scan resolvidos ou documentados;
- [ ] nenhum dado interno/sensível desnecessário nos outputs.

## 7. Review account e dados

Preparar os dados de `demo-account.md`.

- [ ] conta dedicada ao reviewer;
- [ ] nenhuma conta pessoal/produção;
- [ ] nenhuma MFA inacessível;
- [ ] device chamado **Review Device**;
- [ ] arquivo `/workspace/review/hello.txt`;
- [ ] repo `/workspace/review/sample-repo`;
- [ ] diretório `/workspace/review/` habilitado pela policy local;
- [ ] write/process review permitido apenas no escopo necessário;
- [ ] credentials inseridas somente no portal.

## 8. Review cases

Rodar e gravar os 5 positivos e 3 negativos do `package-base.json`.

- [ ] positive 1 — list devices;
- [ ] positive 2 — read sample file;
- [ ] positive 3 — Git status;
- [ ] positive 4 — bounded file write com approval;
- [ ] positive 5 — harmless bounded command;
- [ ] negative 1 — file deletion unsupported;
- [ ] negative 2 — arbitrary network download/execute denied;
- [ ] negative 3 — admin/firewall request denied.

Resultados reais devem coincidir com `expected_behavior`. Atualizar o package se o comportamento divergir; não ajustar a narrativa para esconder a divergência.

## 9. Demo recording

- [ ] URL HTTPS/reviewer-accessible;
- [ ] mostra instalação/linking;
- [ ] mostra autenticação;
- [ ] mostra reads;
- [ ] mostra approval de write;
- [ ] mostra bounded process;
- [ ] mostra negative/refusal;
- [ ] cobre desktop;
- [ ] comportamento mobile validado separadamente;
- [ ] nenhum secret aparece na gravação.

## 10. Package

- [ ] `release-config.json` preenchido fora do Git;
- [ ] builder passa;
- [ ] ZIP contém somente `plugin.json`, `mcp.json` e dois assets;
- [ ] exactly 5 positive + 3 negative;
- [ ] release notes atuais;
- [ ] sem reviewer credentials;
- [ ] sem `.app.json`;
- [ ] sem hooks;
- [ ] sem source tree;
- [ ] sem node_modules/dist operacional;
- [ ] sem screenshots enquanto o MCP não expuser UI.

## 11. Publicação

- [ ] upload do ZIP;
- [ ] automated metadata checks verdes;
- [ ] MCP setup/scan verdes;
- [ ] policy attestations revisadas;
- [ ] Submit for review;
- [ ] decisão de review registrada;
- [ ] se aprovado, Publish plugin;
- [ ] availability real por plano/surface medida;
- [ ] Plus validado no plugin próprio;
- [ ] quota/metering medidos no plugin próprio.

Os três últimos itens continuam sendo gates `OPENAI-PRODUCT-001`, `OPENAI-PRODUCT-002` e `OPENAI-QUOTA-001`.
