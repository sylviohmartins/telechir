# Phase 15 — Revalidação de Durable Objects para concorrência de workspace

**Data:** 2026-10-08
**Escopo:** coordenação durável de mutações por workspace no control plane Telechir.

## Pergunta

A Phase 15 precisa impedir duas mutações concorrentes no mesmo workspace sem bloquear reads, outros workspaces ou outros devices. O estado de coordenação também precisa sobreviver a reconnect, eviction e restart do Durable Object.

## Fontes oficiais revalidadas

1. Cloudflare — Rules of Durable Objects
   https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
2. Cloudflare — Access Durable Objects Storage
   https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
3. Cloudflare — SQLite-backed Durable Object Storage
   https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

As páginas foram revalidadas em 2026-10-08.

## Conclusões aplicadas

A documentação atual recomenda modelar Durable Objects em torno da unidade lógica que precisa de coordenação e strong consistency. O Telechir mantém um DeviceCoordinator por device e usa chaves independentes por workspace dentro dele.

Leases e fencing não dependem de memória do processo. O coordinator persiste o lease atual e o último fencing token por workspace em Durable Object Storage para sobreviver a eviction/restart.

Acquire/renew usa state.storage.transaction para read-modify-write atômico. Renew do mesmo command preserva o fencing token; nova aquisição após release/expiry incrementa o token.

blockConcurrencyWhile não é usado como mutex geral. Isso preserva paralelismo entre workspaces independentes.

O lease tem expires_at bounded pelo deadline relevante e é reavaliado no próximo acquire/renew. A Phase 15 não adiciona scheduler nem alarm.

## Decisão

- ownership durável em D1;
- coordination lease/fencing em Durable Object Storage;
- exclusão exclusiva somente para side effects do mesmo workspace;
- reads sem lease exclusivo;
- fencing monotônico;
- reconnect sem replay automático;
- approval, idempotency e lease como mecanismos separados.

## Fora do escopo

- scheduler distribuído;
- filas persistentes por workspace;
- CRDT/merge automático;
- distributed transactions entre devices;
- Phase 16 / certification multi-IA.
