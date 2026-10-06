# Telechir — OpenAI Public Plugin Package

Este diretório contém a fonte versionada para preparar o pacote público do Telechir para o diretório universal de plugins do ChatGPT/Codex.

A Phase 11 entrega **submission readiness técnica**, não publicação. O ZIP final só é produzido quando os inputs externos obrigatórios forem fornecidos fora do Git.

## Estrutura

- `package-base.json` — metadata estável, listing, 5 casos positivos, 3 negativos e release notes;
- `release-config.example.json` — exemplo deliberadamente inválido/fail-closed dos valores externos exigidos;
- `scripts/build_package.py` — validador e builder determinístico;
- `tests/test_build_package.py` — testes negativos e de determinismo;
- `review/tool-annotations.json` — justificativas humanas para annotations das 18 tools atuais;
- `review/submission-checklist.md` — gates externos e passos do portal;
- `review/demo-account.md` — preparação da conta/dados de review.

Arquivos gerados e inputs reais ficam ignorados:

- `dist/`;
- `release-config.json`;
- `release-readiness.json`.

## Build

Copie o exemplo para um arquivo não versionado:

```powershell
Copy-Item release-config.example.json release-config.json
```

Substitua **todos** os valores por URLs/identidade/assets finais. O exemplo usa hosts reservados para garantir que não possa ser enviado acidentalmente.

Execute:

```powershell
py -3 scripts/build_package.py --release-config release-config.json
```

Saída esperada:

```text
dist/telechir-plugin.zip
```

O ZIP contém somente:

```text
plugin.json
mcp.json
assets/logo.svg|png
assets/composer-icon.svg|png
```

Reviewer credentials nunca entram no ZIP. Devem ser preenchidas apenas no campo seguro do portal OpenAI.

## Validações fail-closed

O builder recusa:

- campos externos obrigatórios ausentes;
- HTTP, localhost, hosts reservados ou IP privado;
- credentials embutidas em URL;
- MCP fora do path canônico `/mcp`;
- campos inesperados e secret-like;
- assets que não sejam PNG/SVG;
- asset não quadrado ou fora de 48–4096 px;
- SVG com script, event handler ou referência ativa/externa;
- contagem diferente de 5 positive + 3 negative review cases;
- starter prompt com `@mention`, duplicado ou acima do limite;
- metadata fora dos limites públicos documentados.

O builder não testa reachability, publisher ownership ou revisão OpenAI. Esses são gates externos.

## Testes

```powershell
py -3 -m unittest discover -s tests -v
```

O package não contém skill, hook, `.app.json` ou UI MCP na Phase 11. O Dashboard web do Telechir é uma superfície separada e não é empacotado como plugin UI.
