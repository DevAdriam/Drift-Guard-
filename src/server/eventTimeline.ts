import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  auditLogs,
  migrationChecks,
  monitoredDatabases,
  schemaBaselines,
  telemetryIncidents,
  telemetrySnapshots,
} from '../db/schema.ts';
import { SchemaInspector } from './inspector.ts';
import type {
  DatabaseTimelineEvent,
  DatabaseTimelineResponse,
  EnvironmentType,
  IncidentDetails,
  IndexBloatDetails,
  LockContentionDetails,
  SchemaDriftDetails,
  VacuumHealthDetails,
} from '../types/telemetry.ts';

function extractRemediationSql(details: IncidentDetails): string | null {
  if ('remediation_sql' in details && typeof details.remediation_sql === 'string') {
    return details.remediation_sql;
  }
  return null;
}

function buildIncidentMeta(
  incidentType: string,
  details: IncidentDetails
): { label: string; value: string; mono?: boolean }[] {
  const meta: { label: string; value: string; mono?: boolean }[] = [];

  if (incidentType === 'SCHEMA_DRIFT') {
    const d = details as SchemaDriftDetails;
    if (d.baseline_hash) {
      meta.push({
        label: 'Baseline Hash',
        value: d.baseline_hash.slice(0, 12),
        mono: true,
      });
    }
    if (d.live_hash) {
      meta.push({
        label: 'Live Hash',
        value: d.live_hash.slice(0, 12),
        mono: true,
      });
    }
    meta.push({
      label: 'Column Changes',
      value: `+${d.added_count ?? 0} added · -${d.removed_count ?? 0} removed · ~${d.modified_count ?? 0} modified`,
      mono: true,
    });
    if (d.diffs?.length) {
      const preview = d.diffs
        .slice(0, 3)
        .map((c) => `${c.kind === 'ADDED' ? '+' : c.kind === 'REMOVED' ? '-' : '~'} ${c.table_name}.${c.column_name}`)
        .join(', ');
      meta.push({
        label: 'Affected Columns',
        value: d.diffs.length > 3 ? `${preview} (+${d.diffs.length - 3} more)` : preview,
        mono: true,
      });
    }
  } else if (incidentType === 'LOCK_CONTENTION') {
    const d = details as LockContentionDetails;
    meta.push({
      label: 'Blocking → Blocked PID',
      value: `${d.blocking_pid} (${d.blocking_user}) → ${d.blocked_pid} (${d.blocked_user})`,
      mono: true,
    });
    meta.push({
      label: 'Wait Duration',
      value: d.wait_duration_display || `${d.wait_duration_seconds}s`,
      mono: true,
    });
  } else if (incidentType === 'INDEX_BLOAT') {
    const d = details as IndexBloatDetails;
    meta.push({
      label: 'Index',
      value: `${d.schemaname}.${d.indexname}`,
      mono: true,
    });
    meta.push({
      label: 'Size & Est. Bloat',
      value: `${d.index_size_pretty} · ${Number(d.estimated_bloat_pct ?? 0).toFixed(1)}% bloat`,
      mono: true,
    });
  } else if (incidentType === 'VACUUM_HEALTH') {
    const d = details as VacuumHealthDetails;
    meta.push({
      label: 'Table',
      value: `${d.schemaname}.${d.relname}`,
      mono: true,
    });
    meta.push({
      label: 'Dead Tuples',
      value: `${Number(d.n_dead_tup ?? 0).toLocaleString()} (${Number(d.dead_tuple_pct ?? 0).toFixed(1)}%)`,
      mono: true,
    });
  } else if (incidentType === 'CONNECTION_SATURATION' && 'connection_usage_pct' in details) {
    meta.push({
      label: 'Pool Saturation',
      value: `${details.active_connections} / ${details.max_connections} (${details.connection_usage_pct}%)`,
      mono: true,
    });
    meta.push({
      label: 'Idle in Transaction',
      value: String(details.idle_in_transaction),
      mono: true,
    });
  }

  return meta;
}

function mapIncidentTab(
  incidentType: string
): DatabaseTimelineEvent['targetTab'] {
  switch (incidentType) {
    case 'SCHEMA_DRIFT':
      return 'diff';
    case 'LOCK_CONTENTION':
      return 'locks';
    case 'INDEX_BLOAT':
      return 'bloat';
    case 'VACUUM_HEALTH':
    case 'CONNECTION_SATURATION':
      return 'health';
    default:
      return 'diff';
  }
}

function formatIncidentTypeLabel(incidentType: string): string {
  switch (incidentType) {
    case 'SCHEMA_DRIFT':
      return 'Schema Drift Alert';
    case 'LOCK_CONTENTION':
      return 'Lock Contention Alert';
    case 'INDEX_BLOAT':
      return 'Index Bloat Alert';
    case 'VACUUM_HEALTH':
      return 'Vacuum Health Alert';
    case 'CONNECTION_SATURATION':
      return 'Connection Saturation Alert';
    default:
      return incidentType.replace(/_/g, ' ');
  }
}

export async function getDatabaseEventTimeline(
  ownerUid: string,
  databaseId: string
): Promise<DatabaseTimelineResponse> {
  const targetRows = await db
    .select()
    .from(monitoredDatabases)
    .where(
      and(
        eq(monitoredDatabases.id, databaseId),
        eq(monitoredDatabases.ownerUid, ownerUid)
      )
    )
    .limit(1);

  if (!targetRows.length) {
    throw new Error('Target database not found.');
  }

  const target = targetRows[0];

  const [baselinesAsc, snapshotsAsc, incidentsDesc, auditsDesc, migrationsDesc] =
    await Promise.all([
      db
        .select()
        .from(schemaBaselines)
        .where(eq(schemaBaselines.databaseId, target.id))
        .orderBy(asc(schemaBaselines.createdAt))
        .limit(50),
      db
        .select()
        .from(telemetrySnapshots)
        .where(eq(telemetrySnapshots.databaseId, target.id))
        .orderBy(asc(telemetrySnapshots.inspectedAt))
        .limit(60),
      db
        .select()
        .from(telemetryIncidents)
        .where(eq(telemetryIncidents.databaseId, target.id))
        .orderBy(desc(telemetryIncidents.createdAt))
        .limit(60),
      db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.ownerUid, ownerUid),
            eq(auditLogs.entityLabel, target.name)
          )
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(80),
      db
        .select()
        .from(migrationChecks)
        .where(
          and(
            eq(migrationChecks.ownerUid, ownerUid),
            eq(migrationChecks.databaseId, target.id)
          )
        )
        .orderBy(desc(migrationChecks.createdAt))
        .limit(20),
    ]);

  // Index audit logs by action to enrich actor emails on matching events
  const usedAuditIds = new Set<string>();
  const findMatchingAudit = (
    actions: string[],
    targetTimeMs: number,
    windowMs = 10_000
  ) => {
    let best: (typeof auditsDesc)[number] | null = null;
    let bestDelta = Infinity;
    for (const log of auditsDesc) {
      if (usedAuditIds.has(log.id)) continue;
      if (!actions.includes(log.action)) continue;
      const delta = Math.abs(log.createdAt.getTime() - targetTimeMs);
      if (delta <= windowMs && delta < bestDelta) {
        best = log;
        bestDelta = delta;
      }
    }
    if (best) usedAuditIds.add(best.id);
    return best;
  };

  const events: DatabaseTimelineEvent[] = [];

  // 1. Schema Baselines (Schema Changes)
  for (let i = 0; i < baselinesAsc.length; i += 1) {
    const b = baselinesAsc[i];
    const prev = i > 0 ? baselinesAsc[i - 1] : null;
    const matchedAudit = findMatchingAudit(
      ['BASELINE_PROMOTED', 'BASELINE_RESTORED'],
      b.createdAt.getTime()
    );

    const diffs = prev
      ? SchemaInspector.diffCatalogs(prev.tablesJson, b.tablesJson)
      : [];
    const added = diffs.filter((d) => d.kind === 'ADDED').length;
    const removed = diffs.filter((d) => d.kind === 'REMOVED').length;
    const modified = diffs.filter((d) => d.kind === 'MODIFIED').length;

    const tableCount = new Set(
      b.tablesJson.map((r) => `${r.table_schema}.${r.table_name}`)
    ).size;

    const isInitial = i === 0;
    const title = isInitial
      ? 'Initial Schema Baseline Captured'
      : diffs.length > 0
        ? `Schema Baseline Updated (${diffs.length} column change${diffs.length === 1 ? '' : 's'})`
        : 'Schema Baseline Promoted';

    const summary = isInitial
      ? `Recorded baseline digest ${b.schemaHash.slice(0, 12)} covering ${tableCount} tables and ${b.tablesJson.length} columns.`
      : diffs.length > 0
        ? `Promoted digest ${b.schemaHash.slice(0, 12)} (+${added} added, -${removed} removed, ~${modified} modified vs. previous baseline).`
        : `Re-confirmed canonical digest ${b.schemaHash.slice(0, 12)} across ${tableCount} tables and ${b.tablesJson.length} columns.`;

    const meta: { label: string; value: string; mono?: boolean }[] = [
      { label: 'SHA-256 Digest', value: b.schemaHash.slice(0, 16), mono: true },
      {
        label: 'Catalog Scope',
        value: `${tableCount} tables · ${b.tablesJson.length} columns`,
        mono: true,
      },
    ];
    if (b.gitCommitSha) {
      meta.push({
        label: 'Git Commit',
        value: b.gitCommitSha.slice(0, 12),
        mono: true,
      });
    }
    if (diffs.length > 0) {
      const sample = diffs
        .slice(0, 3)
        .map(
          (d) =>
            `${d.kind === 'ADDED' ? '+' : d.kind === 'REMOVED' ? '-' : '~'} ${d.table_name}.${d.column_name}`
        )
        .join(', ');
      meta.push({
        label: 'Delta vs Prior Baseline',
        value: diffs.length > 3 ? `${sample} (+${diffs.length - 3} more)` : sample,
        mono: true,
      });
    }

    events.push({
      id: `baseline-${b.id}`,
      category: 'schema_change',
      subtype: isInitial ? 'BASELINE_INITIAL' : 'BASELINE_PROMOTED',
      title,
      summary,
      timestamp: b.createdAt.toISOString(),
      severity: diffs.length > 0 ? 'WARNING' : 'SUCCESS',
      actor: matchedAudit?.actorEmail ?? null,
      statusLabel: i === baselinesAsc.length - 1 ? 'Active Baseline' : 'Archived',
      schemaHash: b.schemaHash,
      gitCommitSha: b.gitCommitSha ?? null,
      targetTab: 'baselines',
      meta,
    });
  }

  // 2. Manual Inspections + Inter-Snapshot Schema Transitions
  for (let i = 0; i < snapshotsAsc.length; i += 1) {
    const snap = snapshotsAsc[i];
    const prevSnap = i > 0 ? snapshotsAsc[i - 1] : null;
    const matchedAudit = findMatchingAudit(
      ['INSPECTION_RUN'],
      snap.inspectedAt.getTime()
    );

    // Check if schema hash shifted between consecutive snapshots
    if (prevSnap && prevSnap.schemaHash !== snap.schemaHash) {
      const snapDiffs = SchemaInspector.diffCatalogs(
        prevSnap.catalogJson,
        snap.catalogJson
      );
      const added = snapDiffs.filter((d) => d.kind === 'ADDED').length;
      const removed = snapDiffs.filter((d) => d.kind === 'REMOVED').length;
      const modified = snapDiffs.filter((d) => d.kind === 'MODIFIED').length;

      events.push({
        id: `snap-diff-${snap.id}`,
        category: 'schema_change',
        subtype: 'CATALOG_DRIFT_DETECTED',
        title: `Live Catalog Changed (${snapDiffs.length} column delta${snapDiffs.length === 1 ? '' : 's'})`,
        summary: `Schema hash shifted from ${prevSnap.schemaHash.slice(0, 10)} to ${snap.schemaHash.slice(0, 10)} (+${added} added, -${removed} removed, ~${modified} modified).`,
        timestamp: new Date(snap.inspectedAt.getTime() + 1).toISOString(),
        severity: removed > 0 ? 'CRITICAL' : 'WARNING',
        actor: matchedAudit?.actorEmail ?? null,
        statusLabel: 'Catalog Transition',
        schemaHash: snap.schemaHash,
        targetTab: 'diff',
        meta: [
          {
            label: 'Previous → New Hash',
            value: `${prevSnap.schemaHash.slice(0, 10)} → ${snap.schemaHash.slice(0, 10)}`,
            mono: true,
          },
          {
            label: 'Detected Delta',
            value: `+${added} added · -${removed} removed · ~${modified} modified`,
            mono: true,
          },
        ],
      });
    }

    // Find active baseline at the time of inspection
    const activeBaselineAtTime = baselinesAsc
      .filter((b) => b.createdAt.getTime() <= snap.inspectedAt.getTime() + 2_000)
      .pop();

    const matchesBaseline =
      activeBaselineAtTime && activeBaselineAtTime.schemaHash === snap.schemaHash;

    const hasFindings =
      (activeBaselineAtTime && !matchesBaseline) ||
      snap.activeLocksCount > 0 ||
      snap.bloatedIndexesCount > 0;

    const inspectionActor = matchedAudit?.actorEmail ?? null;
    const isCiRun = inspectionActor?.startsWith('ci:') ?? false;
    const title = isCiRun
      ? `CI Gate Inspection (${inspectionActor!.slice(3)})`
      : inspectionActor
        ? 'Manual Inspection Completed'
        : 'Catalog & Telemetry Inspection';

    const summaryParts = [
      `Scanned ${snap.tableCount} tables and ${snap.columnCount} columns in ${snap.durationMs}ms.`,
    ];
    if (activeBaselineAtTime) {
      summaryParts.push(
        matchesBaseline ? 'Schema matches baseline.' : 'Schema diverged from baseline.'
      );
    }
    if (snap.activeLocksCount > 0) {
      summaryParts.push(`${snap.activeLocksCount} blocking lock(s).`);
    }
    if (snap.bloatedIndexesCount > 0) {
      summaryParts.push(`${snap.bloatedIndexesCount} bloated index(es).`);
    }

    const meta: { label: string; value: string; mono?: boolean }[] = [
      { label: 'Duration', value: `${snap.durationMs} ms`, mono: true },
      { label: 'Schema Hash', value: snap.schemaHash.slice(0, 12), mono: true },
      {
        label: 'Scope',
        value: `${snap.tableCount} tables · ${snap.columnCount} columns`,
        mono: true,
      },
      {
        label: 'Locks / Bloat',
        value: `${snap.activeLocksCount} locks · ${snap.bloatedIndexesCount} bloated idx`,
        mono: true,
      },
    ];

    if (snap.healthJson) {
      meta.push({
        label: 'Cache Hit / Size',
        value: `${snap.healthJson.cache_hit_ratio_pct.toFixed(1)}% · ${snap.healthJson.database_size_pretty}`,
        mono: true,
      });
    }

    events.push({
      id: `inspection-${snap.id}`,
      category: 'manual_inspection',
      subtype: isCiRun ? 'CI_INSPECTION' : 'INSPECTION_RUN',
      title,
      summary: summaryParts.join(' '),
      timestamp: snap.inspectedAt.toISOString(),
      severity:
        activeBaselineAtTime && !matchesBaseline
          ? 'CRITICAL'
          : hasFindings
            ? 'WARNING'
            : 'INFO',
      actor: inspectionActor,
      statusLabel:
        activeBaselineAtTime && !matchesBaseline
          ? 'Drift Found'
          : hasFindings
            ? 'Findings'
            : 'Nominal',
      schemaHash: snap.schemaHash,
      durationMs: snap.durationMs,
      targetTab:
        activeBaselineAtTime && !matchesBaseline
          ? 'diff'
          : snap.activeLocksCount > 0
            ? 'locks'
            : 'catalog',
      meta,
    });
  }

  // 3. Alert Triggers (Telemetry Incidents + Resolution Milestones)
  for (const inc of incidentsDesc) {
    const matchedAudit = findMatchingAudit(
      ['DRILL_EXECUTED', 'TREND_ANOMALY_PROMOTED'],
      inc.createdAt.getTime()
    );

    const isDrill =
      matchedAudit?.action === 'DRILL_EXECUTED' ||
      inc.details.summary.startsWith('[Drill]');
    const isTrendPromoted = matchedAudit?.action === 'TREND_ANOMALY_PROMOTED';

    const titlePrefix = isDrill
      ? 'Drill · '
      : isTrendPromoted
        ? 'Trend Alert · '
        : '';

    const meta = buildIncidentMeta(inc.incidentType, inc.details);
    meta.push({
      label: 'Incident Status',
      value: inc.status,
      mono: true,
    });

    events.push({
      id: `incident-${inc.id}`,
      category: 'alert_trigger',
      subtype: inc.incidentType,
      title: `${titlePrefix}${formatIncidentTypeLabel(inc.incidentType)}`,
      summary: inc.details.summary,
      timestamp: inc.createdAt.toISOString(),
      severity: inc.severity as 'INFO' | 'WARNING' | 'CRITICAL',
      actor: matchedAudit?.actorEmail ?? null,
      statusLabel: inc.status,
      targetTab: mapIncidentTab(inc.incidentType),
      remediationSql: extractRemediationSql(inc.details),
      meta,
    });

    if (
      inc.resolvedAt &&
      inc.resolvedAt.getTime() - inc.createdAt.getTime() > 5_000
    ) {
      events.push({
        id: `incident-resolved-${inc.id}`,
        category: 'alert_trigger',
        subtype: `${inc.incidentType}_RESOLVED`,
        title: `Resolved · ${formatIncidentTypeLabel(inc.incidentType)}`,
        summary: inc.details.summary,
        timestamp: inc.resolvedAt.toISOString(),
        severity: 'SUCCESS',
        actor: null,
        statusLabel: 'RESOLVED',
        targetTab: mapIncidentTab(inc.incidentType),
        meta: [
          { label: 'Incident Type', value: inc.incidentType, mono: true },
          {
            label: 'Opened At',
            value: inc.createdAt.toISOString().slice(0, 19).replace('T', ' '),
            mono: true,
          },
        ],
      });
    }
  }

  // 4. Migration Safety Checks targeting this DB (Schema Changes)
  for (const check of migrationsDesc) {
    events.push({
      id: `migration-${check.id}`,
      category: 'schema_change',
      subtype: 'MIGRATION_LINT',
      title: `Migration Linted: ${check.title}`,
      summary: `Pre-deploy SQL safety check finished with risk level ${check.riskLevel} (${check.findingsJson.length} finding${check.findingsJson.length === 1 ? '' : 's'}).`,
      timestamp: check.createdAt.toISOString(),
      severity:
        check.riskLevel === 'BLOCKED'
          ? 'CRITICAL'
          : check.riskLevel === 'WARNING'
            ? 'WARNING'
            : 'SUCCESS',
      actor: null,
      statusLabel: check.riskLevel,
      targetTab: 'diff',
      meta: [
        { label: 'Risk Assessment', value: check.riskLevel, mono: true },
        {
          label: 'Findings',
          value: String(check.findingsJson.length),
          mono: true,
        },
      ],
    });
  }

  // 5. Remaining unmatched target audit logs (registration, PDF report exports, etc.)
  for (const log of auditsDesc) {
    if (usedAuditIds.has(log.id)) continue;

    if (log.action === 'TARGET_REGISTERED') {
      events.push({
        id: `audit-${log.id}`,
        category: 'manual_inspection',
        subtype: log.action,
        title: 'Target Database Registered',
        summary: log.summary,
        timestamp: log.createdAt.toISOString(),
        severity: 'INFO',
        actor: log.actorEmail,
        statusLabel: 'Lifecycle',
        meta: [{ label: 'Action', value: log.action, mono: true }],
      });
    } else if (log.action === 'HEALTH_REPORT_EXPORTED') {
      events.push({
        id: `audit-${log.id}`,
        category: 'manual_inspection',
        subtype: log.action,
        title: '30-Day Health Report Exported',
        summary: log.summary,
        timestamp: log.createdAt.toISOString(),
        severity: 'INFO',
        actor: log.actorEmail,
        statusLabel: 'PDF Export',
        meta: [{ label: 'Action', value: log.action, mono: true }],
      });
    } else if (log.action === 'INSPECTION_RUN') {
      events.push({
        id: `audit-${log.id}`,
        category: 'manual_inspection',
        subtype: log.action,
        title: 'Manual Inspection Recorded',
        summary: log.summary,
        timestamp: log.createdAt.toISOString(),
        severity: 'INFO',
        actor: log.actorEmail,
        statusLabel: 'Audit',
        meta: [{ label: 'Action', value: log.action, mono: true }],
      });
    } else if (log.action === 'BASELINE_PROMOTED') {
      events.push({
        id: `audit-${log.id}`,
        category: 'schema_change',
        subtype: log.action,
        title: 'Schema Baseline Promoted',
        summary: log.summary,
        timestamp: log.createdAt.toISOString(),
        severity: 'SUCCESS',
        actor: log.actorEmail,
        statusLabel: 'Baseline',
        meta: [{ label: 'Action', value: log.action, mono: true }],
      });
    }
  }

  // Sort strictly newest first
  events.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const limitedEvents = events.slice(0, 120);

  return {
    databaseId: target.id,
    databaseName: target.name,
    environment: target.environment as EnvironmentType,
    generatedAt: new Date().toISOString(),
    counts: {
      all: limitedEvents.length,
      schema_change: limitedEvents.filter((e) => e.category === 'schema_change')
        .length,
      alert_trigger: limitedEvents.filter((e) => e.category === 'alert_trigger')
        .length,
      manual_inspection: limitedEvents.filter(
        (e) => e.category === 'manual_inspection'
      ).length,
    },
    events: limitedEvents,
  };
}
