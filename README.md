# Vault RIM Lifecycle Tool

A web tool where a user logs in with their Veeva Vault credentials, finds a
RIM object record, and changes its lifecycle state by executing one of the
lifecycle user actions Vault reports as available for that record.

## How it works

- **Login** — the user enters a username and password. The Vault DNS is fixed
  server-side. The backend calls Vault's `/auth` endpoint, stores the returned
  `sessionId` server-side, and looks up the user's security profile to decide
  admin access. The browser only ever holds an opaque, httpOnly session cookie.
- **Smart search** — three modes:
  - *Quick*: a term matched across any text fields you tick (loaded from the
    object's metadata).
  - *Advanced filters*: a field/operator/value builder (`=`, `!=`, `CONTAINS`,
    `STARTSWITH`, `>`, `<`, `>=`, `<=`) AND-joined into a VQL `WHERE` clause.
  - *Global*: one term searched across several objects at once.
  - *Ask (AI)*: a plain-English question is translated to a Vault query by the
    Roche Galileo LLM. The model returns a constrained JSON spec (object + term
    + filters), which is validated against live metadata and compiled to VQL.
    RIM often has several objects for one concept (e.g. `registration__v`,
    `registration__rim`, `medicinal_product_registration__v`); if the model's
    pick returns no rows, the tool automatically probes sibling objects sharing
    the same keyword and shows the first that actually has records.
- **Change lifecycle state** — the backend lists the record's available actions
  (`GET /vobjects/{object}/{id}/actions`) and initiates the chosen one
  (`POST .../actions/{name}`). Only transitions Vault permits are offered.
- **Edit metadata (admin)** — loads all editable fields, lets the user change
  any of them (e.g. Planned Submission Date, Actual Outcome Date, Local
  Disposition), shows a from→to preview, then saves via `PUT /vobjects/...`.
- **Delete (admin)** — two modes:
  - *Hard delete*: walks inbound relationships to build a bottom-up deletion
    plan (children before parents, avoiding orphans), previews it, requires the
    user to type the record name, then deletes each record in order.
  - *Soft delete*: runs a lifecycle action (e.g. Cancel/Inactivate) instead of
    destroying anything.

## Admin gating

Metadata edit and delete are restricted to admins. A user is treated as admin
when their Vault security profile is one of `business_admin__v`,
`vault_owner__v`, `system_admin__v`, or any profile listed in the
`VAULT_ADMIN_PROFILES` env var (comma-separated). The check runs server-side at
login and is enforced on the destructive routes, not just hidden in the UI.

## Project layout

```
.
├── server/          Express API + Vault client (Node, ESM)
│   └── src/
│       ├── index.js         app entry, middleware, static hosting
│       ├── routes.js        auth + record routes
│       ├── vaultClient.js   Veeva Vault REST API wrapper
│       ├── sessionStore.js  in-memory cookie→session map
│       └── *.test.js        node:test unit tests
└── client/          Vite + React UI
    └── src/
        ├── App.jsx
        ├── api.js
        └── components/{Login,RecordWorkspace}.jsx
```

## Prerequisites

- Node.js 20+
- Access to a Veeva Vault instance (a sandbox is recommended for testing)

## Setup

```bash
npm install
cp server/.env.example server/.env   # adjust if needed
```

## Run (development)

Starts the Express API (port 3001) and the Vite dev server (port 5173) together.
The Vite dev server proxies `/api` to the backend.

```bash
npm run dev
```

Open the Vite URL and sign in with your Vault DNS, username, and password.

## Run individually

```bash
npm run dev:server   # API only
npm run dev:client   # UI only
```

## Production build

```bash
npm run build        # builds the client into client/dist
npm start            # serves the API and the built client from port 3001
```

## Tests

```bash
npm test             # runs the server unit tests (node:test)
```

The tests stub `fetch`, so they run without a live Vault connection. They cover
URL normalization, Vault success/failure handling, authentication, VQL queries,
and lifecycle action listing/execution.

## Configuration

Server environment variables (`server/.env`):

| Variable            | Default                  | Purpose                                  |
| ------------------- | ------------------------ | ---------------------------------------- |
| `PORT`              | `3001`                   | API port                                 |
| `CLIENT_ORIGIN`     | `http://localhost:5173`  | Allowed CORS origin (the dev UI)         |
| `VAULT_API_VERSION` | `v24.1`                  | Veeva Vault REST API version             |
| `SESSION_TTL_MS`    | `1800000`                | Server-side session lifetime (30 min)    |

## Security notes

- Vault session IDs are held server-side only; the browser gets an opaque
  httpOnly cookie.
- Sessions are stored in memory. For a multi-instance deployment, replace
  `sessionStore.js` with a shared store (e.g. Redis).
- Always run behind HTTPS in production so the session cookie is sent securely
  (`secure` is enabled automatically when `NODE_ENV=production`).
