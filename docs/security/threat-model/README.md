# Threat Model — Conjunto de Trabalho

**Status:** baseline formalizado na Phase 0.

Famílias de ameaça já identificadas:

1. roubo de token OAuth/conta;
2. comprometimento da chave do dispositivo;
3. phishing e replay de pairing;
4. sequestro/replay de sessão;
5. clientes de IA maliciosos ou superprivilegiados;
6. path traversal e escape por symlink/reparse point;
7. acesso a arquivos sensíveis;
8. operações destrutivas de filesystem;
9. comandos shell codificados/ofuscados;
10. privilege escalation;
11. exaustão de processos/recursos;
12. risco de instalação de dependências e supply chain;
13. exfiltração de rede;
14. prompt injection por arquivos, terminal output, páginas, screenshots ou clipboard;
15. múltiplas IAs sobrescrevendo o mesmo workspace;
16. execução duplicada após retries/reconnects;
17. approvals vencidos;
18. comprometimento do control plane;
19. auto-update malicioso;
20. vazamento de secrets em logs/artefatos.

A conversão formal foi concluída em `stride-baseline-2026-10-02.md`, com ativos, trust boundaries, STRIDE, controles e 40 abuse cases. O modelo deve ser reaberto à medida que novas capacidades forem implementadas.

## Deltas por capability

- `phase9-policy-approvals-audit-2026-10-05.md` — revalida AB-024, AB-025, AB-029, AB-031, AB-032 e AB-034 após a implementação de policy, approvals e audit.
