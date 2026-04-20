# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Artifacts

- **Expiry Scan App** (`artifacts/expiry-scan-app`, preview `/`): React + Vite web app for retail expiry scanning. Includes setup by PD user/store/date, local barcode master spreadsheet upload/persistence, scan entry, metrics, session table, wrong-scan delete, clear-all session cleanup, and formatted Excel export with clean date columns.
- **API Server** (`artifacts/api-server`, preview `/api`): Express API backing the Expiry Scan App.
- **Canvas** (`artifacts/mockup-sandbox`, preview `/__mockup`): design preview sandbox.

## Data Model

- `expiry_scans` table stores scan rows with session context, barcode/item details, quantity, expiry/scan dates, calculated status, days left, action required, remarks, and creation timestamp. API list/summary responses and the web UI recalculate status/days-left from the current date so expiry urgency changes as dates get closer, including while the app remains open past midnight.
- Barcode master files are intentionally stored in the browser locally after upload, mirroring the original upload-once workflow without requiring server-side file storage.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/expiry-scan-app run dev` — run the Expiry Scan App locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
