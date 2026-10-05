# Discovery de Segurança

Segurança é uma capability do produto, não uma etapa posterior de hardening.

Direção atual:

- policy local do dispositivo deve ser a autoridade final;
- permissões usam semântica explícita allow / ask / deny;
- operações perigosas exigem aprovação mais forte ou permanecem negadas;
- autorização de filesystem deve operar sobre paths resolvidos/canônicos;
- identidade do dispositivo, revogação e sessões curtas são preocupações de primeira classe;
- host, guarded-host e sandbox são modos de segurança distintos;
- secrets devem ser referenciados/injetados sem expor valores desnecessariamente ao modelo.

O threat model foi formalizado na Phase 0 em `threat-model/stride-baseline-2026-10-02.md` e é atualizado incrementalmente por capability. O delta da Phase 9 está em `threat-model/phase9-policy-approvals-audit-2026-10-05.md`.
