-- Seed the deterministic trusted source used by the Agent skills acceptance fixture.
INSERT INTO "AgentSkillSource" (
    "id",
    "sourceType",
    "label",
    "registryKey",
    "gitUrl",
    "isTrusted",
    "createdAt",
    "updatedAt"
)
VALUES (
    'builtin-registry',
    'registry',
    'Built-in Registry',
    'builtin',
    NULL,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO UPDATE SET
    "sourceType" = EXCLUDED."sourceType",
    "label" = EXCLUDED."label",
    "registryKey" = EXCLUDED."registryKey",
    "gitUrl" = EXCLUDED."gitUrl",
    "isTrusted" = EXCLUDED."isTrusted",
    "updatedAt" = CURRENT_TIMESTAMP;
