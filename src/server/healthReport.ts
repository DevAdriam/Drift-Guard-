import PDFDocument from 'pdfkit';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  monitoredDatabases,
  schemaBaselines,
  telemetryIncidents,
  telemetrySnapshots,
} from '../db/schema.ts';
import { decryptSecret, validateSafePostgresUrl } from './crypto.ts';
import { SchemaInspector } from './inspector.ts';
import { recordAuditLog } from './extendedService.ts';
import type {
  ConnectionMode,
  ExpensiveQueryRow,
  IncidentDetails,
} from '../types/telemetry.ts';

function sanitizePdfText(value: unknown, maxLen = 220): string {
  const raw = value == null ? '' : String(value);
  const cleaned = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLen - 3))}...`;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDateTime(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '0.00 ms';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

function extractIncidentSummary(details: IncidentDetails): string {
  if (details && typeof details === 'object' && 'summary' in details) {
    return sanitizePdfText(details.summary, 140);
  }
  return 'Telemetry anomaly recorded.';
}

export async function generateDatabaseHealthReportPdf(
  ownerUid: string,
  actorEmail: string,
  databaseId: string
): Promise<{ filename: string; buffer: Buffer }> {
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
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    snapshots30d,
    incidents30d,
    baselines30d,
    latestBaselineRows,
    latestSnapshotRows,
  ] = await Promise.all([
    db
      .select()
      .from(telemetrySnapshots)
      .where(
        and(
          eq(telemetrySnapshots.databaseId, databaseId),
          gte(telemetrySnapshots.inspectedAt, thirtyDaysAgo)
        )
      )
      .orderBy(desc(telemetrySnapshots.inspectedAt))
      .limit(100),
    db
      .select()
      .from(telemetryIncidents)
      .where(
        and(
          eq(telemetryIncidents.databaseId, databaseId),
          gte(telemetryIncidents.createdAt, thirtyDaysAgo)
        )
      )
      .orderBy(desc(telemetryIncidents.createdAt))
      .limit(100),
    db
      .select()
      .from(schemaBaselines)
      .where(
        and(
          eq(schemaBaselines.databaseId, databaseId),
          gte(schemaBaselines.createdAt, thirtyDaysAgo)
        )
      )
      .orderBy(desc(schemaBaselines.createdAt))
      .limit(30),
    db
      .select()
      .from(schemaBaselines)
      .where(eq(schemaBaselines.databaseId, databaseId))
      .orderBy(desc(schemaBaselines.createdAt))
      .limit(1),
    db
      .select()
      .from(telemetrySnapshots)
      .where(eq(telemetrySnapshots.databaseId, databaseId))
      .orderBy(desc(telemetrySnapshots.inspectedAt))
      .limit(1),
  ]);

  const activeBaseline = latestBaselineRows[0] ?? null;
  const latestSnapshot = latestSnapshotRows[0] ?? null;
  const liveDiff =
    activeBaseline && latestSnapshot
      ? SchemaInspector.diffCatalogs(
          activeBaseline.tablesJson,
          latestSnapshot.catalogJson
        )
      : [];

  // Best-effort live query latency telemetry from pg_stat_statements
  let topQueries: ExpensiveQueryRow[] = [];
  let pgssNote: string | null = null;
  try {
    const mode = target.connectionMode as ConnectionMode;
    let connectionUrl: string | undefined;
    if (mode === 'external') {
      if (target.connectionUrlEncrypted) {
        connectionUrl = decryptSecret(target.connectionUrlEncrypted);
        await validateSafePostgresUrl(connectionUrl);
      }
    }
    if (mode === 'workspace_pg' || connectionUrl) {
      const perfRes = await SchemaInspector.fetchTopExpensiveQueries(
        mode,
        connectionUrl
      );
      if (perfRes.extensionAvailable) {
        topQueries = perfRes.queries;
      } else {
        pgssNote =
          perfRes.unavailableReason ??
          'pg_stat_statements extension is not enabled on this target.';
      }
    }
  } catch {
    pgssNote =
      'Live pg_stat_statements metrics were unavailable while generating this report.';
  }

  // 30-day aggregate metrics
  const driftIncidents = incidents30d.filter(
    (i) => i.incidentType === 'SCHEMA_DRIFT'
  );
  const lockIncidents = incidents30d.filter(
    (i) => i.incidentType === 'LOCK_CONTENTION'
  );
  const bloatIncidents = incidents30d.filter(
    (i) => i.incidentType === 'INDEX_BLOAT'
  );
  const vacuumIncidents = incidents30d.filter(
    (i) => i.incidentType === 'VACUUM_HEALTH'
  );
  const connIncidents = incidents30d.filter(
    (i) => i.incidentType === 'CONNECTION_SATURATION'
  );
  const openIncidents = incidents30d.filter((i) => i.status !== 'RESOLVED');
  const criticalIncidents = incidents30d.filter(
    (i) => i.severity === 'CRITICAL'
  );

  const avgDurationMs =
    snapshots30d.length > 0
      ? Math.round(
          snapshots30d.reduce((s, x) => s + x.durationMs, 0) /
            snapshots30d.length
        )
      : 0;
  const maxDurationMs =
    snapshots30d.length > 0
      ? Math.max(...snapshots30d.map((x) => x.durationMs))
      : 0;
  const peakLocks30d =
    snapshots30d.length > 0
      ? Math.max(...snapshots30d.map((x) => x.activeLocksCount))
      : 0;
  const peakBloatedIdx30d =
    snapshots30d.length > 0
      ? Math.max(...snapshots30d.map((x) => x.bloatedIndexesCount))
      : 0;

  const cacheHitReadings = snapshots30d
    .map((s) => s.healthJson?.cache_hit_ratio_pct)
    .filter((v): v is number => typeof v === 'number');
  const avgCacheHitPct =
    cacheHitReadings.length > 0
      ? cacheHitReadings.reduce((a, b) => a + b, 0) / cacheHitReadings.length
      : (latestSnapshot?.healthJson?.cache_hit_ratio_pct ?? null);

  const connUsageReadings = snapshots30d
    .map((s) => s.healthJson?.connection_usage_pct)
    .filter((v): v is number => typeof v === 'number');
  const peakConnUsagePct =
    connUsageReadings.length > 0
      ? Math.max(...connUsageReadings)
      : (latestSnapshot?.healthJson?.connection_usage_pct ?? null);

  const health = latestSnapshot?.healthJson ?? null;
  const schemaMatched =
    activeBaseline &&
    latestSnapshot &&
    activeBaseline.schemaHash === latestSnapshot.schemaHash;

  const buffer = await renderPdfBuffer({
    targetName: target.name,
    environment: target.environment,
    maskedTarget: target.maskedTarget,
    healthStatus: target.lastHealthStatus,
    pgVersion: health?.pg_version ?? 'PostgreSQL',
    periodStart: thirtyDaysAgo,
    periodEnd: now,
    activeBaselineHash: activeBaseline?.schemaHash ?? null,
    activeBaselineSha: activeBaseline?.gitCommitSha ?? null,
    liveSchemaHash: latestSnapshot?.schemaHash ?? null,
    schemaMatched: Boolean(schemaMatched),
    liveDiff,
    snapshotsCount30d: snapshots30d.length,
    avgDurationMs,
    maxDurationMs,
    peakLocks30d,
    peakBloatedIdx30d,
    avgCacheHitPct,
    peakConnUsagePct,
    dbSizePretty: health?.database_size_pretty ?? 'N/A',
    tableCount: latestSnapshot?.tableCount ?? 0,
    columnCount: latestSnapshot?.columnCount ?? 0,
    incidents30d,
    driftCount30d: driftIncidents.length,
    lockCount30d: lockIncidents.length,
    bloatCount30d: bloatIncidents.length,
    vacuumCount30d: vacuumIncidents.length,
    connCount30d: connIncidents.length,
    openIncidents30d: openIncidents.length,
    criticalIncidents30d: criticalIncidents.length,
    baselines30d,
    snapshots30d,
    topQueries,
    pgssNote,
    tableHealth: health?.table_health ?? [],
    unusedIndexes: health?.unused_indexes ?? [],
    bloatedIndexes: latestSnapshot?.bloatJson ?? [],
  });

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'HEALTH_REPORT_EXPORTED',
    entityType: 'monitored_database',
    entityLabel: target.name,
    summary: `Exported 30-day PDF health & schema drift report (${snapshots30d.length} snapshots, ${incidents30d.length} incidents).`,
  });

  const safeSlug =
    target.name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'database';
  const filename = `driftguard-health-report-${safeSlug}-${formatDate(now)}.pdf`;

  return { filename, buffer };
}

interface ReportRenderPayload {
  targetName: string;
  environment: string;
  maskedTarget: string;
  healthStatus: string;
  pgVersion: string;
  periodStart: Date;
  periodEnd: Date;
  activeBaselineHash: string | null;
  activeBaselineSha: string | null;
  liveSchemaHash: string | null;
  schemaMatched: boolean;
  liveDiff: ReturnType<typeof SchemaInspector.diffCatalogs>;
  snapshotsCount30d: number;
  avgDurationMs: number;
  maxDurationMs: number;
  peakLocks30d: number;
  peakBloatedIdx30d: number;
  avgCacheHitPct: number | null;
  peakConnUsagePct: number | null;
  dbSizePretty: string;
  tableCount: number;
  columnCount: number;
  incidents30d: (typeof telemetryIncidents.$inferSelect)[];
  driftCount30d: number;
  lockCount30d: number;
  bloatCount30d: number;
  vacuumCount30d: number;
  connCount30d: number;
  openIncidents30d: number;
  criticalIncidents30d: number;
  baselines30d: (typeof schemaBaselines.$inferSelect)[];
  snapshots30d: (typeof telemetrySnapshots.$inferSelect)[];
  topQueries: ExpensiveQueryRow[];
  pgssNote: string | null;
  tableHealth: NonNullable<
    NonNullable<typeof telemetrySnapshots.$inferSelect.healthJson>['table_health']
  >;
  unusedIndexes: NonNullable<
    NonNullable<
      typeof telemetrySnapshots.$inferSelect.healthJson
    >['unused_indexes']
  >;
  bloatedIndexes: (typeof telemetrySnapshots.$inferSelect)['bloatJson'];
}

function renderPdfBuffer(payload: ReportRenderPayload): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 48,
      bufferPages: true,
      info: {
        Title: `DriftGuard 30-Day Health Report - ${sanitizePdfText(payload.targetName, 80)}`,
        Author: 'DriftGuard PostgreSQL Telemetry',
        Subject: '30-Day Schema Drift and Database Performance Summary',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const pageLeft = 48;
    const pageRight = doc.page.width - 48;
    const contentWidth = pageRight - pageLeft;
    const bottomLimit = doc.page.height - 62;

    const COLORS = {
      ink: '#0F172A',
      slate: '#334155',
      muted: '#64748B',
      border: '#CBD5E1',
      hairline: '#E2E8F0',
      surface: '#F8FAFC',
      blue: '#1D4ED8',
      red: '#B91C1C',
      amber: '#B45309',
      emerald: '#047857',
    };

    const ensureSpace = (needed: number) => {
      if (doc.y + needed > bottomLimit) {
        doc.addPage();
      }
    };

    const drawSectionHeading = (title: string, subtitle?: string) => {
      ensureSpace(44);
      doc.moveDown(0.5);
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor(COLORS.ink)
        .text(title, pageLeft, doc.y);
      if (subtitle) {
        doc
          .font('Helvetica')
          .fontSize(8.5)
          .fillColor(COLORS.muted)
          .text(subtitle, pageLeft, doc.y + 2);
      }
      const lineY = doc.y + 5;
      doc
        .moveTo(pageLeft, lineY)
        .lineTo(pageRight, lineY)
        .lineWidth(0.8)
        .strokeColor(COLORS.border)
        .stroke();
      doc.y = lineY + 10;
    };

    // --- Header Banner ---
    doc
      .rect(pageLeft, doc.y, contentWidth, 74)
      .fill('#0F172A');

    const headerTop = doc.y + 14;
    doc
      .font('Helvetica-Bold')
      .fontSize(15)
      .fillColor('#FFFFFF')
      .text('DriftGuard  |  30-Day Database Health Report', pageLeft + 16, headerTop);

    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor('#CBD5E1')
      .text(
        `${sanitizePdfText(payload.targetName, 50)}  (${payload.environment.toUpperCase()})  -  ${sanitizePdfText(payload.pgVersion, 32)}`,
        pageLeft + 16,
        headerTop + 22
      );

    doc
      .font('Courier')
      .fontSize(8)
      .fillColor('#94A3B8')
      .text(
        `Period: ${formatDate(payload.periodStart)} to ${formatDate(payload.periodEnd)}   |   Generated: ${formatDateTime(payload.periodEnd)}`,
        pageLeft + 16,
        headerTop + 39
      );

    const statusText =
      payload.healthStatus === 'HEALTHY'
        ? 'NOMINAL'
        : payload.healthStatus === 'DRIFT'
          ? 'SCHEMA DRIFT'
          : payload.healthStatus;
    const statusColor =
      payload.healthStatus === 'HEALTHY'
        ? '#34D399'
        : payload.healthStatus === 'DRIFT' || payload.healthStatus === 'ERROR'
          ? '#F87171'
          : '#FBBF24';

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(statusColor)
      .text(statusText, pageLeft, headerTop + 6, {
        width: contentWidth - 16,
        align: 'right',
      });

    doc.y = headerTop + 72;

    // Target Connection Context Line
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(COLORS.muted)
      .text(
        `Target Endpoint: ${sanitizePdfText(payload.maskedTarget, 90)}   |   Tables: ${payload.tableCount}   |   Columns: ${payload.columnCount}`,
        pageLeft,
        doc.y
      );
    doc.moveDown(0.7);

    // --- 4-Column Executive KPI Grid ---
    const kpiTop = doc.y;
    const kpiHeight = 60;
    const colW = contentWidth / 4;

    const kpis: {
      label: string;
      value: string;
      sub: string;
      color?: string;
    }[] = [
      {
        label: '30-Day Schema Drift',
        value: `${payload.driftCount30d} event${payload.driftCount30d === 1 ? '' : 's'}`,
        sub: payload.schemaMatched
          ? 'Baseline Matched'
          : `${payload.liveDiff.length} active diff(s)`,
        color:
          payload.driftCount30d > 0 || !payload.schemaMatched
            ? COLORS.red
            : COLORS.emerald,
      },
      {
        label: '30-Day Inspections',
        value: `${payload.snapshotsCount30d}`,
        sub: `Avg ${payload.avgDurationMs} ms (Max ${payload.maxDurationMs} ms)`,
        color: COLORS.ink,
      },
      {
        label: 'Cache Hit & Pool Peak',
        value:
          payload.avgCacheHitPct !== null
            ? `${payload.avgCacheHitPct.toFixed(1)}%`
            : 'N/A',
        sub:
          payload.peakConnUsagePct !== null
            ? `Peak conn: ${payload.peakConnUsagePct.toFixed(1)}%`
            : 'Connections N/A',
        color:
          payload.avgCacheHitPct !== null && payload.avgCacheHitPct < 95
            ? COLORS.amber
            : COLORS.ink,
      },
      {
        label: '30-Day Incidents',
        value: `${payload.incidents30d.length} total`,
        sub: `${payload.openIncidents30d} open  |  ${payload.criticalIncidents30d} critical`,
        color:
          payload.criticalIncidents30d > 0
            ? COLORS.red
            : payload.openIncidents30d > 0
              ? COLORS.amber
              : COLORS.emerald,
      },
    ];

    doc
      .rect(pageLeft, kpiTop, contentWidth, kpiHeight)
      .fillAndStroke(COLORS.surface, COLORS.hairline);

    kpis.forEach((kpi, idx) => {
      const x = pageLeft + idx * colW;
      if (idx > 0) {
        doc
          .moveTo(x, kpiTop + 8)
          .lineTo(x, kpiTop + kpiHeight - 8)
          .lineWidth(0.6)
          .strokeColor(COLORS.hairline)
          .stroke();
      }
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(COLORS.muted)
        .text(kpi.label, x + 10, kpiTop + 10, { width: colW - 20 });
      doc
        .font('Helvetica-Bold')
        .fontSize(13)
        .fillColor(kpi.color ?? COLORS.ink)
        .text(kpi.value, x + 10, kpiTop + 23, { width: colW - 20 });
      doc
        .font('Courier')
        .fontSize(7.5)
        .fillColor(COLORS.slate)
        .text(kpi.sub, x + 10, kpiTop + 42, { width: colW - 20 });
    });

    doc.y = kpiTop + kpiHeight + 12;

    // --- Section 1: Schema Drift & Baseline Integrity ---
    drawSectionHeading(
      '1. Schema Drift & Baseline Integrity (Last 30 Days)',
      'Comparison between the live information_schema catalog and the latest approved SHA-256 baseline.'
    );

    const baselineShaText = payload.activeBaselineHash
      ? `${payload.activeBaselineHash.slice(0, 16)}...`
      : 'None recorded';
    const liveShaText = payload.liveSchemaHash
      ? `${payload.liveSchemaHash.slice(0, 16)}...`
      : 'Not inspected';

    doc
      .font('Courier')
      .fontSize(8.5)
      .fillColor(COLORS.slate)
      .text(
        `Approved Baseline SHA-256 : ${baselineShaText}${payload.activeBaselineSha ? `  (Git ${payload.activeBaselineSha.slice(0, 10)})` : ''}`,
        pageLeft,
        doc.y
      );
    doc
      .font('Courier')
      .fontSize(8.5)
      .fillColor(COLORS.slate)
      .text(`Latest Live SHA-256       : ${liveShaText}`, pageLeft, doc.y + 3);
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(COLORS.slate)
      .text(
        `Baselines promoted in last 30 days: ${payload.baselines30d.length}   |   Schema Drift alerts: ${payload.driftCount30d}`,
        pageLeft,
        doc.y + 4
      );
    doc.moveDown(0.5);

    if (payload.liveDiff.length === 0) {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLORS.emerald)
        .text(
          'Status: Zero active schema drift. Live database catalog matches the approved baseline.',
          pageLeft,
          doc.y
        );
      doc.moveDown(0.5);
    } else {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLORS.red)
        .text(
          `Active Drift Detected: ${payload.liveDiff.length} column change(s) differ from the approved baseline:`,
          pageLeft,
          doc.y
        );
      doc.moveDown(0.3);

      const shownDiffs = payload.liveDiff.slice(0, 15);
      for (const diff of shownDiffs) {
        ensureSpace(16);
        const colPath = `${diff.table_schema}.${diff.table_name}.${diff.column_name}`;
        const detailStr =
          diff.kind === 'ADDED'
            ? `Added (${diff.live?.data_type ?? 'unknown'}, nullable=${diff.live?.is_nullable ?? '?'})`
            : diff.kind === 'REMOVED'
              ? `Removed (was ${diff.baseline?.data_type ?? 'unknown'})`
              : `Modified (${diff.baseline?.data_type ?? '?'} -> ${diff.live?.data_type ?? '?'})`;

        const tagColor =
          diff.kind === 'ADDED'
            ? COLORS.emerald
            : diff.kind === 'REMOVED'
              ? COLORS.red
              : COLORS.amber;

        const rowY = doc.y;
        doc
          .font('Courier-Bold')
          .fontSize(8)
          .fillColor(tagColor)
          .text(`[${diff.kind}]`, pageLeft, rowY, { width: 58 });
        doc
          .font('Courier')
          .fontSize(8)
          .fillColor(COLORS.ink)
          .text(sanitizePdfText(colPath, 42), pageLeft + 60, rowY, {
            width: 215,
          });
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(COLORS.slate)
          .text(sanitizePdfText(detailStr, 60), pageLeft + 280, rowY, {
            width: contentWidth - 280,
          });
        doc.y = rowY + 13;
      }
      if (payload.liveDiff.length > shownDiffs.length) {
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(COLORS.muted)
          .text(
            `... plus ${payload.liveDiff.length - shownDiffs.length} additional column diff(s).`,
            pageLeft,
            doc.y + 2
          );
      }
      doc.moveDown(0.5);
    }

    // --- Section 2: 30-Day Telemetry Incidents Summary ---
    drawSectionHeading(
      '2. 30-Day Incident Breakdown',
      `Drift: ${payload.driftCount30d}  |  Lock Contention: ${payload.lockCount30d}  |  Index Bloat: ${payload.bloatCount30d}  |  Vacuum Health: ${payload.vacuumCount30d}  |  Connections: ${payload.connCount30d}`
    );

    if (payload.incidents30d.length === 0) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLORS.emerald)
        .text(
          'No telemetry incidents were triggered during the last 30 days.',
          pageLeft,
          doc.y
        );
      doc.moveDown(0.5);
    } else {
      // Table Header
      const headerY = doc.y;
      doc.rect(pageLeft, headerY, contentWidth, 17).fill('#F1F5F9');
      doc
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .fillColor(COLORS.slate)
        .text('Date (UTC)', pageLeft + 6, headerY + 5, { width: 72 })
        .text('Type', pageLeft + 80, headerY + 5, { width: 100 })
        .text('Severity', pageLeft + 184, headerY + 5, { width: 56 })
        .text('Status', pageLeft + 244, headerY + 5, { width: 64 })
        .text('Summary', pageLeft + 312, headerY + 5, {
          width: contentWidth - 318,
        });
      doc.y = headerY + 21;

      const shownIncidents = payload.incidents30d.slice(0, 15);
      for (const inc of shownIncidents) {
        ensureSpace(22);
        const y = doc.y;
        const sevColor =
          inc.severity === 'CRITICAL'
            ? COLORS.red
            : inc.severity === 'WARNING'
              ? COLORS.amber
              : COLORS.blue;

        doc
          .font('Courier')
          .fontSize(7.5)
          .fillColor(COLORS.muted)
          .text(formatDate(inc.createdAt), pageLeft + 6, y, { width: 72 });
        doc
          .font('Courier-Bold')
          .fontSize(7.5)
          .fillColor(COLORS.ink)
          .text(inc.incidentType, pageLeft + 80, y, { width: 100 });
        doc
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .fillColor(sevColor)
          .text(inc.severity, pageLeft + 184, y, { width: 56 });
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(COLORS.slate)
          .text(inc.status, pageLeft + 244, y, { width: 64 });
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(COLORS.slate)
          .text(
            extractIncidentSummary(inc.details),
            pageLeft + 312,
            y,
            { width: contentWidth - 318, lineBreak: false, ellipsis: true }
          );

        const nextY = y + 15;
        doc
          .moveTo(pageLeft, nextY - 2)
          .lineTo(pageRight, nextY - 2)
          .lineWidth(0.4)
          .strokeColor(COLORS.hairline)
          .stroke();
        doc.y = nextY + 2;
      }
      if (payload.incidents30d.length > shownIncidents.length) {
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(COLORS.muted)
          .text(
            `Showing most recent ${shownIncidents.length} of ${payload.incidents30d.length} incidents from the last 30 days.`,
            pageLeft,
            doc.y + 2
          );
      }
      doc.moveDown(0.5);
    }

    // --- Section 3: Query Latency & Performance Metrics ---
    drawSectionHeading(
      '3. Query Performance & Inspection Latency Metrics',
      `Database Size: ${payload.dbSizePretty}  |  Peak Active Locks (30d): ${payload.peakLocks30d}  |  Peak Bloated Indexes (30d): ${payload.peakBloatedIdx30d}`
    );

    if (payload.topQueries.length > 0) {
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(COLORS.ink)
        .text(
          'Top 5 Most Expensive Queries by Average Latency (pg_stat_statements)',
          pageLeft,
          doc.y
        );
      doc.moveDown(0.35);

      const qHeadY = doc.y;
      doc.rect(pageLeft, qHeadY, contentWidth, 17).fill('#F1F5F9');
      doc
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .fillColor(COLORS.slate)
        .text('#', pageLeft + 6, qHeadY + 5, { width: 18 })
        .text('Avg Latency', pageLeft + 26, qHeadY + 5, { width: 64 })
        .text('Max Latency', pageLeft + 92, qHeadY + 5, { width: 64 })
        .text('Calls', pageLeft + 158, qHeadY + 5, { width: 46 })
        .text('Cache', pageLeft + 208, qHeadY + 5, { width: 42 })
        .text('Normalized SQL Preview', pageLeft + 254, qHeadY + 5, {
          width: contentWidth - 260,
        });
      doc.y = qHeadY + 21;

      payload.topQueries.forEach((q, idx) => {
        ensureSpace(22);
        const y = doc.y;
        const latColor =
          q.mean_exec_time_ms >= 100
            ? COLORS.red
            : q.mean_exec_time_ms >= 25
              ? COLORS.amber
              : COLORS.ink;

        doc
          .font('Courier-Bold')
          .fontSize(7.5)
          .fillColor(COLORS.muted)
          .text(`${idx + 1}`, pageLeft + 6, y, { width: 18 });
        doc
          .font('Courier-Bold')
          .fontSize(7.5)
          .fillColor(latColor)
          .text(formatMs(q.mean_exec_time_ms), pageLeft + 26, y, { width: 64 });
        doc
          .font('Courier')
          .fontSize(7.5)
          .fillColor(COLORS.slate)
          .text(formatMs(q.max_exec_time_ms), pageLeft + 92, y, { width: 64 });
        doc
          .font('Courier')
          .fontSize(7.5)
          .fillColor(COLORS.slate)
          .text(q.calls.toLocaleString(), pageLeft + 158, y, { width: 46 });
        doc
          .font('Courier')
          .fontSize(7.5)
          .fillColor(q.cache_hit_pct < 90 ? COLORS.amber : COLORS.slate)
          .text(`${q.cache_hit_pct.toFixed(1)}%`, pageLeft + 208, y, {
            width: 42,
          });
        doc
          .font('Courier')
          .fontSize(7.2)
          .fillColor(COLORS.ink)
          .text(sanitizePdfText(q.query, 92), pageLeft + 254, y, {
            width: contentWidth - 260,
            lineBreak: false,
            ellipsis: true,
          });

        const nextY = y + 15;
        doc
          .moveTo(pageLeft, nextY - 2)
          .lineTo(pageRight, nextY - 2)
          .lineWidth(0.4)
          .strokeColor(COLORS.hairline)
          .stroke();
        doc.y = nextY + 2;
      });
      doc.moveDown(0.5);
    } else if (payload.pgssNote) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text(`pg_stat_statements: ${sanitizePdfText(payload.pgssNote, 180)}`, pageLeft, doc.y);
      doc.moveDown(0.5);
    }

    // Recent 30-day Inspection Snapshots Table
    if (payload.snapshots30d.length > 0) {
      ensureSpace(64);
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(COLORS.ink)
        .text('Recent Telemetry Inspection Snapshots (Last 30 Days)', pageLeft, doc.y);
      doc.moveDown(0.35);

      const sHeadY = doc.y;
      doc.rect(pageLeft, sHeadY, contentWidth, 17).fill('#F1F5F9');
      doc
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .fillColor(COLORS.slate)
        .text('Inspected At (UTC)', pageLeft + 6, sHeadY + 5, { width: 112 })
        .text('Schema SHA', pageLeft + 122, sHeadY + 5, { width: 82 })
        .text('Tables / Cols', pageLeft + 208, sHeadY + 5, { width: 76 })
        .text('Locks', pageLeft + 288, sHeadY + 5, { width: 42 })
        .text('Cache Hit', pageLeft + 334, sHeadY + 5, { width: 62 })
        .text('DB Size', pageLeft + 400, sHeadY + 5, { width: 60 })
        .text('Poll ms', pageLeft + 464, sHeadY + 5, {
          width: contentWidth - 470,
          align: 'right',
        });
      doc.y = sHeadY + 21;

      for (const snap of payload.snapshots30d.slice(0, 10)) {
        ensureSpace(18);
        const y = doc.y;
        const hit = snap.healthJson?.cache_hit_ratio_pct;
        const sizeStr = snap.healthJson?.database_size_pretty ?? '—';
        doc
          .font('Courier')
          .fontSize(7.5)
          .fillColor(COLORS.slate)
          .text(formatDateTime(snap.inspectedAt), pageLeft + 6, y, { width: 112 })
          .text(snap.schemaHash.slice(0, 12), pageLeft + 122, y, { width: 82 })
          .text(`${snap.tableCount}t / ${snap.columnCount}c`, pageLeft + 208, y, {
            width: 76,
          })
          .text(String(snap.activeLocksCount), pageLeft + 288, y, { width: 42 })
          .text(hit !== undefined ? `${hit.toFixed(1)}%` : 'N/A', pageLeft + 334, y, {
            width: 62,
          })
          .text(sanitizePdfText(sizeStr, 14), pageLeft + 400, y, { width: 60 })
          .text(`${snap.durationMs} ms`, pageLeft + 464, y, {
            width: contentWidth - 470,
            align: 'right',
          });

        const nextY = y + 14;
        doc
          .moveTo(pageLeft, nextY - 2)
          .lineTo(pageRight, nextY - 2)
          .lineWidth(0.4)
          .strokeColor(COLORS.hairline)
          .stroke();
        doc.y = nextY + 2;
      }
      doc.moveDown(0.5);
    }

    // --- Section 4: Storage, Table Bloat & Maintenance Advisories ---
    drawSectionHeading(
      '4. Storage Health, Table Bloat & Maintenance Advisories',
      `Tracked Tables: ${payload.tableHealth.length}  |  Bloated Indexes: ${payload.bloatedIndexes.length}  |  Unused Non-Unique Indexes: ${payload.unusedIndexes.length}`
    );

    if (payload.tableHealth.length > 0) {
      const tHeadY = doc.y;
      doc.rect(pageLeft, tHeadY, contentWidth, 17).fill('#F1F5F9');
      doc
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .fillColor(COLORS.slate)
        .text('Table', pageLeft + 6, tHeadY + 5, { width: 165 })
        .text('Size', pageLeft + 175, tHeadY + 5, { width: 65 })
        .text('Live Rows', pageLeft + 244, tHeadY + 5, { width: 68 })
        .text('Dead Rows', pageLeft + 316, tHeadY + 5, { width: 68 })
        .text('Dead %', pageLeft + 388, tHeadY + 5, { width: 52 })
        .text('Advisory', pageLeft + 444, tHeadY + 5, {
          width: contentWidth - 450,
        });
      doc.y = tHeadY + 21;

      for (const tbl of payload.tableHealth.slice(0, 10)) {
        ensureSpace(18);
        const y = doc.y;
        const fullName = `${tbl.schemaname}.${tbl.relname}`;
        const deadColor =
          tbl.dead_tuple_pct >= 20
            ? COLORS.red
            : tbl.dead_tuple_pct >= 10
              ? COLORS.amber
              : COLORS.slate;
        const advisory =
          tbl.dead_tuple_pct >= 20
            ? 'Run VACUUM ANALYZE'
            : tbl.dead_tuple_pct >= 10
              ? 'Monitor autovacuum'
              : 'Healthy';

        doc
          .font('Courier')
          .fontSize(7.5)
          .fillColor(COLORS.ink)
          .text(sanitizePdfText(fullName, 34), pageLeft + 6, y, { width: 165 })
          .fillColor(COLORS.slate)
          .text(sanitizePdfText(tbl.total_size_pretty, 14), pageLeft + 175, y, {
            width: 65,
          })
          .text(tbl.n_live_tup.toLocaleString(), pageLeft + 244, y, { width: 68 })
          .text(tbl.n_dead_tup.toLocaleString(), pageLeft + 316, y, { width: 68 })
          .fillColor(deadColor)
          .text(`${tbl.dead_tuple_pct.toFixed(1)}%`, pageLeft + 388, y, {
            width: 52,
          });
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(deadColor)
          .text(advisory, pageLeft + 444, y, { width: contentWidth - 450 });

        const nextY = y + 14;
        doc
          .moveTo(pageLeft, nextY - 2)
          .lineTo(pageRight, nextY - 2)
          .lineWidth(0.4)
          .strokeColor(COLORS.hairline)
          .stroke();
        doc.y = nextY + 2;
      }
      doc.moveDown(0.5);
    } else {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLORS.muted)
        .text(
          'Run an inspection on this target to populate per-table vacuum and storage health metrics.',
          pageLeft,
          doc.y
        );
      doc.moveDown(0.5);
    }

    if (payload.unusedIndexes.length > 0) {
      ensureSpace(36);
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(COLORS.amber)
        .text(
          `Unused Index Advisory: ${payload.unusedIndexes.length} non-unique index(es) have 0 recorded scans. Review with DROP INDEX CONCURRENTLY:`,
          pageLeft,
          doc.y
        );
      doc.moveDown(0.25);
      for (const idx of payload.unusedIndexes.slice(0, 5)) {
        ensureSpace(14);
        doc
          .font('Courier')
          .fontSize(7.5)
          .fillColor(COLORS.slate)
          .text(
            `- ${idx.schemaname}.${idx.indexname} on ${idx.tablename} (${idx.index_size_pretty})`,
            pageLeft + 8,
            doc.y
          );
      }
    }

    // --- Page Footers ---
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const footerY = doc.page.height - 38;
      doc
        .moveTo(pageLeft, footerY - 6)
        .lineTo(pageRight, footerY - 6)
        .lineWidth(0.5)
        .strokeColor(COLORS.hairline)
        .stroke();
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(COLORS.muted)
        .text(
          `DriftGuard PostgreSQL Health Report  |  ${sanitizePdfText(payload.targetName, 40)}`,
          pageLeft,
          footerY,
          { width: contentWidth / 2 }
        );
      doc
        .font('Courier')
        .fontSize(7.5)
        .fillColor(COLORS.muted)
        .text(
          `Page ${i + 1} of ${range.count}`,
          pageLeft,
          footerY,
          { width: contentWidth, align: 'right' }
        );
    }

    doc.end();
  });
}
