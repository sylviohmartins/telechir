# Phase 16 — Threat model de interoperabilidade de clientes MCP

**Data:** 2026-10-08
**Issue:** #49
**Estado:** complemento dos threat models anteriores; nenhuma nova authority proposta.

## Ativos e trust boundaries

Clients de IA são externos ao security boundary Telechir. Textos, tool arguments, headers, schemas interpretados por clients e ações solicitadas pelo modelo não definem authority. O servidor valida OAuth audience/issuer/expiry/scope e ownership; control plane é restritivo; o Local Agent aplica a policy definitiva. Device Wire, approval, idempotency, lease/fencing e confirmação local CRITICAL continuam independentes.

## Ameaças específicas e controles exigidos

| Cenário | Risco | Controle/prova |
|---|---|---|
| Cliente com versão MCP legada | Desvio de schema e autorização | Handler legacy explícito; wire tests modernos/legados; nunca desativar auth |
| Cliente omite/ignora annotations | Execução de write tratada como read | `readOnlyHint` apenas informativo; scope/risk/LocalPolicy são obrigatórios |
| Cliente reusa token expirado/revogado | Acesso indevido | 401/403 e resource metadata; validator server-side; teste negativo |
| Cliente seleciona device/workspace de terceiro | Confusão de ownership | D1 resolve user+device+workspace, rejeição fail-closed |
| Múltiplos modelos fazem write simultâneo | Perda de dados/race | AB-028 lease exclusivo, preconditions, fencing monotônico |
| Reconnect/retentativa de cliente | Replay de efeito aceito | AB-029 accepted não replayado, idempotência vinculada |
| Provedores divergem em aprovação de ferramentas | Bypass de confirmação | Approval no Telechir, `computer.input` requer confirmação humana local CRITICAL |
| Conteúdo da ferramenta gera prompt injection | Mudança indevida de instruções | `untrusted` e audit minimizado; nunca interpretar output como policy |
| Headers Origin/Host manipulados | DNS rebinding/host confusion | Comparar origin com `resourceUri` configurado; 403/421 |
| Cliente tenta forçar sandbox→host | Escape da intenção do usuário | `execution_mode` no digest/binding, fail-closed, nenhum downgrade |
| Scanner de plugin sem OAuth real | Certificação enganosa | Separar `PASS` de SDK/wire e `BLOCKED` de cliente real |
| Servidor expõe muitos tools | UX/latência/tool truncation | Assert conjunto de 24 e schemas bounded; registrar limitação por cliente |

## Testes negativos e política de divulgação

Não usar conta pessoal, screenshot de usuário nem browser profile como fixture de certificação. Não registrar bearer tokens, outputs brutos ou dumps com informações privadas em relatório, issue ou PR. Endpoint e IdP de homologação requerem gates separados; nenhuma automação de implantação pública nesta fase.

## Riscos residuais

Configuração e comportamento do host MCP podem mudar entre versões; nem todo client suporta o mesmo transporte, esquema de login ou tool content types. Sem teste real por versão, não afirmar compatibilidade; manutenção da matriz de suporte é trabalho recorrente de release.
