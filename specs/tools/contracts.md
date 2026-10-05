# Tool Request/Result Contracts — MVP

**Contract version:** \`0.1\`

Tipos abaixo são contratos conceituais independentes de linguagem. Na implementação MCP, os schemas devem ser emitidos em JSON Schema 2020-12.

## Convenções

- strings de ID são opacas;
- paths são enviados como strings e normalizados no agent;
- timestamps são RFC 3339 UTC;
- \`null\` é diferente de campo ausente;
- resultados grandes retornam \`artifact_id\`;
- errors seguem \`../protocol/error.schema.json\`;
- nenhum result inclui token, private key, raw environment ou trace interno.

## list_devices

### Request

| Campo | Tipo | Obrigatório | Regra |
|---|---|---:|---|
| \`status\` | enum | não | \`online\\|offline\\|all\`; default \`all\` |

### Result

\`devices[]\`:
- \`device_id: string\`
- \`name: string\`
- \`status: online|offline\`
- \`os: string\`
- \`arch: string\`
- \`agent_version: string\`
- \`last_seen: timestamp|null\`

Ordem determinística por nome e \`device_id\`.

## get_device

Request:
- \`device_id: string\` obrigatório.

Result:
- identificação pública do device;
- status;
- OS/arch;
- agent version;
- \`capabilities: string[]\`;
- \`last_seen\`;
- resumo não sensível da policy.

## list_files

Request:
- \`device_id: string\`;
- \`path: string\`;
- \`cursor?: string\`;
- \`limit?: integer\`, 1–500, default 100.

Result:
- \`path\` canonicalizado para apresentação;
- \`entries[]\`: \`name\`, \`path\`, \`kind=file|directory|link|other\`, \`size?\`, \`modified_at?\`;
- \`next_cursor?: string|null\`.

## get_file_metadata

Request:
- \`device_id\`;
- \`path\`;
- \`include_hash?: boolean\`, default true.

Result:
- \`path\`;
- \`kind\`;
- \`size\`;
- \`modified_at?\`;
- \`sha256?\`.

## read_file

Request:
- \`device_id\`;
- \`path\`;
- \`offset?: integer >= 0\`, default 0;
- \`max_bytes?: integer\`, 1–262144, default 131072;
- \`encoding?: utf-8|base64\`, default \`utf-8\`.

Result:
- \`path\`;
- \`content\`;
- \`encoding\`;
- \`offset\`;
- \`next_offset?: integer|null\`;
- \`truncated: boolean\`;
- \`sha256?: string|null\`.

## write_file

Request:
- \`device_id\`;
- \`path\`;
- \`content\`;
- \`encoding?: utf-8|base64\`;
- \`expected_hash?: string|null\`;
- \`create_if_missing?: boolean\`, default true.

Result:
- \`path\`;
- \`bytes_written\`;
- \`sha256\`;
- \`created: boolean\`.

Semântica:
- \`expected_hash\` diferente do estado atual → \`CONFLICT\`;
- overwrite é operação destructive;
- agent usa escrita atômica quando o SO/FS permitir.

## patch_file

Request:
- \`device_id\`;
- \`path\`;
- \`patch: string\`;
- \`expected_hash: string\`;
- \`format: unified_diff\`.

Result:
- \`path\`;
- \`sha256\`;
- \`changed: boolean\`;
- \`summary: string\`.

Falha de contexto/precondition → \`CONFLICT\`. Alteração parcial não deve permanecer.

## search_files

Request:
- \`device_id\`;
- \`root\`;
- \`query\`;
- \`mode?: text|regex|glob\`, default \`text\`;
- \`max_results?: 1..1000\`, default 100.

Result:
- \`matches[]\`: \`path\`, \`line?\`, \`snippet?\`;
- \`truncated: boolean\`.

## run_command

Uso: comandos curtos. Processos longos usam \`start_process\`.

Request:
- \`device_id\`;
- \`command: string\`;
- \`cwd?: string|null\`;
- \`timeout_seconds?: integer\`, 1–120, default 30;
- \`env_refs?: string[]\`, máximo 20 referências de secret/config — nunca valores secretos;
- \`execution_mode?: guarded_host|sandbox\`, default \`guarded_host\`.

Result:
- \`exit_code: integer|null\`;
- \`stdout: string\`;
- \`stderr: string\`;
- \`truncated: boolean\`;
- \`artifact_id?: string|null\`;
- \`execution_mode?: guarded_host|sandbox\`.

\`guarded_host\` preserva as regras SHELL_SAFE existentes. \`sandbox\` é opt-in e só pode ser despachado quando o device anuncia \`sandbox.docker\`; ausência de runtime nunca faz fallback para host. O comando continua passando por risk classification, policy e approval local.

## start_process

Request:
- \`device_id\`;
- \`command\`;
- \`cwd?: string|null\`;
- \`idempotency_key: string\`;
- \`env_refs?: string[]\`;
- \`execution_mode?: guarded_host|sandbox\`, default \`guarded_host\`.

Result:
- \`process_id: string\`;
- \`state: starting|running\`;
- \`started_at: timestamp\`;
- \`execution_mode?: guarded_host|sandbox\`.

Mesmo \`idempotency_key\` + mesmo command digest deve retornar o handle conhecido enquanto a janela de idempotência existir. Como \`execution_mode\` participa dos argumentos normalizados, trocar de modo produz digest distinto e não reutiliza approval/idempotency de forma silenciosa.

## read_process_output

Request:
- \`device_id\`;
- \`process_id\`;
- \`cursor?: string|null\`;
- \`max_bytes?: 1..262144\`, default 65536.

Result:
- \`process_id\`;
- \`state: starting|running|exited|failed|cancelled\`;
- \`stdout\`;
- \`stderr\`;
- \`next_cursor?: string|null\`;
- \`exit_code?: integer|null\`;
- \`truncated: boolean\`;
- \`artifact_id?: string|null\`;
- \`execution_mode?: guarded_host|sandbox\`.

## write_process_input

Request:
- \`device_id\`;
- \`process_id\`;
- \`input: string\`;
- \`append_newline?: boolean\`.

Result:
- \`accepted: boolean\`.

Payload precisa de hard size limit na implementação. O input pode causar side effects e passa por policy. Para processos sandbox, stdin continua atravessando somente o processo Docker gerenciado correspondente.

## cancel_process

Request:
- \`device_id\`;
- \`process_id\`;
- \`force?: boolean\`, default false.

Result:
- \`process_id\`;
- \`state: cancelling|cancelled|already_finished\`;
- \`execution_mode?: guarded_host|sandbox\`.

É idempotente. No modo sandbox, o caminho normal de cancelamento exige cleanup do container antes de reportar sucesso; falha de cleanup não é convertida em sucesso silencioso.

## list_managed_processes

Request:
- \`device_id\`;
- filtro opcional de \`state\`.

Result:
- \`processes[]\`: \`process_id\`, \`state\`, \`started_at\`, \`cwd?\`, \`execution_mode?\`.

Não retorna environment completo, nome interno do container nem lista arbitrária de processos do SO.

## get_git_status

Request:
- \`device_id\`;
- \`repository_path\`.

Result:
- \`branch?: string|null\`;
- \`ahead: integer\`;
- \`behind: integer\`;
- \`files[]\`: \`path\`, \`status\`.

Read-only; não executa hooks nem altera index.

## get_git_diff

Request:
- \`device_id\`;
- \`repository_path\`;
- \`staged?: boolean\`;
- \`path?: string|null\`;
- \`max_bytes?: integer\`, máximo inline 262144.

Result:
- \`diff: string\`;
- \`truncated: boolean\`;
- \`artifact_id?: string|null\`.

## get_system_metrics

Request:
- \`device_id\`.

Result:
- \`cpu_percent\`;
- \`memory\`: total/used/available coarse-grained;
- \`disks[]\`: mount label não sensível, total/used/available;
- \`agent_uptime_seconds\`.

Não inclui process args, env, usernames ou inventory detalhado.

## get_artifact

Request:
- \`artifact_id\`.

Result:
- \`artifact_id\`;
- \`file_name?: string|null\`;
- \`mime_type?: string|null\`;
- \`size\`;
- \`sha256\`;
- \`download_url?: string|null\`;
- \`expires_at?: timestamp|null\`.

Acesso temporário é scoped à identidade/sessão e auditado.

## MCP annotations

O catálogo estruturado está em \`tool-catalog.json\`.

Regras:
- reads: \`readOnlyHint=true\`, \`destructiveHint=false\`;
- overwrite/patch/cancel/process input: \`destructiveHint=true\`;
- shell/process capazes de alcançar rede: \`openWorldHint=true\`;
- annotations não alteram autorização.

## Out of scope do catálogo MVP

Não existem public tools MVP para:
- delete recursivo;
- Git commit/push/pull/merge/rebase;
- privilege elevation;
- mouse/keyboard;
- browser;
- Docker/Kubernetes;
- SSH fleet.
