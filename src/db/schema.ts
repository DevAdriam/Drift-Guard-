import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  ColumnCatalogRow,
  DatabaseHealthSummary,
  IncidentDetails,
  IndexBloatRow,
  LockTreeRow,
  MigrationFinding,
} from '../types/telemetry.ts';

export const users = pgTable('users', {
  uid: text('uid').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const monitoredDatabases = pgTable(
  'monitored_databases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    environment: varchar('environment', { length: 20 }).notNull(),
    connectionMode: varchar('connection_mode', { length: 20 })
      .default('external')
      .notNull(),
    connectionUrlEncrypted: text('connection_url_encrypted').notNull(),
    maskedTarget: varchar('masked_target', { length: 160 }).notNull(),
    pollIntervalSeconds: integer('poll_interval_seconds').default(60).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    lastSchemaHash: varchar('last_schema_hash', { length: 64 }),
    lastHealthStatus: varchar('last_health_status', { length: 20 })
      .default('PENDING')
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_monitored_databases_owner').on(table.ownerUid)]
);

export const schemaBaselines = pgTable(
  'schema_baselines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    databaseId: uuid('database_id')
      .notNull()
      .references(() => monitoredDatabases.id, { onDelete: 'cascade' }),
    gitCommitSha: varchar('git_commit_sha', { length: 40 }),
    schemaHash: varchar('schema_hash', { length: 64 }).notNull(),
    tablesJson: jsonb('tables_json').$type<ColumnCatalogRow[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_schema_baselines_db').on(table.databaseId, table.createdAt)]
);

export const telemetryIncidents = pgTable(
  'telemetry_incidents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    databaseId: uuid('database_id')
      .notNull()
      .references(() => monitoredDatabases.id, { onDelete: 'cascade' }),
    incidentType: varchar('incident_type', { length: 30 }).notNull(),
    severity: varchar('severity', { length: 10 }).notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    details: jsonb('details').$type<IncidentDetails>().notNull(),
    status: varchar('status', { length: 15 }).default('OPEN').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_incidents_lookup').on(table.databaseId, table.fingerprint, table.status),
  ]
);

export const telemetrySnapshots = pgTable(
  'telemetry_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    databaseId: uuid('database_id')
      .notNull()
      .references(() => monitoredDatabases.id, { onDelete: 'cascade' }),
    schemaHash: varchar('schema_hash', { length: 64 }).notNull(),
    tableCount: integer('table_count').notNull(),
    columnCount: integer('column_count').notNull(),
    activeLocksCount: integer('active_locks_count').default(0).notNull(),
    bloatedIndexesCount: integer('bloated_indexes_count').default(0).notNull(),
    catalogJson: jsonb('catalog_json').$type<ColumnCatalogRow[]>().notNull(),
    locksJson: jsonb('locks_json').$type<LockTreeRow[]>().notNull(),
    bloatJson: jsonb('bloat_json').$type<IndexBloatRow[]>().notNull(),
    healthJson: jsonb('health_json').$type<DatabaseHealthSummary | null>(),
    durationMs: integer('duration_ms').default(0).notNull(),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_snapshots_db_time').on(table.databaseId, table.inspectedAt),
  ]
);

export const alertWebhooks = pgTable(
  'alert_webhooks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    provider: varchar('provider', { length: 20 }).notNull(),
    webhookUrlEncrypted: text('webhook_url_encrypted').notNull(),
    maskedUrl: varchar('masked_url', { length: 160 }).notNull(),
    minSeverity: varchar('min_severity', { length: 10 }).default('WARNING').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_alert_webhooks_owner').on(table.ownerUid)]
);

export const workspaceSettings = pgTable('workspace_settings', {
  ownerUid: text('owner_uid')
    .primaryKey()
    .references(() => users.uid, { onDelete: 'cascade' }),
  lockThresholdSeconds: integer('lock_threshold_seconds').default(15).notNull(),
  bloatMbThreshold: integer('bloat_mb_threshold').default(50).notNull(),
  bloatPctThreshold: integer('bloat_pct_threshold').default(40).notNull(),
  deadTuplePctThreshold: integer('dead_tuple_pct_threshold').default(20).notNull(),
  cacheHitMinPct: integer('cache_hit_min_pct').default(95).notNull(),
  connSaturationPct: integer('conn_saturation_pct').default(80).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const migrationChecks = pgTable(
  'migration_checks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    databaseId: uuid('database_id').references(() => monitoredDatabases.id, {
      onDelete: 'set null',
    }),
    title: varchar('title', { length: 120 }).notNull(),
    sqlText: text('sql_text').notNull(),
    riskLevel: varchar('risk_level', { length: 15 }).notNull(),
    findingsJson: jsonb('findings_json').$type<MigrationFinding[]>().notNull(),
    wrappedSafeSql: text('wrapped_safe_sql').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_migration_checks_owner').on(table.ownerUid, table.createdAt)]
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_api_keys_owner').on(table.ownerUid)]
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    actorEmail: text('actor_email').notNull(),
    action: varchar('action', { length: 64 }).notNull(),
    entityType: varchar('entity_type', { length: 32 }).notNull(),
    entityLabel: varchar('entity_label', { length: 128 }).notNull(),
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_audit_logs_owner').on(table.ownerUid, table.createdAt)]
);

export const queryLatencySamples = pgTable(
  'query_latency_samples',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    databaseId: uuid('database_id').references(() => monitoredDatabases.id, {
      onDelete: 'cascade',
    }),
    queryId: varchar('query_id', { length: 64 }).notNull(),
    queryPreview: text('query_preview').notNull(),
    calls: integer('calls').default(0).notNull(),
    meanExecTimeMs: doublePrecision('mean_exec_time_ms').notNull(),
    maxExecTimeMs: doublePrecision('max_exec_time_ms').default(0).notNull(),
    cacheHitPct: doublePrecision('cache_hit_pct').default(100).notNull(),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_query_latency_owner_db_time').on(
      table.ownerUid,
      table.databaseId,
      table.sampledAt
    ),
  ]
);

export const targetHealthThresholds = pgTable(
  'target_health_thresholds',
  {
    databaseId: uuid('database_id')
      .primaryKey()
      .references(() => monitoredDatabases.id, { onDelete: 'cascade' }),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    enabled: boolean('enabled').default(false).notNull(),
    minHealthScore: integer('min_health_score').default(80).notNull(),
    cooldownMinutes: integer('cooldown_minutes').default(10).notNull(),
    lastEvaluatedScore: integer('last_evaluated_score'),
    lastBreachAt: timestamp('last_breach_at', { withTimezone: true }),
    lastAutoReinspectAt: timestamp('last_auto_reinspect_at', {
      withTimezone: true,
    }),
    autoReinspectCount: integer('auto_reinspect_count').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('idx_target_health_thresholds_owner').on(table.ownerUid)]
);

export const maintenanceWindows = pgTable(
  'maintenance_windows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    databaseId: uuid('database_id').references(() => monitoredDatabases.id, {
      onDelete: 'cascade',
    }),
    environment: varchar('environment', { length: 20 }).default('all').notNull(),
    title: varchar('title', { length: 120 }).notNull(),
    dayOfWeek: integer('day_of_week').default(-1).notNull(), // -1 = daily, 0 = Sun .. 6 = Sat (UTC)
    startTimeUtc: varchar('start_time_utc', { length: 5 }).notNull(), // "HH:MM"
    durationMinutes: integer('duration_minutes').default(60).notNull(),
    suppressWebhooks: boolean('suppress_webhooks').default(true).notNull(),
    suppressAutoReinspect: boolean('suppress_auto_reinspect')
      .default(true)
      .notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('idx_maintenance_windows_owner').on(table.ownerUid)]
);

export const teamMembers = pgTable(
  'team_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    email: varchar('email', { length: 180 }).notNull(),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    role: varchar('role', { length: 16 }).default('viewer').notNull(), // admin | dba | viewer
    status: varchar('status', { length: 16 }).default('active').notNull(), // active | invited
    invitedBy: text('invited_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('idx_team_members_owner').on(table.ownerUid)]
);

export const baselineApprovalRequests = pgTable(
  'baseline_approval_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUid: text('owner_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    databaseId: uuid('database_id')
      .notNull()
      .references(() => monitoredDatabases.id, { onDelete: 'cascade' }),
    requestedByEmail: text('requested_by_email').notNull(),
    gitCommitSha: varchar('git_commit_sha', { length: 40 }),
    proposedSchemaHash: varchar('proposed_schema_hash', { length: 64 }).notNull(),
    proposedCatalogJson: jsonb('proposed_catalog_json')
      .$type<ColumnCatalogRow[]>()
      .notNull(),
    diffSummary: text('diff_summary').notNull(),
    status: varchar('status', { length: 16 }).default('PENDING').notNull(), // PENDING | APPROVED | REJECTED
    reviewedByEmail: text('reviewed_by_email'),
    reviewNote: text('review_note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_baseline_approvals_owner').on(table.ownerUid, table.createdAt),
  ]
);

export const usersRelations = relations(users, ({ many, one }) => ({
  databases: many(monitoredDatabases),
  webhooks: many(alertWebhooks),
  migrationChecks: many(migrationChecks),
  apiKeys: many(apiKeys),
  auditLogs: many(auditLogs),
  maintenanceWindows: many(maintenanceWindows),
  teamMembers: many(teamMembers),
  baselineApprovalRequests: many(baselineApprovalRequests),
  settings: one(workspaceSettings),
}));

export const monitoredDatabasesRelations = relations(
  monitoredDatabases,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [monitoredDatabases.ownerUid],
      references: [users.uid],
    }),
    baselines: many(schemaBaselines),
    incidents: many(telemetryIncidents),
    snapshots: many(telemetrySnapshots),
    healthThreshold: one(targetHealthThresholds),
  })
);

export const schemaBaselinesRelations = relations(schemaBaselines, ({ one }) => ({
  database: one(monitoredDatabases, {
    fields: [schemaBaselines.databaseId],
    references: [monitoredDatabases.id],
  }),
}));

export const telemetryIncidentsRelations = relations(telemetryIncidents, ({ one }) => ({
  database: one(monitoredDatabases, {
    fields: [telemetryIncidents.databaseId],
    references: [monitoredDatabases.id],
  }),
}));

export const telemetrySnapshotsRelations = relations(telemetrySnapshots, ({ one }) => ({
  database: one(monitoredDatabases, {
    fields: [telemetrySnapshots.databaseId],
    references: [monitoredDatabases.id],
  }),
}));

export const alertWebhooksRelations = relations(alertWebhooks, ({ one }) => ({
  owner: one(users, {
    fields: [alertWebhooks.ownerUid],
    references: [users.uid],
  }),
}));

// Extension-managed views from pg_stat_statements — marked existing so Drizzle Kit preserves them
export const pgStatStatementsView = pgView('pg_stat_statements', {}).existing();
export const pgStatStatementsInfoView = pgView(
  'pg_stat_statements_info',
  {}
).existing();
