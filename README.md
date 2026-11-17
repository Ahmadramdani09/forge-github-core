# forge-github-core

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Ahmadramdani09/forge-github-core/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Ahmadramdani09/forge-github-core/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node.js process, standard
library only — no git binary, no dependencies, no network. One in-memory store
serves git smart HTTP (protocol v2 and v0, with shallow fetch), the REST v3
API, a GraphQL v4 endpoint with a hand-written engine, and an MCP endpoint.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=... node main.ts
```

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: protocol v2 advertisements,
  `ls-refs`, `fetch` (with shallow/deepen support) and protocol v0
  `receive-pack` with report-status. Packfiles are parsed and written by hand
  (delta application included) on `node:zlib` and `node:crypto`.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents,
  labels, issues, comments and pull requests, including squash merges with
  three-way conflict detection.
- **GraphQL v4** at `/api/graphql`: a small real GraphQL engine (lexer,
  parser, executor) covering the documents `gh` and `github-mcp-server` send —
  viewer, repository, node lookups, introspection of the core types, issue and
  pull-request connections with cursor pagination, and the create/close/merge
  mutations.
- **MCP** at `/mcp`: JSON-RPC over streamable HTTP, both the 2026-07-28
  revision (`server/discover`) and the handshake revisions (`initialize`),
  with six tools that act on the same store as REST.

## Running notes

The process is the entrypoint of an agent/v1 trial: it binds an ephemeral
port, registers it with the env at `$MAKEFUN_ENV_URL`, and serves until the
env reports done.

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`. The
token's repositories live in one namespace; the first owner segment that
addresses an existing repository becomes the token's login, and any other
owner reads as a stranger (404).

State is deterministic: a logical clock (a fixed epoch plus a counter) stamps
every `created_at` and every commit this forge authors, so replaying the same
request sequence produces the same bytes.

## Layout

- `main.ts` — the env lifecycle (register, serve, exit on done).
- `app.ts` — the HTTP server: auth, routing, protocol plumbing.
- `src/gitobj.ts` — the git object model: hashing, trees, commits, packfiles.
- `src/smart.ts` — smart HTTP: advertisements, ls-refs, fetch, receive-pack.
- `src/store.ts` — forge state and the shared domain operations (issues,
  pull requests, squash merge).
- `src/rest.ts` — the REST v3 surface.
- `src/graphql.ts` — the GraphQL engine and the v4 surface.
- `src/mcp.ts` — the MCP endpoint and its tools.

MIT licensed (see `LICENSE`).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
