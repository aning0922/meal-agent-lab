# Stage 09P-M2 R7-A-r6 evidence

状态：实现与验证证据，提交 fresh review；不是 formal admission 或 CLEAN 判定。

## Provenance / scope

- repo HEAD: `8a69bc2435e1b7ebb3667d6bbea39ef5dffe81b8`
- repo tree: `bfa8d2901e099982de5f0f9ec218fb4562ac7839`
- repo parent: `0734aa885cb12ffce86a014c8c3dc58cf06d4ed5`
- tracked files: `426`
- repo worktree: no status entries
- r5 source: `/private/tmp/meal-agent-r7a-r5.mAIndD/contracts`
- r6 candidate: `/private/tmp/meal-agent-r7a-r6.9CetDE/contracts`
- frozen design: `/private/tmp/meal-agent-r7a-r6-design.AreKTt/R7-A-r6-design.md`
- design SHA-256: `179b4b7066e6bc82d3d99518abe595c6348bb6f26c23b248bc6df2182351e825`
- r5 was rehashed after implementation; its 11 controlled hashes still exactly match the pre-copy list.
- r5 -> r6, excluding `dist` and `node_modules`: exactly nine expected paths (one new internal registry plus eight modified source/test paths).
- No repo, r1-r5, R7-B or R7-C edit; no dependency install or network access.

## Implemented closure

- Six public replay input/checkpoint/result exports are their scoped binding's exact schema object and carry exact root metadata.
- Parser successes use `DeepReadonly<T>` and descriptor-only recursive freeze; cycles reject atomically and shared aliases retain identity.
- Both domains accept one strict empty `only` request (`events: []`, all counts zero, null tip/final digest), one server-verified finalized-empty checkpoint, and the existing finalized result branch.
- A descriptor-only pre-Zod graph guard closes Zod's own-`__proto__` erasure behavior at input/checkpoint/result and standalone caller-claim boundaries, including nested fields and the near-1MiB empty-envelope counterexample.
- Root holds only the legacy registry. Inventory V2 and Seasoning V1 each own a closure-local registry exposed only by the existing package subpath.

Exact registry counts:

| scope | manifest | schema bindings | bound IDs |
| --- | ---: | ---: | ---: |
| root legacy | 35 | 34 | 35 |
| Inventory V2 | 15 | 15 | 15 |
| Seasoning V1 | 11 | 11 | 11 |
| aggregate unique | 61 | 60 | 61 |

## Verification

- Node `24.x`, TypeScript `5.9.3`, `tsc -p tsconfig.json --noEmit`: exit `0`.
- `node --import tsx --test tests/*.test.ts`: `72/72` pass.
- `tsc -p tsconfig.build.json`: exit `0`.
- Independent in-memory build audit: `16` source files -> `64` outputs, diagnostics `0`, `emitSkipped=false`, existing `dist` exact `64/64` with no missing/extra artifact.
- External temporary consumer: strict `NodeNext`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `skipLibCheck:false`, actual package exports and built declarations: exit `0`; all deep-readonly and root-M2 absence `@ts-expect-error` assertions consumed.
- Actual package runtime smoke: root `35/34/35`, Inventory `15/15`, Seasoning `11/11`, binding identity and frozen empty parser results pass.
- Actual package fresh-process import-order smoke: `7/7` orders pass.
- Root-only loader denies `inventory-v2.js` and `seasoning-v1.js` independently; root import still passes `35/34/35`, proving the M2 modules are not loaded then hidden.
- Frozen-candidate read-only audits found no remaining reproducible blocker/P1/P2 in A-D; these audits explicitly do not constitute formal admission.

Preserved limits/version:

- package and contract version: `0.4.0`
- raw wire cap: `1,048,576` UTF-8 bytes
- logical history cap: `10,000`
- Inventory events/chunk: `17`
- Seasoning events/chunk: `388`

## Final controlled SHA-256

```text
792a5dcd485c70aec5c68c6d1d8897dff23b4944a44afdeea175be2476e98304  package.json
88834d798c0ba890993873c722c674d5543ab25775b6127eaab1912fe8ed95bd  src/contract-rule-registry.ts
75a575bd5a31f62c445b63e37c45c2273afce831a7af8abc9d89023a750c276d  src/contract-rule-schema.ts
ee0e3a11d8b0177a3de9c5c4961f3025d0b9267053b67cfa6268dd0528836fce  src/inventory-v2.ts
e5b5513348b4e422e511f754030706aafb7bb765f0ad40d2056f7d9e24229c59  src/seasoning-v1.ts
5d5fae06d5c4f6786b1f4c085ecab94f65891d107d9f294a15716148e453e7d4  src/stage09p-input.ts
38b2021a36e0ce07a56fdac2c2b04ae858ff776639ca2e46c64b463afe886b5d  src/refinement-rules.ts
e82c33434dd5d803ec328e62f1afc49308bf671a33f290e85a57916038a86530  src/refinement-bindings.ts
c916528bb9c4644f43bd51abbe83e6babee9ba459f15a9281a33b26cdbf9bbd4  src/index.ts
5e7eff58103bdfcd0ebdabc451862175c80aebaf09a4c5d1b2067828dc99cffc  src/primitives.ts
848d08655ea39db4a773009eb8fb99d5cc2b97ff178f5220137eb141b4c7d534  tests/refinement-rules.test.ts
a4dab36a48a888ba5164878d1a96f19949177a2dfbe337dd2ab004ae3e8bad11  tests/stage09p-contracts.test.ts
```

## Deliberately remaining outside R7-A-r6

Cross-request checkpoint authentication, persisted replay prevention, gap/order enforcement across requests, final-after rejection and atomic persistence remain R7-B responsibilities. Request-stream enforcement before string materialization remains R7-C.
