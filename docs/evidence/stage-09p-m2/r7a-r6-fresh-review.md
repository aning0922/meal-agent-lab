R7-A-r6 CLEAN

# Stage 09P-M2 R7-A-r6 Fresh Review

## Verdict

- P0: 0
- P1: 0
- P2: 0
- Scope meaning: this is only a CLEAN Fresh Review of the frozen R7-A-r6
  contracts candidate. It is not M2 admission, does not change M1's
  `LIMITED_TECHNICAL_ACCEPTANCE_WITH_EXCEPTIONS`, and does not authorize R7-B,
  R7-C, or writes to the real repository.

## A — public schema binding: CLEAN

The Inventory and Seasoning input, server checkpoint, and result schemas are
each the exact final public export referenced by their scoped binding (`===`).
Each of the six root metadata objects has exactly its own rule ID, boundary,
and rule description. Identity rules out a later wrapper/clone/union changing
the binding acceptance set.

Raw input and standalone caller-claim schemas reject `server_verified`.
Checkpoint/result schemas independently validate server authority. Finalized
empty checkpoints are accepted only by `finalized` results; an
`accepted_chunk` carrying a finalized checkpoint is rejected.

Counts and exact sets:

```text
legacy root     35 manifest / 34 schemas / 35 bound IDs
Inventory V2    15 manifest / 15 schemas / 15 bound IDs
Seasoning V1    11 manifest / 11 schemas / 11 bound IDs
aggregate       61 unique rules / 60 unique boundaries / 61 unique bound IDs
```

## B — deep readonly/freeze: CLEAN

Both raw parsers return `DeepReadonly<DTO>` on success. A recursive descriptor
walk over successful nonempty and empty parses proved every reachable ordinary
data node frozen, including events, event objects, payloads, bindings and prior
caller claims. Root, array, event, payload, binding and claim mutations throw.

Independent attacks confirmed shared aliases preserve identity and freeze;
cycles, accessors, symbol keys and exotic prototypes reject atomically; getters
are not read. Own `__proto__` is rejected at the pre-Zod boundary, does not
pollute `Object.prototype`, and the freezer itself handles an own data property
without invoking the prototype setter. A strict external NodeNext consumer with
`skipLibCheck:false` compiled with all 9 `@ts-expect-error` assertions consumed,
including deep readonly and root M2 absence.

## C — strict empty history: CLEAN

Both public raw parsers accept the exact empty-only request:

```text
only, ordinal 1, start 1, end 0, events [], all four counts 0,
null previous/terminal/final digest, null prior claim
```

Both server checkpoints close to
`server_verified/finalized`, next ordinal 2, processed 0, next sequence 1,
declared total 0 and null terminal/history digest. Only the finalized result
branch accepts them. The caller claim vocabulary remains nonempty and cannot
acquire server authority.

For each domain the audit rejected 15 input near-misses and 8 checkpoint
near-misses, extra fields, root/nested own `__proto__`, duplicate keys,
noncanonical number/string tokens and a near-1 MiB erased-field attempt. The
raw decoder accepted the exact 1,048,576-byte boundary (without wire-cap
rejection) and rejected B+1 with the exact capacity reason.

The independent 10,000-event composition passed in 589 Inventory chunks
(17/chunk, final remainder 4) and 26 Seasoning chunks (388/chunk, final
remainder 300). The retained C0 proof gives maximum valid event sizes 59,225
and 2,693 bytes, with maximal valid chunks 1,007,382 and 1,029,112 bytes.

## D — root isolation/import order: CLEAN

Root has no M2 value/type exports, rule IDs or schema objects; the legacy
binding module has no M2 imports. Seven fresh-process orders all retained root
35/34/35:

```text
root
inventory > root
seasoning > root
root > inventory
root > seasoning
inventory > seasoning > root
seasoning > inventory > root
```

Independent resolve loaders denied Inventory, Seasoning, and both M2 module
paths. Root still imported and returned 35/34/35, proving it does not load M2
and then hide it. Source inspection found closure-local registries only; no
global registry, prefix filter, cleanup, or snapshot-timing dependency.

## Verification matrix

All successful commands below used Node 24.18.0 and existing dependencies; no
dependency installation or network access occurred.

| Command | Result |
| --- | --- |
| `node root-audit/audit.mjs` | exit 0; 12,080 assertions |
| `node audit-a-d/audit-a-d.mjs` | exit 0; 26/26 |
| `node audit-b/deep-freeze-audit.mjs` | exit 0; 24/24 |
| `node audit-c/audit-c.mjs` | exit 0; 120/120 |
| `node redteam/crosscut.mjs` | exit 0; 48 checks on fresh rerun |
| `tsc -p tsconfig.json --noEmit` in frozen candidate | exit 0 |
| `node --import tsx --test tests/*.test.ts` in frozen candidate | exit 0; 72 pass, 0 fail/skip/todo |
| `tsc -p tsconfig.build.json --listEmittedFiles` in temporary copy | exit 0; 64 outputs |
| `diff -qr frozen/dist temporary-build/dist` | exit 0; 64/64 byte-identical |
| strict external NodeNext consumer | exit 0; 9/9 `@ts-expect-error` consumed |
| actual package export import smoke | exit 0; 10/10 export entries |
| M2 Node-only dependency scan | exit 0 wrapper; zero matches |
| root/type M2 static scan | exit 0 wrapper; zero matches |
| r5 prior audit rerun | exit 0; independently reconfirmed retained resource/canonical behavior and the four old r5 blockers |
| `shasum -a 256 -c` on r6 controlled list | exit 0; 12/12 OK |

The native pnpm path was not counted as a product check. In the default login
environment Node 20.20.1 made pnpm itself/test startup fail on missing
`node:sqlite`. With Node 24 selected, both `pnpm run typecheck` and
`pnpm run test` detected that the shared `node_modules` had been prepared by a
different pnpm version and aborted with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` before changing it. The exact
underlying candidate commands (`tsc` and Node+tsx) then passed directly.

The 72 candidate tests include canonical JSON, C0 maximal-wire proof, event
capacity B/B+1, 10,000-event composition, Inventory date provenance,
date-correction closure, PgInt, UTC years 0001–9999, decision correlation,
representative no-throw inputs, rule/binding coverage and nominal IDs. There
are no skip/todo/only tests and no `@ts-ignore`/`@ts-nocheck` directives.

## Hashes, diff scope and non-modification proof

- Repository before/after: clean; HEAD
  `8a69bc2435e1b7ebb3667d6bbea39ef5dffe81b8`; tree
  `bfa8d2901e099982de5f0f9ec218fb4562ac7839`; parent
  `0734aa885cb12ffce86a014c8c3dc58cf06d4ed5`; 426 tracked files.
- Frozen r6: 90-file before/final lists compare equal. Whole-content aggregate
  remained `3b925d4de11ab0601dbe919b3cbbbf19963db4512d2a0b238ee669e213315131`;
  size/mtime aggregate remained
  `364104988c041dec3f4aa2f8d863cf2677432241283e22d3babbb6351a929b82`.
- Frozen r5: 85-file whole-content aggregate at review start and finish remained
  `96f106d9ecea1ceda9453473d451066f64047645bc9d3def593d83e67776684f`.
  Its current 11 controlled values are recorded in
  `audit-a-d/r5-current-controlled-11.sha256`; the supplied r5 verification
  artifacts do not contain a separate historical expected-value list, so the
  audit does not overclaim comparison to an unavailable pre-copy manifest.
- All 12 r6 controlled values exactly match `R7-A-r6-evidence.md`.
- Design SHA-256:
  `179b4b7066e6bc82d3d99518abe595c6348bb6f26c23b248bc6df2182351e825`.
- Evidence SHA-256:
  `d9c2b1e41bd87ca9236c5a41c6f29a1350713d304852ba83463152afc996f339`.
- r5 -> r6 excluding `dist` and `node_modules` is exactly 9 paths: new
  `src/contract-rule-registry.ts`; modified `src/contract-rule-schema.ts`,
  `src/inventory-v2.ts`, `src/refinement-bindings.ts`,
  `src/refinement-rules.ts`, `src/seasoning-v1.ts`, `src/stage09p-input.ts`,
  `tests/refinement-rules.test.ts`, and `tests/stage09p-contracts.test.ts`.
  There are no extra paths. Rebuilt `dist` is exact.

Primary script SHA-256:
`8534afcd738e8728ecc1a9a24466f3f460d8a0f054636a53878d04b6ea1724d7`.

Supporting script SHA-256 values:

```text
3d1b31d1825c6f6739bfe85e20f3d0b448cb8c6266658d2b03faf2f6147335d3  audit-a-d.mjs
287ca3f00aa9df1aa060a142df26eac01616710b919fdf4dd6b05f3b8734acc8  deep-freeze-audit.mjs
1b87ddaf4cd42372178a6f4f496c478d76d72562a7c441f77efb6d2d156a40af  audit-c.mjs
79a898e5fc68821b6ca8fa4611a7bc3d405ee32db6a1013d72bcc6625bf374b7  crosscut.mjs
```

## Residual risks / outside scope

- R7-B: cross-request checkpoint authentication, persisted replay prevention,
  gap/order enforcement across requests, final-after rejection and atomic
  persistence.
- R7-C: request-stream byte enforcement before string materialization,
  content-type/route integration, timeout and concurrency controls.
- No DB, API, client, migration, OpenAPI generation, real data/source,
  credential, network, R7-B/R7-C, or repository integration work was reviewed
  or authorized here.
- The freezer is correctly scoped to fresh Zod-owned ordinary DTO data; it is
  not an arbitrary Proxy/class-instance sanitizer.
