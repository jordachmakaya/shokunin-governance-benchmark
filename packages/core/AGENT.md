# AGENT — Governance Core Authority (ZB1)

## 1. Scope & Ownership
- **Owner**: Gemini
- **Box ID**: ZB1
- **Root**: `packages/core`
- **Responsibilities**:
  - Implement `ICompletionGate` adhering strictly to `packages/core/contracts/gate.contract.ts`.
  - Provide pure execution decision mechanisms without coupling to specific execution engines.
  - Implement parsing and validation conforming to `packages/core/schemas/gate-result.schema.ts`.
  - Provide unit tests and fakes demonstrating contract substitutability and actionable error handling.

## 2. Boundaries & Restrictions
- **Write Boundary**: You may ONLY write within `packages/core/**`.
- **Read Boundary**: Allowed to read `packages/core/**`, `docs/**`, and root configuration files.
- Do NOT edit root configuration files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.base.json`).
- Do NOT edit other boxes (`packages/benchmark-kit`, `packages/evals`, etc.).
- Do NOT import from private source directories of neighboring packages (`../benchmark-kit/src/**`).
- Do NOT introduce explicit `any`.
- Do NOT alter public contracts without initiating an explicit contract migration protocol.

## 3. Local Verification & Definition of Done
To consider work on ZB1 complete (DONE):
1. `npx tsc -p packages/core/tsconfig.json --noEmit` passes with 0 errors.
2. `npm test` inside `packages/core` runs and passes 100% of unit tests.
3. `pnpm test` at repository root passes (`foundation:check`, `hooks:test`, `typecheck`).
4. Zero unhandled promise rejections or unbounded memory/process hangs.
