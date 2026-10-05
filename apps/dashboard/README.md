# Telechir Dashboard

Dashboard MVP da Phase 10, implementado em React + TypeScript e projetado como cliente do control plane. Ele não acessa o agent diretamente e não possui caminho privilegiado para contornar policy, approval ou audit.

## Escopo

A interface apresenta:

- devices ativos, presença online/offline, OS, arquitetura, versão e último contato;
- resumo de uso com tool calls, concluídos, falhas, latência média e bytes de artifacts;
- sessões e command/process timeline;
- inbox de approvals;
- audit timeline;
- revogação de device.

Web terminal, screen viewer, policy editor, browser/computer-use e qualquer shell irrestrito permanecem fora da Phase 10.

## Autenticação

O Dashboard usa o mesmo resource server OAuth do control plane. O MVP não implementa authorization server nem browser login próprio; em desenvolvimento, o usuário informa um access token já emitido.

O token:

- fica apenas em `sessionStorage`;
- é enviado somente no header `Authorization: Bearer`;
- não aparece novamente na UI;
- não é persistido no D1, audit ou telemetria do Dashboard.

Scopes da Phase 10:

- `telechir:dashboard:read` — leitura do overview;
- `telechir:approvals:decide` — APPROVE/DENY;
- `telechir:devices:revoke` — revogação.

Um bearer válido sem o scope requerido recebe `403`.

## API consumida

- `GET /dashboard/api/overview`
- `POST /dashboard/api/approvals/:approvalId/decision`
- `POST /dashboard/api/devices/:deviceId/revoke`

Todas as rotas são autenticadas e ownership-scoped no Worker.

A resposta de approval é minimizada. Não expõe `user_id`, `argument_digest`, argumentos brutos, bearer tokens ou secrets.

Decisões de approval reutilizam o `DeviceCoordinator` e o `GovernanceService` implementados na Phase 9. Revogação reutiliza `revokeDeviceAndCloseRealtime`, invalidando device/key/pairing e fechando a conexão realtime.

## Desenvolvimento local

O Vite faz proxy de `/dashboard/api` para o Worker local em `http://127.0.0.1:8787`.

```bash
npm install
npm run dev
```

Gates:

```bash
npm run format:check
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

No fluxo de validação do repositório, dependências e build são executados em volume Docker para evitar `node_modules` no filesystem de trabalho do Windows.

## Segurança

- approval expirado, já decidido ou consumido é rejeitado antes do dispatch;
- double-submit não deve duplicar side effects;
- IDs pertencentes a outro usuário resultam em `404`, sem revelar existência;
- revoke exige confirmação explícita na UI e `confirm: true` na API;
- o Dashboard não envia `approval_id`, digest ou risk escolhido pelo browser como autoridade;
- a policy local do agent continua sendo o teto de autoridade;
- o audit exibido é a metadata já minimizada/redigida persistida pelo control plane.

Consulte `../../docs/security/threat-model/phase10-dashboard-2026-10-05.md`.
