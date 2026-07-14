# Agent skills QA fixture

This fixture exercises the Agent skills configuration and state-machine flow.
It does **not** download, resolve, or parse a real registry package. The current
registry validator accepts a non-empty version and records the requested skill
in the Agent workspace; real registry package resolution remains outside this
fixture.

## Deterministic source

`prisma migrate deploy` seeds this trusted source idempotently:

| Field | Value |
| --- | --- |
| `sourceId` | `builtin-registry` |
| `sourceType` | `registry` |
| `registryKey` | `builtin` |
| `label` | `Built-in Registry` |
| `isTrusted` | `true` |

The fixture is available after the migration
`20260714030000_seed_builtin_skill_source` has been applied. Operators must not
manually insert the source row or expose source-registration credentials.

## Main acceptance sequence

Set placeholders locally without committing credentials:

```bash
export BACKEND_URL=https://home.gfun.vip:8323
export ADMIN_TOKEN=<admin-jwt>
export AGENT_ID=<qa-agent-id>
```

Install `qa-smoke-skill` version `1.0.0`:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"skillName":"qa-smoke-skill","sourceId":"builtin-registry","sourceType":"registry","version":"1.0.0"}' \
  "${BACKEND_URL}/agents/${AGENT_ID}/skills/install"
```

Update it to `1.0.1`:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"skillName":"qa-smoke-skill","sourceId":"builtin-registry","sourceType":"registry","version":"1.0.1"}' \
  "${BACKEND_URL}/agents/${AGENT_ID}/skills/update"
```

Remove it:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"skillName":"qa-smoke-skill"}' \
  "${BACKEND_URL}/agents/${AGENT_ID}/skills/remove"
```

For every response, assert:

- `changeStatus=succeeded`
- `reloadStatus=pending_restart`
- `auditStatus=audit_written`
- `rollbackResult=not_required`
- `effectiveFor=next_task`
- `previousConfigVersion`, `stagedConfigVersion`, and `activeConfigVersion`
  reflect the workspace snapshot transition

After install and update, `GET /agents/${AGENT_ID}/skills` must show the
requested version and `sourceId=builtin-registry`. After remove, the same entry
is retained for auditability with `enabled=false`. Each returned `changeId` can
also be verified through
`GET /agents/${AGENT_ID}/skills/changes/${CHANGE_ID}`.

## Protected reload failure checks

Run these only on a dedicated test deployment. The gate requires both:

```text
NODE_ENV=test
HOMELAB_ENABLE_SKILL_RELOAD_TEST_MODE=true
```

Restart that test backend with one of these modes before repeating a mutation:

- `HOMELAB_SKILL_RELOAD_MODE=runtime_offline` returns
  `reloadStatus=runtime_offline` without rollback.
- `HOMELAB_SKILL_RELOAD_MODE=failed` triggers reload failure and must return
  `changeStatus=rolled_back`, `reloadStatus=failed`,
  `rollbackResult=succeeded`, and `failedStage=reload`.
- Unset `HOMELAB_SKILL_RELOAD_MODE` to restore the default
  `reloadStatus=pending_restart` behavior.

Production must keep `NODE_ENV=production`; the reload mode is ignored unless
both test gates are enabled. This hotfix does not add a request-level failure
injection API. `rollback_failed`, `concurrency_lock`, and audit-finalize failure
remain covered by the backend service/interface regression suite.
