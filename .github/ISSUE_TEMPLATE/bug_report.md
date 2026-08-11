---
name: Bug report
about: The indexer or API behaves incorrectly
title: ''
labels: bug
assignees: ''
---

<!--
SECURITY: if this is an exploitable vulnerability, do NOT open a public issue.
Use GitHub's private vulnerability reporting on this repo instead. See CONTRIBUTING.md.
-->

## What happened

<!-- Actual behavior. Include the error, stack trace, or wrong response body. -->

## What you expected

## Reproduction

<!-- Exact steps. For an API bug, the request. For an indexer bug, the on-chain event or sequence involved. -->

```bash

```

## Which part

- [ ] API (`src/api`)
- [ ] Indexer (`src/indexer`)
- [ ] Event decoding (`src/stellar/events.ts`)
- [ ] Database / schema (`src/db`)
- [ ] Not sure

## Environment

- Node version:
- Postgres version:
- Network (testnet / local / other):
- `CONTRACT_ID`:
- Commit or tag:

## Impact

<!-- Is data wrong, missing, or duplicated? Does the indexer recover on restart, or stay broken? -->
