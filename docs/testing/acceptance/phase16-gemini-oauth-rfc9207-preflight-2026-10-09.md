# Phase 16 — Gemini CLI: pré-validação OAuth RFC 9207

**Data:** 2026-10-09
**Issue:** #49
**Estado:** PENDING_CI

## Escopo comprovável

A documentação oficial do Gemini CLI expõe autenticação OAuth em **`/mcp auth <server-name>`**, um comando de sessão interativa, diferente do comando administrativo não interativo `gemini mcp list`. O Telechir já tinha prova de descoberta autenticada da CLI com token previamente assinado, mas não do OAuth interativo iniciado pelo Gemini. Este incremento não rebatiza aquela evidência nem injeta Bearer token e diz que isso é login.

O objetivo limitado é preparar um cliente **público de laboratório** `telechir-phase16-gemini` no Keycloak 26.8.0 com `standardFlowEnabled=true`, `PKCE S256`, sem password grant, secret ou consentimento presumido, callback loopback estrito `http://127.0.0.1:8777/oauth/callback` e escopo opcional `telechir:devices:read` atribuído exclusivamente por **API Admin REST autenticada após bootstrap**. O contrato de autorização é inspecionado a partir da resposta real do Keycloak no Chrome já existente (PR #70): sem armazenar code, state, JWT ou URL, são guardados apenas booleanos para documentar se `iss` veio e se corresponde ao emissor.

O preflight Gemini verifica se a configuração exigirá a chave `authorizationResponseIssParameterSupported: false` quando o Keycloak não emitir `iss` e **nunca permite um `iss` divergente** (RFC 9207). Produz uma configuração de laboratório privada com `trust:false`, HTTPS de IdP/Worker, clientId público e `scopes: ["telechir:devices:read"]`, sem tokens ou segredos. Nenhuma configuração é instalada no perfil do usuário nem registrada como segredo do aplicativo.

## Critérios de aprovação

1. Keycloak real com certificate leaf/CA verificados, usuário sintético, browser Chrome headless real, callback e código PKCE previamente aprovados, sem regressões.
2. Novo cliente Gemini associado ao escopo read-only pela API Admin REST oficial sem alterar `profile`, `email` ou `preferred_username` dos clientes existentes.
3. A resposta de autorização real do Keycloak e os metadados OIDC permitem derivar a configuração de `iss` e recusar qualquer emissor substituído.
4. Job Keycloak e os dois demais jobs CI terminam success no último commit.

## Limite inegociável

**Mesmo após esse PASS, OAuth interativo do Gemini CLI continua NÃO CERTIFICADO.** Não há execução do `/mcp auth` do Gemini, token gerado pelo Gemini, callback consumido pelo Gemini ou `list_devices` executado pelo Gemini após OAuth. Esses são gates separados, potencialmente dependentes de sessão interativa da CLI e requerem validação própria. A conexão `gemini mcp list` com JWT previamente fornecido não é um substituto. Documentação oficial: https://geminicli.com/docs/tools/mcp-server/ e https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md.