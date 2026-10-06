# Authorization, Risk and Approvals

**Status:** baseline Phase 0 + evolução compatível até Phase 13

## 1. Invariante

> A policy local do device define o teto. Nenhuma policy cloud, scope OAuth, approval remoto ou instrução do modelo pode ampliar esse teto.

## 2. Permission domains

\`\`\`text
FS_READ
FS_WRITE
FS_DELETE
SHELL_SAFE
SHELL_FULL
PROCESS_CONTROL
NETWORK
GIT_WRITE
GIT_REMOTE_WRITE
SCREEN_READ
INPUT_CONTROL
BROWSER
SECRET_USE
ELEVATION
ADMIN
\`\`\`

A superfície implementada usa principalmente:
- FS_READ
- FS_WRITE
- SHELL_SAFE/SHELL_FULL
- PROCESS_CONTROL
- NETWORK como domínio explicitamente negado quando não autorizado
- Git read sem permission de write específica
- SCREEN_READ para captura one-shot da Phase 13
- INPUT_CONTROL para uma única ação tipada de computer use na Phase 13

## 3. Decisão

Uma avaliação retorna:
- \`ALLOW\`
- \`ASK\`
- \`DENY\`

## 4. Precedência

\`\`\`text
hard deny local
> local device policy
> local workspace rule
> cloud account/workspace restriction
> temporary session grant
> OAuth/client requested scope
\`\`\`

Camadas inferiores só restringem.

## 5. Risk levels

### LOW
Leitura/diagnóstico bounded.

Exemplos:
- list files;
- read source file não sensível;
- git status;
- system metrics.

### MEDIUM
Mudanças locais/reversíveis ou processos controlados.

Exemplos:
- patch em source autorizado;
- build/test;
- cancelar processo do Telechir.

### HIGH
Impacto remoto, amplo ou persistente.

Exemplos:
- package install;
- network write;
- futura criação de commit;
- alteração extensa;
- captura de tela da Phase 13, por envolver conteúdo visual potencialmente sensível.

### CRITICAL
Privilégio, destruição ampla ou alteração sistêmica.

Exemplos:
- elevation;
- mass delete;
- disk/system configuration;
- credential store manipulation;
- input sintético de mouse/teclado da Phase 13, porque pode disparar side effects em aplicações locais ou externas.

CRITICAL = local confirmation obrigatória ou DENY por default.

## 6. Approval object

Approval deve ser vinculado a:
- \`approval_id\`;
- \`device_id\`;
- \`session_id\`;
- actor/client;
- permission domains;
- canonical target;
- digest dos argumentos normalizados;
- risk;
- decision;
- scope;
- \`expires_at\`.

Scopes:
- \`once\`;
- \`session\`;
- futuramente \`rule\` via alteração explícita de policy.

Approval não pode ser reutilizado para payload diferente.

## 7. Approval lifecycle

\`\`\`text
REQUESTED
 -> APPROVED -> CONSUMED
 -> DENIED
 -> EXPIRED
\`\`\`

\`once\` é consumido atomicamente.

## 8. Local vs remote approval

- LOW pode ser auto-allow conforme policy.
- MEDIUM pode usar approval no host remoto/ChatGPT quando local policy autorizar esse mecanismo.
- HIGH requer confirmation mais explícita e TTL curto.
- CRITICAL é local-only por default.

Um approval exibido pela plataforma de IA não substitui o approval do Telechir quando a local policy exige ambos.

### Phase 13 — computer use

`screen.capture`:
- exige exatamente `SCREEN_READ`;
- risco local mínimo HIGH;
- pode seguir o approval Telechir bounded/TTL já existente;
- imagem é untrusted data e não é copiada para audit metadata.

`computer.input`:
- exige exatamente `INPUT_CONTROL`;
- risco local mínimo CRITICAL;
- não aceita `approval_id` remoto como substituto;
- exige confirmação humana local no device imediatamente antes do efeito;
- confirmation binding inclui session, argument digest e TTL de 30 segundos;
- mudança de action/coordinates/key/text altera o digest e invalida o binding;
- se o prompt local não puder ser exibido, expirar ou for negado, o efeito não ocorre.

O prompt local mostra apenas resumo bounded da ação e digest. Conteúdo de `type_text` não é exibido no prompt, reduzindo exposição e spoofing por texto não confiável.

## 9. Risk engine

Não depender só de regex.

Sinais futuros:
- executable/interpreter;
- args;
- path targets;
- redirections;
- command chaining;
- package manager;
- network destination;
- environment/secret use;
- privilege intent;
- operation blast radius.

O classifier pode elevar risco; nunca reduzir abaixo de hard rules.

## 10. Prompt injection

Conteúdo vindo de:
- arquivo;
- terminal;
- browser;
- screenshot;
- clipboard

é marcado conceitualmente como **untrusted data**. Esse conteúdo não altera permission scopes nem policy.

## 11. Secret references

Inputs podem transportar identificadores como \`secret://...\`, nunca o valor secreto.

O agent resolve localmente somente quando:
- tool possui permission adequada;
- secret policy permite;
- target process/operation está autorizado.

## 12. Audit

Registrar:
- decision;
- rule/policy revision;
- risk;
- approval ID quando existir;
- normalized target;
- result.

Não registrar secret value ou conteúdo completo de arquivo por default.

Na Phase 13 também não registrar:
- bytes/base64 da screenshot;
- texto completo de `type_text`;
- raw input payload em audit metadata;
- conteúdo visual inferido da captura.
