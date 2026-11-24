import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  monitoredDatabases,
  targetHealthThresholds,
  telemetryIncidents,
  telemetrySnapshots,
} from '../db/schema.ts';
import { getWorkspaceSettings, recordAuditLog } from './extendedService.ts';
import { isInActiveMaintenanceWindow } from './governanceService.ts';
import type {
  DatabaseHealthSummary,
  EnvironmentType,
  HealthStatus,
  HealthThresholdEvaluationResponse,
  TargetHealthThresholdDto,
  TargetThresholdEvaluationItem,
  WorkspaceSettingsDto,
} from '../types/telemetry.ts';

export const DEFAULT_MIN_HEALTH_SCORE = 80;
export const DEFAULT_COOLDOWN_MINUTES = 10;

// In-memory lock to prevent concurrent duplicate auto-reinspections for the same target
const activeAutoReinspections = new Set<string>();

export function computeTargetHealthScore(params: {
  lastHealthStatus: HealthStatus;
  hasSchemaDrift: boolean;
  openCriticalCount: number;
  openWarningCount: number;
  openInfoCount: number;
  activeLocksCount: number;
  bloatedIndexesCount: number;
  healthSummary?: DatabaseHealthSummary | null;
  settings?: Pick<
    WorkspaceSettingsDto,
    'cacheHitMinPct' | 'connSaturationPct'
  >;
}): number {
  if (params.lastHealthStatus === 'PENDING') {
    return 100;
  }

  let score = 100;

  if (params.hasSchemaDrift || params.lastHealthStatus === 'DRIFT') {
    score -= 42;
  }

  // Avoid double-penalizing a single open SCHEMA_DRIFT critical incident on top of hasSchemaDrift
  const adjustedCriticalCount =
    params.hasSchemaDrift && params.openCriticalCount > 0
      ? Math.max(0, params.openCriticalCount - 1)
      : params.openCriticalCount;

  score -= adjustedCriticalCount * 26;
  score -= params.openWarningCount * 14;
  score -= params.openInfoCount * 5;

  if (params.activeLocksCount > 0) {
    score -= Math.min(16, params.activeLocksCount * 6);
  }
  if (params.bloatedIndexesCount > 0) {
    score -= Math.min(12, params.bloatedIndexesCount * 3);
  }

  if (params.healthSummary && params.settings) {
    if (
      params.healthSummary.connection_usage_pct >=
      params.settings.connSaturationPct
    ) {
      score -= 10;
    }
    if (
      params.healthSummary.cache_hit_ratio_pct > 0 &&
      params.healthSummary.cache_hit_ratio_pct < params.settings.cacheHitMinPct
    ) {
      score -= 8;
    }
  }

  if (params.lastHealthStatus === 'ERROR') {
    score = Math.min(score, 22);
  }

  return Math.max(5, Math.min(100, Math.round(score)));
}

function computeCooldownState(
  lastAutoReinspectAt: Date | null,
  cooldownMinutes: number,
  nowMs = Date.now()
): { inCooldown: boolean; cooldownRemainingSeconds: number } {
  if (!lastAutoReinspectAt) {
    return { inCooldown: false, cooldownRemainingSeconds: 0 };
  }
  const cooldownMs = cooldownMinutes * 60_000;
  const elapsedMs = nowMs - lastAutoReinspectAt.getTime();
  if (elapsedMs >= cooldownMs) {
    return { inCooldown: false, cooldownRemainingSeconds: 0 };
  }
  return {
    inCooldown: true,
    cooldownRemainingSeconds: Math.max(
      1,
      Math.ceil((cooldownMs - elapsedMs) / 1000)
    ),
  };
}

export async function listTargetHealthThresholds(
  ownerUid: string
): Promise<TargetHealthThresholdDto[]> {
  const [dbs, thresholds, settings] = await Promise.all([
    db
      .select()
      .from(monitoredDatabases)
      .where(eq(monitoredDatabases.ownerUid, ownerUid))
      .orderBy(desc(monitoredDatabases.createdAt)),
    db
      .select()
      .from(targetHealthThresholds)
      .where(eq(targetHealthThresholds.ownerUid, ownerUid)),
    getWorkspaceSettings(ownerUid),
  ]);

  if (dbs.length === 0) return [];

  const dbIds = dbs.map((d) => d.id);

  const [openIncidents, recentSnapshots] = await Promise.all([
    db
      .select({
        databaseId: telemetryIncidents.databaseId,
        incidentType: telemetryIncidents.incidentType,
        severity: telemetryIncidents.severity,
      })
      .from(telemetryIncidents)
      .where(
        and(
          inArray(telemetryIncidents.databaseId, dbIds),
          ne(telemetryIncidents.status, 'RESOLVED')
        )
      ),
    db
      .select({
        databaseId: telemetrySnapshots.databaseId,
        activeLocksCount: telemetrySnapshots.activeLocksCount,
        bloatedIndexesCount: telemetrySnapshots.bloatedIndexesCount,
        healthJson: telemetrySnapshots.healthJson,
        inspectedAt: telemetrySnapshots.inspectedAt,
      })
      .from(telemetrySnapshots)
      .where(inArray(telemetrySnapshots.databaseId, dbIds))
      .orderBy(desc(telemetrySnapshots.inspectedAt)),
  ]);

  const thresholdMap = new Map(thresholds.map((t) => [t.databaseId, t]));

  const latestSnapMap = new Map<
    string,
    {
      activeLocksCount: number;
      bloatedIndexesCount: number;
      healthJson: DatabaseHealthSummary | null;
    }
  >();
  for (const snap of recentSnapshots) {
    if (!latestSnapMap.has(snap.databaseId)) {
      latestSnapMap.set(snap.databaseId, {
        activeLocksCount: snap.activeLocksCount,
        bloatedIndexesCount: snap.bloatedIndexesCount,
        healthJson: snap.healthJson,
      });
    }
  }

  const incidentAcc = new Map<
    string,
    {
      total: number;
      critical: number;
      warning: number;
      info: number;
      hasDrift: boolean;
    }
  >();
  for (const inc of openIncidents) {
    const cur = incidentAcc.get(inc.databaseId) ?? {
      total: 0,
      critical: 0,
      warning: 0,
      info: 0,
      hasDrift: false,
    };
    cur.total += 1;
    if (inc.incidentType === 'SCHEMA_DRIFT') cur.hasDrift = true;
    if (inc.severity === 'CRITICAL') cur.critical += 1;
    else if (inc.severity === 'WARNING') cur.warning += 1;
    else cur.info += 1;
    incidentAcc.set(inc.databaseId, cur);
  }

  const nowMs = Date.now();

  return dbs.map((d) => {
    const policy = thresholdMap.get(d.id);
    const snap = latestSnapMap.get(d.id);
    const inc = incidentAcc.get(d.id) ?? {
      total: 0,
      critical: 0,
      warning: 0,
      info: 0,
      hasDrift: false,
    };
    const lastStatus = d.lastHealthStatus as HealthStatus;

    const currentHealthScore = computeTargetHealthScore({
      lastHealthStatus: lastStatus,
      hasSchemaDrift: inc.hasDrift || lastStatus === 'DRIFT',
      openCriticalCount: inc.critical,
      openWarningCount: inc.warning,
      openInfoCount: inc.info,
      activeLocksCount: snap?.activeLocksCount ?? 0,
      bloatedIndexesCount: snap?.bloatedIndexesCount ?? 0,
      healthSummary: snap?.healthJson ?? null,
      settings,
    });

    const enabled = policy?.enabled ?? false;
    const minHealthScore = policy?.minHealthScore ?? DEFAULT_MIN_HEALTH_SCORE;
    const cooldownMinutes = policy?.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES;
    const { inCooldown, cooldownRemainingSeconds } = computeCooldownState(
      policy?.lastAutoReinspectAt ?? null,
      cooldownMinutes,
      nowMs
    );

    const isBreached =
      enabled && lastStatus !== 'PENDING' && currentHealthScore < minHealthScore;

    return {
      databaseId: d.id,
      databaseName: d.name,
      environment: d.environment as EnvironmentType,
      isActive: d.isActive,
      lastHealthStatus: lastStatus,
      lastPolledAt: d.lastPolledAt ? d.lastPolledAt.toISOString() : null,
      openIncidentsCount: inc.total,
      criticalIncidentsCount: inc.critical,
      currentHealthScore,
      enabled,
      minHealthScore,
      cooldownMinutes,
      lastEvaluatedScore: policy?.lastEvaluatedScore ?? null,
      lastBreachAt: policy?.lastBreachAt
        ? policy.lastBreachAt.toISOString()
        : null,
      lastAutoReinspectAt: policy?.lastAutoReinspectAt
        ? policy.lastAutoReinspectAt.toISOString()
        : null,
      autoReinspectCount: policy?.autoReinspectCount ?? 0,
      isBreached,
      inCooldown,
      cooldownRemainingSeconds,
      updatedAt: policy?.updatedAt ? policy.updatedAt.toISOString() : null,
    };
  });
}

export async function upsertTargetHealthThreshold(
  ownerUid: string,
  actorEmail: string,
  databaseId: string,
  input: {
    enabled: boolean;
    minHealthScore: number;
    cooldownMinutes: number;
  }
): Promise<{
  targetName: string;
  policy: typeof targetHealthThresholds.$inferSelect;
}> {
  const owned = await db
    .select({
      id: monitoredDatabases.id,
      name: monitoredDatabases.name,
    })
    .from(monitoredDatabases)
    .where(
      and(
        eq(monitoredDatabases.id, databaseId),
        eq(monitoredDatabases.ownerUid, ownerUid)
      )
    )
    .limit(1);

  if (owned.length === 0) {
    throw new Error('Monitored database not found.');
  }

  const targetName = owned[0].name;
  const now = new Date();

  const [saved] = await db
    .insert(targetHealthThresholds)
    .values({
      databaseId,
      ownerUid,
      enabled: input.enabled,
      minHealthScore: input.minHealthScore,
      cooldownMinutes: input.cooldownMinutes,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: targetHealthThresholds.databaseId,
      set: {
        enabled: input.enabled,
        minHealthScore: input.minHealthScore,
        cooldownMinutes: input.cooldownMinutes,
        updatedAt: now,
      },
    })
    .returning();

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'TARGET_THRESHOLD_UPDATED',
    entityType: 'database',
    entityLabel: targetName,
    summary: input.enabled
      ? `Enabled auto re-inspection when health score drops below ${input.minHealthScore}/100 (cooldown: ${input.cooldownMinutes}m).`
      : `Disabled custom health score auto re-inspection rule (min score: ${input.minHealthScore}/100).`,
  });

  return { targetName, policy: saved };
}

export interface PostInspectionThresholdOutcome {
  healthScore: number;
  thresholdEnabled: boolean;
  minHealthScore: number | null;
  breached: boolean;
  autoReinspectTriggered: boolean;
  skippedReason?:
    | 'cooldown'
    | 'in_progress'
    | 'auto_reinspect_pass'
    | 'maintenance_window';
}

/**
 * Evaluates a target's custom health score threshold right after an inspection finishes.
 * Uses `isAutoReinspect` and an in-memory lock + persistent cooldown window to guarantee
 * zero infinite inspection loops.
 */
export async function handlePostInspectionThresholdCheck(params: {
  ownerUid: string;
  databaseId: string;
  databaseName: string;
  healthScore: number;
  isAutoReinspect?: boolean;
  triggerFollowUpInspection: (reason: string) => Promise<void>;
}): Promise<PostInspectionThresholdOutcome> {
  const rows = await db
    .select()
    .from(targetHealthThresholds)
    .where(
      and(
        eq(targetHealthThresholds.databaseId, params.databaseId),
        eq(targetHealthThresholds.ownerUid, params.ownerUid)
      )
    )
    .limit(1);

  if (rows.length === 0) {
    return {
      healthScore: params.healthScore,
      thresholdEnabled: false,
      minHealthScore: null,
      breached: false,
      autoReinspectTriggered: false,
    };
  }

  const policy = rows[0];
  const now = new Date();
  const breached =
    policy.enabled && params.healthScore < policy.minHealthScore;

  // Always record the freshly evaluated score
  if (!breached) {
    await db
      .update(targetHealthThresholds)
      .set({
        lastEvaluatedScore: params.healthScore,
      })
      .where(eq(targetHealthThresholds.databaseId, params.databaseId));

    return {
      healthScore: params.healthScore,
      thresholdEnabled: policy.enabled,
      minHealthScore: policy.minHealthScore,
      breached: false,
      autoReinspectTriggered: false,
    };
  }

  // Prevent recursive auto-reinspection loops
  if (params.isAutoReinspect) {
    await db
      .update(targetHealthThresholds)
      .set({
        lastEvaluatedScore: params.healthScore,
        lastBreachAt: now,
      })
      .where(eq(targetHealthThresholds.databaseId, params.databaseId));

    return {
      healthScore: params.healthScore,
      thresholdEnabled: true,
      minHealthScore: policy.minHealthScore,
      breached: true,
      autoReinspectTriggered: false,
      skippedReason: 'auto_reinspect_pass',
    };
  }

  const { inCooldown } = computeCooldownState(
    policy.lastAutoReinspectAt,
    policy.cooldownMinutes,
    now.getTime()
  );

  if (inCooldown) {
    await db
      .update(targetHealthThresholds)
      .set({
        lastEvaluatedScore: params.healthScore,
        lastBreachAt: now,
      })
      .where(eq(targetHealthThresholds.databaseId, params.databaseId));

    return {
      healthScore: params.healthScore,
      thresholdEnabled: true,
      minHealthScore: policy.minHealthScore,
      breached: true,
      autoReinspectTriggered: false,
      skippedReason: 'cooldown',
    };
  }

  if (activeAutoReinspections.has(params.databaseId)) {
    return {
      healthScore: params.healthScore,
      thresholdEnabled: true,
      minHealthScore: policy.minHealthScore,
      breached: true,
      autoReinspectTriggered: false,
      skippedReason: 'in_progress',
    };
  }

  const maintCheck = await isInActiveMaintenanceWindow(params.ownerUid, {
    databaseId: params.databaseId,
    checkType: 'auto_reinspect',
  });
  if (maintCheck.suppressed) {
    await db
      .update(targetHealthThresholds)
      .set({
        lastEvaluatedScore: params.healthScore,
        lastBreachAt: now,
      })
      .where(eq(targetHealthThresholds.databaseId, params.databaseId));

    return {
      healthScore: params.healthScore,
      thresholdEnabled: true,
      minHealthScore: policy.minHealthScore,
      breached: true,
      autoReinspectTriggered: false,
      skippedReason: 'maintenance_window',
    };
  }

  activeAutoReinspections.add(params.databaseId);

  try {
    await db
      .update(targetHealthThresholds)
      .set({
        lastEvaluatedScore: params.healthScore,
        lastBreachAt: now,
        lastAutoReinspectAt: now,
        autoReinspectCount: policy.autoReinspectCount + 1,
      })
      .where(eq(targetHealthThresholds.databaseId, params.databaseId));

    const reason = `Health score ${params.healthScore}/100 breached custom threshold (< ${policy.minHealthScore}/100)`;

    await recordAuditLog({
      ownerUid: params.ownerUid,
      actorEmail: 'system:auto-reinspect',
      action: 'AUTO_REINSPECT_TRIGGERED',
      entityType: 'database',
      entityLabel: params.databaseName,
      summary: `${reason}. Triggered automatic verification re-inspection (cooldown ${policy.cooldownMinutes}m).`,
    });

    await params.triggerFollowUpInspection(reason);

    return {
      healthScore: params.healthScore,
      thresholdEnabled: true,
      minHealthScore: policy.minHealthScore,
      breached: true,
      autoReinspectTriggered: true,
    };
  } catch (err) {
    console.error(
      `Automatic re-inspection failed for ${params.databaseName}:`,
      err
    );
    return {
      healthScore: params.healthScore,
      thresholdEnabled: true,
      minHealthScore: policy.minHealthScore,
      breached: true,
      autoReinspectTriggered: false,
    };
  } finally {
    activeAutoReinspections.delete(params.databaseId);
  }
}

export async function evaluateOwnerHealthThresholds(
  ownerUid: string,
  actorEmail: string,
  runInspection: (
    ownerUid: string,
    databaseId: string,
    actorEmail: string,
    options: { isAutoReinspect: boolean }
  ) => Promise<{
    healthStatus: HealthStatus;
    healthScore: number;
    newIncidentsCount: number;
  }>,
  options?: { databaseId?: string }
): Promise<HealthThresholdEvaluationResponse> {
  const allTargets = await listTargetHealthThresholds(ownerUid);
  const targets = options?.databaseId
    ? allTargets.filter((t) => t.databaseId === options.databaseId)
    : allTargets.filter((t) => t.enabled);

  const results: TargetThresholdEvaluationItem[] = [];
  let breachedCount = 0;
  let triggeredCount = 0;
  let cooldownSkippedCount = 0;

  for (const target of targets) {
    if (!target.enabled) {
      results.push({
        databaseId: target.databaseId,
        databaseName: target.databaseName,
        previousScore: target.currentHealthScore,
        newScore: null,
        minHealthScore: target.minHealthScore,
        breached: false,
        triggered: false,
        skippedReason: 'disabled',
      });
      continue;
    }

    if (!target.isActive) {
      results.push({
        databaseId: target.databaseId,
        databaseName: target.databaseName,
        previousScore: target.currentHealthScore,
        newScore: null,
        minHealthScore: target.minHealthScore,
        breached: target.currentHealthScore < target.minHealthScore,
        triggered: false,
        skippedReason: 'inactive',
      });
      continue;
    }

    const breached = target.currentHealthScore < target.minHealthScore;
    if (!breached) {
      await db
        .update(targetHealthThresholds)
        .set({ lastEvaluatedScore: target.currentHealthScore })
        .where(eq(targetHealthThresholds.databaseId, target.databaseId));

      results.push({
        databaseId: target.databaseId,
        databaseName: target.databaseName,
        previousScore: target.currentHealthScore,
        newScore: target.currentHealthScore,
        minHealthScore: target.minHealthScore,
        breached: false,
        triggered: false,
        skippedReason: 'healthy',
      });
      continue;
    }

    breachedCount += 1;

    if (target.inCooldown) {
      cooldownSkippedCount += 1;
      results.push({
        databaseId: target.databaseId,
        databaseName: target.databaseName,
        previousScore: target.currentHealthScore,
        newScore: null,
        minHealthScore: target.minHealthScore,
        breached: true,
        triggered: false,
        skippedReason: 'cooldown',
      });
      continue;
    }

    if (activeAutoReinspections.has(target.databaseId)) {
      results.push({
        databaseId: target.databaseId,
        databaseName: target.databaseName,
        previousScore: target.currentHealthScore,
        newScore: null,
        minHealthScore: target.minHealthScore,
        breached: true,
        triggered: false,
        skippedReason: 'in_progress',
      });
      continue;
    }

    const maintCheck = await isInActiveMaintenanceWindow(ownerUid, {
      databaseId: target.databaseId,
      environment: target.environment,
      checkType: 'auto_reinspect',
    });
    if (maintCheck.suppressed) {
      results.push({
        databaseId: target.databaseId,
        databaseName: target.databaseName,
        previousScore: target.currentHealthScore,
        newScore: null,
        minHealthScore: target.minHealthScore,
        breached: true,
        triggered: false,
        skippedReason: 'maintenance_window',
      });
      continue;
    }

    activeAutoReinspections.add(target.databaseId);
    const now = new Date();
    try {
      await db
        .update(targetHealthThresholds)
        .set({
          lastEvaluatedScore: target.currentHealthScore,
          lastBreachAt: now,
          lastAutoReinspectAt: now,
          autoReinspectCount: target.autoReinspectCount + 1,
        })
        .where(eq(targetHealthThresholds.databaseId, target.databaseId));

      await recordAuditLog({
        ownerUid,
        actorEmail,
        action: 'AUTO_REINSPECT_TRIGGERED',
        entityType: 'database',
        entityLabel: target.databaseName,
        summary: `Health score ${target.currentHealthScore}/100 breached threshold (< ${target.minHealthScore}/100). Automatic re-inspection triggered.`,
      });

      const outcome = await runInspection(
        ownerUid,
        target.databaseId,
        'system:auto-reinspect',
        { isAutoReinspect: true }
      );

      triggeredCount += 1;
      results.push({
        databaseId: target.databaseId,
        databaseName: target.databaseName,
        previousScore: target.currentHealthScore,
        newScore: outcome.healthScore,
        minHealthScore: target.minHealthScore,
        breached: true,
        triggered: true,
        newHealthStatus: outcome.healthStatus,
        newIncidentsCount: outcome.newIncidentsCount,
      });
    } catch (err) {
      results.push({
        databaseId: target.databaseId,
        databaseName: target.databaseName,
        previousScore: target.currentHealthScore,
        newScore: null,
        minHealthScore: target.minHealthScore,
        breached: true,
        triggered: false,
        error: err instanceof Error ? err.message : 'Auto re-inspection failed',
      });
    } finally {
      activeAutoReinspections.delete(target.databaseId);
    }
  }

  return {
    evaluatedCount: targets.length,
    breachedCount,
    triggeredCount,
    cooldownSkippedCount,
    results,
  };
}

let watcherInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Lightweight background watcher that periodically checks enabled per-target health
 * thresholds across active databases and triggers automatic re-inspections when a
 * score breach persists past the target's cooldown window.
 */
export function startHealthThresholdWatcher(
  runInspection: (
    ownerUid: string,
    databaseId: string,
    actorEmail: string,
    options: { isAutoReinspect: boolean }
  ) => Promise<{
    healthStatus: HealthStatus;
    healthScore: number;
    newIncidentsCount: number;
  }>,
  intervalMs = 60_000
) {
  if (watcherInterval) return;

  watcherInterval = setInterval(async () => {
    try {
      const enabledPolicies = await db
        .select({ ownerUid: targetHealthThresholds.ownerUid })
        .from(targetHealthThresholds)
        .where(eq(targetHealthThresholds.enabled, true));

      const uniqueOwners = Array.from(
        new Set(
          enabledPolicies
            .map((p) => p.ownerUid)
            .filter((uid) => uid !== 'demo_driftguard_workspace')
        )
      );

      for (const ownerUid of uniqueOwners) {
        await evaluateOwnerHealthThresholds(
          ownerUid,
          'system:auto-reinspect',
          runInspection
        ).catch((err) => {
          console.error('Background threshold watcher error:', err);
        });
      }
    } catch (err) {
      console.error('Health threshold watcher sweep failed:', err);
    }
  }, intervalMs);

  watcherInterval.unref();
}
