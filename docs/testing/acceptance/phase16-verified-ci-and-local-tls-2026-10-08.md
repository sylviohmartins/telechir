# Phase 16 — GitHub Actions verificado e preflight de TLS local

Data: 2026-10-08
Issue: #49
Classificação: evidência reproduzível; **não certifica** hosts de IA externos.

## GitHub Actions: sucesso comprovado

Inspeção via API de GitHub Actions, não inferida do YAML:

| Execução | Evento | SHA de origem | Conclusão | Link |
|---|---|---|---|---|
| 37843796029 | `pull_request` | `44c4fa8685aa529c1d2e4b0aecbf6ff64bccd723` | **success** | https://github.com/sylviohmartins/telechir/actions/runs/37843796029 |
| 37843837500 | `push` | `7a1aab4283f0255d59adb5c8fd87cfbb0a110e7e` | **success** | https://github.com/sylviohmartins/telechir/actions/runs/37843837500 |

Job `Control-plane protocol and security regressions`: checkout, Node.js 24, npm ci, prettier, TypeScript, npm test, Wrangler dry-run e audit: **todos os steps success** nas duas execuções. O conector de consultas por commit inicialmente retornou vazio; consulta direta `GET /repos/sylviohmartins/telechir/actions/runs` e busca de jobs por ID confirmaram as execuções. A ausência na consulta especializada não representa falha/inatividade do CI.

## Smoke TLS local — resultado negativo **válido**

Ambiente Windows PREDATORH300. Worker de desenvolvimento em porta loopback 8987, `--local-protocol https`, certificado X.509 sintético gerado por OpenSSL para `localhost` (1 dia), nenhuma autorização real ou servidor publicado.

O certificado esperado e a conexão observada tinham fingerprints SHA-256 distintos:

- Certificado esperado: `B5:FB:31:1C:10:9C:27:F7:44:D3:A9:4D:7D:5E:FB:6B:68:CB:9F:23:DC:8F:AA:48:D4:E5:A5:AA:07:91:A3:C8`.
- Certificado realmente apresentado pelo peer: `BC:F1:97:7C:A2:EC:D7:10:83:86:2F:49:C7:C8:9A:A1:8A:4D:CF:5C:30:05:79:D5:C6:CE:AF:07:23:6B:FA:21`.
- Emissor: `Avast Web/Mail Shield Self-signed Root`, organização `Avast Web/Mail Shield`. O programa local de proteção interceptou o handshake de loopback.
- `curl.exe --cacert` retornou `60` (verificação TLS falhou); `Node fetch` com `NODE_EXTRA_CA_CERTS` e até `--use-system-ca` também falhou com `unable to verify the first certificate`. **Nenhum bypass de TLS foi utilizado.**

`node scripts/interop/verify-local-tls.mjs --cert <PUBLIC_CERTIFICATE> --host localhost --port 8987`:
- saída `FAIL/TLS_CERTIFICATE_SUBSTITUTED`, exit **2** (negativo esperado), **sem enviar dados HTTP ou bearer**;
- `node --test scripts/interop/verify-local-tls.test.mjs`: **3/3 PASS**, incluindo rejeição de hosts não-loopback, parâmetros malformados e fingerprint diferente.
- O preflight impede iniciar o cliente externo contra um certificado substituído, mesmo que o certificado intermediário seja eventualmente reconhecido pelo sistema.
- Resultado da integração com **MCP Inspector real**: `BLOCKED_LOCAL_TLS_INTERCEPTION`, **não** PASS. Não foram testados `tools/list` ou OAuth via Inspector sob esse ambiente.

## Uso do gate (documentação operacional)

1. Subir Worker de desenvolvimento somente em `localhost` por HTTPS, com `MCP_RESOURCE_URI` e `OAUTH_ISSUER` de homologação. Nunca reutilizar dispositivo/IdP de produção.
2. Usar um certificado de teste local e reter a **chave privada fora do Git**. Ela não é necessária ao script de validação.
3. Executar `node scripts/interop/verify-local-tls.mjs --cert caminho/public-cert.pem --host localhost --port 8987`. O status precisa ser `PASS/TLS_PIN_AND_CHAIN_VALIDATED` antes de abrir qualquer cliente externo, mesmo sem bearer.
4. Se `TLS_CERTIFICATE_SUBSTITUTED`, investigar interceptação de TLS / máquina de homologação alternativa com governança aprovada. **Não** contornar com `NODE_TLS_REJECT_UNAUTHORIZED=0`, `--insecure` ou desligar indiscriminadamente antivírus.
5. Só depois de TLS verificado e com autenticação sintética usar o cliente MCP Inspector CLI para `tools/list` (`--stored-auth-only` evita OAuth interativo), capturar versão, contagem de tools e erros. Nenhum token deve aparecer em logs.
6. Comparar resultado por era de protocolo (`--protocol-era legacy` e `modern`) e registrar separadamente sessões reais dos produtos fornecedores.

Referências técnicas:
- https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli
- https://developers.cloudflare.com/workers/wrangler/commands/workers/

## Resultado do gate

- CI **PASS verificado** (PR e push).
- Testes de protocolo in-process **PASS**.
- Preflight externo TLS **FAIL esperado** por certificado substituído; esse bloqueio foi detectado e mantido sem rebaixar segurança.
- `PHASE_16_IN_PROGRESS` e #49 aberta; clientes externos e IdP continuam pendentes.
