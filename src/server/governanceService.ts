import PDFDocument from 'pdfkit';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  baselineApprovalRequests,
  maintenanceWindows,
  monitoredDatabases,
  schemaBaselines,
  teamMembers,
  telemetryIncidents,
  telemetrySnapshots,
  users,
} from '../db/schema.ts';
import { SchemaInspector, formatBytesPretty } from './inspector.ts';
import { computeTargetHealthScore } from './healthThresholdService.ts';
import { recordAuditLog } from './extendedService.ts';
import type {
  BaselineApprovalRequestDto,
  EnvironmentType,
  ExecutiveDigestResponse,
  ExecutiveTargetScorecard,
  HealthStatus,
  IncidentType,
  MaintenanceWindowDto,
  TeamMemberDto,
  WorkspaceRole,
} from '../types/telemetry.ts';

// ---------------------------------------------------------------------------
// 6. MAINTENANCE WINDOWS & ALERT SILENCING SCHEDULES
// ---------------------------------------------------------------------------

export function isTimestampInsideWindow(
  win: {
    dayOfWeek: number;
    startTimeUtc: string;
    durationMinutes: number;
    isActive: boolean;
  },
  now = new Date()
): boolean {
  if (!win.isActive) return false;
  const parts = win.startTimeUtc.split(':');
  const startHour = Number(parts[0]);
  const startMin = Number(parts[1]);
  if (!Number.isFinite(startHour) || !Number.isFinite(startMin)) return false;

  const startMinuteOfDay = startHour * 60 + startMin;
  const nowMinuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const nowDow = now.getUTCDay();

  const checkDay = (dowOffset: number) => {
    const checkDow = (nowDow - dowOffset + 7) % 7;
    if (win.dayOfWeek !== -1 && win.dayOfWeek !== checkDow) return false;
    const elapsed =
      dowOffset === 0
        ? nowMinuteOfDay - startMinuteOfDay
        : 1440 - startMinuteOfDay + nowMinuteOfDay;
    return elapsed >= 0 && elapsed < win.durationMinutes;
  };

  return checkDay(0) || checkDay(1);
}

export async function isInActiveMaintenanceWindow(
  ownerUid: string,
  options: {
    databaseId?: string | null;
    environment?: string | null;
    checkType: 'webhook' | 'auto_reinspect';
  }
): Promise<{ suppressed: boolean; windowTitle?: string }> {
  try {
    const rows = await db
      .select()
      .from(maintenanceWindows)
      .where(
        and(
          eq(maintenanceWindows.ownerUid, ownerUid),
          eq(maintenanceWindows.isActive, true)
        )
      );

    const now = new Date();
    for (const w of rows) {
      if (options.checkType === 'webhook' && !w.suppressWebhooks) continue;
      if (options.checkType === 'auto_reinspect' && !w.suppressAutoReinspect) {
        continue;
      }
      if (w.databaseId && options.databaseId && w.databaseId !== options.databaseId) {
        continue;
      }
      if (
        !w.databaseId &&
        w.environment !== 'all' &&
        options.environment &&
        w.environment !== options.environment
      ) {
        continue;
      }
      if (isTimestampInsideWindow(w, now)) {
        return { suppressed: true, windowTitle: w.title };
      }
    }
  } catch {
    // Non-blocking fallback
  }
  return { suppressed: false };
}

export async function listMaintenanceWindows(
  ownerUid: string
): Promise<MaintenanceWindowDto[]> {
  const [windows, dbs] = await Promise.all([
    db
      .select()
      .from(maintenanceWindows)
      .where(eq(maintenanceWindows.ownerUid, ownerUid))
      .orderBy(desc(maintenanceWindows.createdAt)),
    db
      .select({ id: monitoredDatabases.id, name: monitoredDatabases.name })
      .from(monitoredDatabases)
      .where(eq(monitoredDatabases.ownerUid, ownerUid)),
  ]);
  const dbNameMap = new Map(dbs.map((d) => [d.id, d.name]));
  const now = new Date();

  return windows.map((w) => ({
    id: w.id,
    databaseId: w.databaseId,
    databaseName: w.databaseId ? dbNameMap.get(w.databaseId) ?? null : null,
    environment: w.environment as 'all' | EnvironmentType,
    title: w.title,
    dayOfWeek: w.dayOfWeek,
    startTimeUtc: w.startTimeUtc,
    durationMinutes: w.durationMinutes,
    suppressWebhooks: w.suppressWebhooks,
    suppressAutoReinspect: w.suppressAutoReinspect,
    isActive: w.isActive,
    currentlyInWindow: isTimestampInsideWindow(w, now),
    createdAt: w.createdAt.toISOString(),
  }));
}

export async function createMaintenanceWindow(
  ownerUid: string,
  actorEmail: string,
  input: {
    title: string;
    databaseId?: string | null;
    environment: 'all' | EnvironmentType;
    dayOfWeek: number;
    startTimeUtc: string;
    durationMinutes: number;
    suppressWebhooks: boolean;
    suppressAutoReinspect: boolean;
  }
): Promise<MaintenanceWindowDto> {
  let databaseId: string | null = null;
  if (input.databaseId) {
    const dbRows = await db
      .select({ id: monitoredDatabases.id })
      .from(monitoredDatabases)
      .where(
        and(
          eq(monitoredDatabases.id, input.databaseId),
          eq(monitoredDatabases.ownerUid, ownerUid)
        )
      )
      .limit(1);
    if (!dbRows.length) {
      throw new Error('Target database not found.');
    }
    databaseId = dbRows[0].id;
  }

  const [created] = await db
    .insert(maintenanceWindows)
    .values({
      ownerUid,
      databaseId,
      environment: databaseId ? 'all' : input.environment,
      title: input.title.trim(),
      dayOfWeek: input.dayOfWeek,
      startTimeUtc: input.startTimeUtc,
      durationMinutes: input.durationMinutes,
      suppressWebhooks: input.suppressWebhooks,
      suppressAutoReinspect: input.suppressAutoReinspect,
      isActive: true,
    })
    .returning();

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'MAINTENANCE_WINDOW_CREATED',
    entityType: 'maintenance_window',
    entityLabel: created.title,
    summary: `Scheduled maintenance window "${created.title}" at ${created.startTimeUtc} UTC (${created.durationMinutes}m).`,
  });

  const all = await listMaintenanceWindows(ownerUid);
  return all.find((w) => w.id === created.id)!;
}

export async function toggleMaintenanceWindow(
  ownerUid: string,
  actorEmail: string,
  windowId: string,
  isActive: boolean
): Promise<MaintenanceWindowDto> {
  const updated = await db
    .update(maintenanceWindows)
    .set({ isActive })
    .where(
      and(
        eq(maintenanceWindows.id, windowId),
        eq(maintenanceWindows.ownerUid, ownerUid)
      )
    )
    .returning();

  if (!updated.length) {
    throw new Error('Maintenance window not found.');
  }

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'MAINTENANCE_WINDOW_UPDATED',
    entityType: 'maintenance_window',
    entityLabel: updated[0].title,
    summary: `${isActive ? 'Enabled' : 'Paused'} maintenance window "${updated[0].title}".`,
  });

  const all = await listMaintenanceWindows(ownerUid);
  return all.find((w) => w.id === windowId)!;
}

export async function deleteMaintenanceWindow(
  ownerUid: string,
  actorEmail: string,
  windowId: string
): Promise<void> {
  const deleted = await db
    .delete(maintenanceWindows)
    .where(
      and(
        eq(maintenanceWindows.id, windowId),
        eq(maintenanceWindows.ownerUid, ownerUid)
      )
    )
    .returning();

  if (!deleted.length) {
    throw new Error('Maintenance window not found.');
  }

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'MAINTENANCE_WINDOW_DELETED',
    entityType: 'maintenance_window',
    entityLabel: deleted[0].title,
    summary: `Removed maintenance window "${deleted[0].title}".`,
  });
}

// ---------------------------------------------------------------------------
// 7. TEAM RBAC & BASELINE PROMOTION APPROVALS
// ---------------------------------------------------------------------------

export async function listTeamMembers(
  ownerUid: string
): Promise<TeamMemberDto[]> {
  const [ownerRows, members] = await Promise.all([
    db.select().from(users).where(eq(users.uid, ownerUid)).limit(1),
    db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.ownerUid, ownerUid))
      .orderBy(desc(teamMembers.createdAt)),
  ]);

  const list: TeamMemberDto[] = [];
  if (ownerRows.length > 0) {
    list.push({
      id: `owner:${ownerRows[0].uid}`,
      email: ownerRows[0].email,
      displayName: ownerRows[0].displayName ?? 'Workspace Owner',
      role: 'admin',
      status: 'active',
      invitedBy: 'workspace-owner',
      isOwner: true,
      createdAt: ownerRows[0].createdAt.toISOString(),
    });
  }

  for (const m of members) {
    list.push({
      id: m.id,
      email: m.email,
      displayName: m.displayName,
      role: m.role as WorkspaceRole,
      status: m.status as 'active' | 'invited',
      invitedBy: m.invitedBy,
      isOwner: false,
      createdAt: m.createdAt.toISOString(),
    });
  }

  return list;
}

export async function inviteTeamMember(
  ownerUid: string,
  actorEmail: string,
  input: { email: string; displayName: string; role: WorkspaceRole }
): Promise<TeamMemberDto> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const existing = await db
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.ownerUid, ownerUid),
        eq(teamMembers.email, normalizedEmail)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    throw new Error('A team member with this email is already in your workspace.');
  }

  const [created] = await db
    .insert(teamMembers)
    .values({
      ownerUid,
      email: normalizedEmail,
      displayName: input.displayName.trim(),
      role: input.role,
      status: 'invited',
      invitedBy: actorEmail,
    })
    .returning();

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'TEAM_MEMBER_INVITED',
    entityType: 'team_member',
    entityLabel: created.email,
    summary: `Invited ${created.displayName} (${created.email}) with ${created.role.toUpperCase()} role.`,
  });

  return {
    id: created.id,
    email: created.email,
    displayName: created.displayName,
    role: created.role as WorkspaceRole,
    status: created.status as 'active' | 'invited',
    invitedBy: created.invitedBy,
    isOwner: false,
    createdAt: created.createdAt.toISOString(),
  };
}

export async function updateTeamMemberRole(
  ownerUid: string,
  actorEmail: string,
  memberId: string,
  role: WorkspaceRole
): Promise<TeamMemberDto> {
  const updated = await db
    .update(teamMembers)
    .set({ role })
    .where(and(eq(teamMembers.id, memberId), eq(teamMembers.ownerUid, ownerUid)))
    .returning();

  if (!updated.length) {
    throw new Error('Team member not found.');
  }

  const m = updated[0];
  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'TEAM_ROLE_UPDATED',
    entityType: 'team_member',
    entityLabel: m.email,
    summary: `Updated RBAC role for ${m.displayName} (${m.email}) to ${role.toUpperCase()}.`,
  });

  return {
    id: m.id,
    email: m.email,
    displayName: m.displayName,
    role: m.role as WorkspaceRole,
    status: m.status as 'active' | 'invited',
    invitedBy: m.invitedBy,
    isOwner: false,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function removeTeamMember(
  ownerUid: string,
  actorEmail: string,
  memberId: string
): Promise<void> {
  const deleted = await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.id, memberId), eq(teamMembers.ownerUid, ownerUid)))
    .returning();

  if (!deleted.length) {
    throw new Error('Team member not found.');
  }

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'TEAM_MEMBER_REMOVED',
    entityType: 'team_member',
    entityLabel: deleted[0].email,
    summary: `Revoked workspace access for ${deleted[0].displayName} (${deleted[0].email}).`,
  });
}

export async function listBaselineApprovals(
  ownerUid: string
): Promise<BaselineApprovalRequestDto[]> {
  const [requests, dbs] = await Promise.all([
    db
      .select()
      .from(baselineApprovalRequests)
      .where(eq(baselineApprovalRequests.ownerUid, ownerUid))
      .orderBy(desc(baselineApprovalRequests.createdAt))
      .limit(50),
    db
      .select()
      .from(monitoredDatabases)
      .where(eq(monitoredDatabases.ownerUid, ownerUid)),
  ]);

  const dbMap = new Map(dbs.map((d) => [d.id, d]));
  const dbIds = dbs.map((d) => d.id);
  const allBaselines =
    dbIds.length > 0
      ? await db
          .select()
          .from(schemaBaselines)
          .where(inArray(schemaBaselines.databaseId, dbIds))
          .orderBy(desc(schemaBaselines.createdAt))
      : [];

  const latestBaselineMap = new Map<string, typeof schemaBaselines.$inferSelect>();
  for (const b of allBaselines) {
    if (!latestBaselineMap.has(b.databaseId)) {
      latestBaselineMap.set(b.databaseId, b);
    }
  }

  return requests.map((req) => {
    const target = dbMap.get(req.databaseId);
    const currentBaseline = latestBaselineMap.get(req.databaseId);
    const diffs = currentBaseline
      ? SchemaInspector.diffCatalogs(
          currentBaseline.tablesJson,
          req.proposedCatalogJson
        )
      : [];
    return {
      id: req.id,
      databaseId: req.databaseId,
      databaseName: target?.name ?? 'Unknown Target',
      environment: (target?.environment ?? 'production') as EnvironmentType,
      requestedByEmail: req.requestedByEmail,
      gitCommitSha: req.gitCommitSha,
      proposedSchemaHash: req.proposedSchemaHash,
      currentBaselineHash: currentBaseline?.schemaHash ?? null,
      diffSummary: req.diffSummary,
      addedCount: diffs.filter((d) => d.kind === 'ADDED').length,
      removedCount: diffs.filter((d) => d.kind === 'REMOVED').length,
      modifiedCount: diffs.filter((d) => d.kind === 'MODIFIED').length,
      status: req.status as 'PENDING' | 'APPROVED' | 'REJECTED',
      reviewedByEmail: req.reviewedByEmail,
      reviewNote: req.reviewNote,
      createdAt: req.createdAt.toISOString(),
      reviewedAt: req.reviewedAt ? req.reviewedAt.toISOString() : null,
    };
  });
}

export async function createBaselineApprovalRequest(
  ownerUid: string,
  actorEmail: string,
  input: { databaseId: string; gitCommitSha?: string; note?: string }
): Promise<BaselineApprovalRequestDto> {
  const targetRows = await db
    .select()
    .from(monitoredDatabases)
    .where(
      and(
        eq(monitoredDatabases.id, input.databaseId),
        eq(monitoredDatabases.ownerUid, ownerUid)
      )
    )
    .limit(1);

  if (!targetRows.length) {
    throw new Error('Target database not found.');
  }
  const target = targetRows[0];

  const [latestSnapRows, latestBaselineRows] = await Promise.all([
    db
      .select()
      .from(telemetrySnapshots)
      .where(eq(telemetrySnapshots.databaseId, target.id))
      .orderBy(desc(telemetrySnapshots.inspectedAt))
      .limit(1),
    db
      .select()
      .from(schemaBaselines)
      .where(eq(schemaBaselines.databaseId, target.id))
      .orderBy(desc(schemaBaselines.createdAt))
      .limit(1),
  ]);

  const proposedCatalog =
    latestSnapRows[0]?.catalogJson ?? latestBaselineRows[0]?.tablesJson ?? [];
  if (proposedCatalog.length === 0) {
    throw new Error(
      'Run an inspection on this target before requesting a baseline promotion.'
    );
  }

  const proposedHash = SchemaInspector.computeCanonicalHash(proposedCatalog);
  const diffs = latestBaselineRows[0]
    ? SchemaInspector.diffCatalogs(latestBaselineRows[0].tablesJson, proposedCatalog)
    : [];
  const added = diffs.filter((d) => d.kind === 'ADDED').length;
  const removed = diffs.filter((d) => d.kind === 'REMOVED').length;
  const modified = diffs.filter((d) => d.kind === 'MODIFIED').length;

  const autoSummary =
    diffs.length > 0
      ? `+${added} added, -${removed} removed, ~${modified} modified column(s)`
      : `Promote canonical hash ${proposedHash.slice(0, 12)} (${proposedCatalog.length} columns)`;

  const diffSummary = input.note?.trim()
    ? `${input.note.trim()} (${autoSummary})`
    : autoSummary;

  const [created] = await db
    .insert(baselineApprovalRequests)
    .values({
      ownerUid,
      databaseId: target.id,
      requestedByEmail: actorEmail,
      gitCommitSha: input.gitCommitSha?.trim() || null,
      proposedSchemaHash: proposedHash,
      proposedCatalogJson: proposedCatalog,
      diffSummary,
      status: 'PENDING',
    })
    .returning();

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'BASELINE_APPROVAL_REQUESTED',
    entityType: 'approval_request',
    entityLabel: target.name,
    summary: `Submitted baseline promotion approval request for ${target.name} (${proposedHash.slice(0, 12)}): ${diffSummary}`,
  });

  const all = await listBaselineApprovals(ownerUid);
  return all.find((r) => r.id === created.id)!;
}

export async function reviewBaselineApprovalRequest(
  ownerUid: string,
  actorEmail: string,
  requestId: string,
  decision: 'APPROVED' | 'REJECTED',
  reviewNote?: string
): Promise<BaselineApprovalRequestDto> {
  const rows = await db
    .select()
    .from(baselineApprovalRequests)
    .where(
      and(
        eq(baselineApprovalRequests.id, requestId),
        eq(baselineApprovalRequests.ownerUid, ownerUid)
      )
    )
    .limit(1);

  if (!rows.length) {
    throw new Error('Approval request not found.');
  }
  const reqRow = rows[0];
  if (reqRow.status !== 'PENDING') {
    throw new Error(`Approval request is already ${reqRow.status.toLowerCase()}.`);
  }

  const targetRows = await db
    .select()
    .from(monitoredDatabases)
    .where(
      and(
        eq(monitoredDatabases.id, reqRow.databaseId),
        eq(monitoredDatabases.ownerUid, ownerUid)
      )
    )
    .limit(1);

  if (!targetRows.length) {
    throw new Error('Target database no longer exists.');
  }
  const target = targetRows[0];
  const now = new Date();

  if (decision === 'APPROVED') {
    await db.insert(schemaBaselines).values({
      databaseId: target.id,
      gitCommitSha: reqRow.gitCommitSha,
      schemaHash: reqRow.proposedSchemaHash,
      tablesJson: reqRow.proposedCatalogJson,
    });

    // Resolve any open SCHEMA_DRIFT incidents for this target
    await db
      .update(telemetryIncidents)
      .set({ status: 'RESOLVED', resolvedAt: now })
      .where(
        and(
          eq(telemetryIncidents.databaseId, target.id),
          eq(telemetryIncidents.incidentType, 'SCHEMA_DRIFT'),
          eq(telemetryIncidents.status, 'OPEN')
        )
      );

    // Re-evaluate target health status based on remaining open incidents
    const remainingOpen = await db
      .select()
      .from(telemetryIncidents)
      .where(
        and(
          eq(telemetryIncidents.databaseId, target.id),
          eq(telemetryIncidents.status, 'OPEN')
        )
      );
    const nextHealthStatus: HealthStatus = remainingOpen.some(
      (i) => i.severity === 'CRITICAL'
    )
      ? 'DRIFT'
      : remainingOpen.length > 0
        ? 'WARNING'
        : 'HEALTHY';

    await db
      .update(monitoredDatabases)
      .set({
        lastSchemaHash: reqRow.proposedSchemaHash,
        lastHealthStatus: nextHealthStatus,
      })
      .where(eq(monitoredDatabases.id, target.id));
  }

  await db
    .update(baselineApprovalRequests)
    .set({
      status: decision,
      reviewedByEmail: actorEmail,
      reviewNote: reviewNote?.trim() || null,
      reviewedAt: now,
    })
    .where(eq(baselineApprovalRequests.id, requestId));

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action:
      decision === 'APPROVED'
        ? 'BASELINE_APPROVAL_APPROVED'
        : 'BASELINE_APPROVAL_REJECTED',
    entityType: 'approval_request',
    entityLabel: target.name,
    summary:
      decision === 'APPROVED'
        ? `Approved & promoted baseline ${reqRow.proposedSchemaHash.slice(0, 12)} for ${target.name}.${reviewNote ? ` Note: ${reviewNote.trim()}` : ''}`
        : `Rejected baseline promotion request for ${target.name}.${reviewNote ? ` Reason: ${reviewNote.trim()}` : ''}`,
  });

  const all = await listBaselineApprovals(ownerUid);
  return all.find((r) => r.id === requestId)!;
}

// ---------------------------------------------------------------------------
// 8. SCHEDULED EXECUTIVE HEALTH DIGEST (WEEKLY / MONTHLY REPORT + PDF)
// ---------------------------------------------------------------------------

export async function getExecutiveDigest(
  ownerUid: string,
  periodDays = 7
): Promise<ExecutiveDigestResponse> {
  const clampedDays = periodDays === 30 ? 30 : 7;
  const cutoff = new Date(Date.now() - clampedDays * 24 * 60 * 60 * 1000);

  const dbs = await db
    .select()
    .from(monitoredDatabases)
    .where(eq(monitoredDatabases.ownerUid, ownerUid))
    .orderBy(desc(monitoredDatabases.createdAt));

  if (dbs.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      periodDays: clampedDays,
      fleetSlaPct: 100,
      avgHealthScore: 100,
      totalTargets: 0,
      healthyTargetsCount: 0,
      driftedTargetsCount: 0,
      totalIncidentsInPeriod: 0,
      openIncidentsCount: 0,
      resolvedIncidentsInPeriod: 0,
      avgMttrMinutes: null,
      totalStorageBytes: 0,
      totalStoragePretty: '0 B',
      projected30dGrowthBytes: 0,
      projected30dGrowthPretty: '0 B',
      incidentsByType: [],
      scorecards: [],
      highlights: [],
    };
  }

  const dbIds = dbs.map((d) => d.id);
  const [periodSnaps, periodIncidents, allOpenIncidents] = await Promise.all([
    db
      .select()
      .from(telemetrySnapshots)
      .where(
        and(
          inArray(telemetrySnapshots.databaseId, dbIds),
          gte(telemetrySnapshots.inspectedAt, cutoff)
        )
      )
      .orderBy(desc(telemetrySnapshots.inspectedAt)),
    db
      .select()
      .from(telemetryIncidents)
      .where(
        and(
          inArray(telemetryIncidents.databaseId, dbIds),
          gte(telemetryIncidents.createdAt, cutoff)
        )
      ),
    db
      .select()
      .from(telemetryIncidents)
      .where(
        and(
          inArray(telemetryIncidents.databaseId, dbIds),
          eq(telemetryIncidents.status, 'OPEN')
        )
      ),
  ]);

  const snapsByDb = new Map<string, (typeof telemetrySnapshots.$inferSelect)[]>();
  for (const s of periodSnaps) {
    const arr = snapsByDb.get(s.databaseId) ?? [];
    arr.push(s);
    snapsByDb.set(s.databaseId, arr);
  }

  const periodIncByDb = new Map<string, (typeof telemetryIncidents.$inferSelect)[]>();
  const incTypeCounter = new Map<IncidentType, number>();
  const allMttrSamples: number[] = [];

  for (const inc of periodIncidents) {
    const arr = periodIncByDb.get(inc.databaseId) ?? [];
    arr.push(inc);
    periodIncByDb.set(inc.databaseId, arr);
    const t = inc.incidentType as IncidentType;
    incTypeCounter.set(t, (incTypeCounter.get(t) ?? 0) + 1);
    if (inc.status === 'RESOLVED' && inc.resolvedAt) {
      const mins = Math.max(
        1,
        Math.round((inc.resolvedAt.getTime() - inc.createdAt.getTime()) / 60_000)
      );
      allMttrSamples.push(mins);
    }
  }

  const openIncByDb = new Map<string, (typeof telemetryIncidents.$inferSelect)[]>();
  for (const inc of allOpenIncidents) {
    const arr = openIncByDb.get(inc.databaseId) ?? [];
    arr.push(inc);
    openIncByDb.set(inc.databaseId, arr);
  }

  let totalStorageBytes = 0;
  let projected30dGrowthBytes = 0;
  const scorecards: ExecutiveTargetScorecard[] = [];

  for (const target of dbs) {
    const snaps = snapsByDb.get(target.id) ?? [];
    const latestSnap = snaps[0] ?? null;
    const oldestSnap = snaps[snaps.length - 1] ?? null;
    const openIncs = openIncByDb.get(target.id) ?? [];
    const pIncs = periodIncByDb.get(target.id) ?? [];

    const healthScore = computeTargetHealthScore({
      lastHealthStatus: target.lastHealthStatus as HealthStatus,
      hasSchemaDrift:
        target.lastHealthStatus === 'DRIFT' ||
        openIncs.some((i) => i.incidentType === 'SCHEMA_DRIFT'),
      openCriticalCount: openIncs.filter((i) => i.severity === 'CRITICAL')
        .length,
      openWarningCount: openIncs.filter((i) => i.severity === 'WARNING').length,
      openInfoCount: openIncs.filter((i) => i.severity === 'INFO').length,
      activeLocksCount: latestSnap?.activeLocksCount ?? 0,
      bloatedIndexesCount: latestSnap?.bloatedIndexesCount ?? 0,
      healthSummary: latestSnap?.healthJson ?? null,
    });

    const dbMttrSamples = pIncs
      .filter((i) => i.status === 'RESOLVED' && i.resolvedAt)
      .map((i) =>
        Math.max(
          1,
          Math.round((i.resolvedAt!.getTime() - i.createdAt.getTime()) / 60_000)
        )
      );
    const mttrMinutes =
      dbMttrSamples.length > 0
        ? Math.round(
            dbMttrSamples.reduce((a, b) => a + b, 0) / dbMttrSamples.length
          )
        : null;

    const critPeriod = pIncs.filter((i) => i.severity === 'CRITICAL').length;
    const warnPeriod = pIncs.filter((i) => i.severity === 'WARNING').length;
    const slaPenalty = critPeriod * 0.45 + warnPeriod * 0.15;
    const slaAvailabilityPct = Math.max(
      92.0,
      Math.round((100 - slaPenalty) * 100) / 100
    );

    const dbBytes = latestSnap?.healthJson?.database_size_bytes ?? 0;
    totalStorageBytes += dbBytes;

    // Estimate 30-day storage growth from snapshot delta or dead-tuple churn heuristic
    let est30dGrowth = 0;
    if (
      latestSnap?.healthJson?.database_size_bytes &&
      oldestSnap?.healthJson?.database_size_bytes &&
      latestSnap.id !== oldestSnap.id
    ) {
      const spanDays = Math.max(
        0.5,
        (latestSnap.inspectedAt.getTime() - oldestSnap.inspectedAt.getTime()) /
          (24 * 60 * 60 * 1000)
      );
      const byteDelta =
        latestSnap.healthJson.database_size_bytes -
        oldestSnap.healthJson.database_size_bytes;
      if (byteDelta > 0) {
        est30dGrowth = Math.round((byteDelta / spanDays) * 30);
      }
    }
    if (est30dGrowth === 0 && dbBytes > 0) {
      // Conservative 8% monthly baseline growth estimate if single snapshot
      est30dGrowth = Math.round(dbBytes * 0.08);
    }
    projected30dGrowthBytes += est30dGrowth;

    scorecards.push({
      databaseId: target.id,
      name: target.name,
      environment: target.environment as EnvironmentType,
      healthStatus: target.lastHealthStatus as HealthStatus,
      healthScore,
      slaAvailabilityPct,
      inspectionsCount: snaps.length,
      openIncidentsCount: openIncs.length,
      resolvedIncidentsCount: pIncs.filter((i) => i.status === 'RESOLVED').length,
      driftEventsCount: pIncs.filter((i) => i.incidentType === 'SCHEMA_DRIFT')
        .length,
      mttrMinutes,
      databaseSizePretty:
        latestSnap?.healthJson?.database_size_pretty ?? formatBytesPretty(dbBytes),
      databaseSizeBytes: dbBytes,
      cacheHitRatioPct: latestSnap?.healthJson?.cache_hit_ratio_pct ?? null,
      connectionUsagePct: latestSnap?.healthJson?.connection_usage_pct ?? null,
    });
  }

  const fleetSlaPct =
    Math.round(
      (scorecards.reduce((s, c) => s + c.slaAvailabilityPct, 0) /
        scorecards.length) *
        100
    ) / 100;
  const avgHealthScore = Math.round(
    scorecards.reduce((s, c) => s + c.healthScore, 0) / scorecards.length
  );
  const avgMttrMinutes =
    allMttrSamples.length > 0
      ? Math.round(
          allMttrSamples.reduce((a, b) => a + b, 0) / allMttrSamples.length
        )
      : null;

  const healthyTargetsCount = scorecards.filter(
    (s) => s.healthStatus === 'HEALTHY'
  ).length;
  const driftedTargetsCount = scorecards.filter(
    (s) => s.healthStatus === 'DRIFT'
  ).length;

  const highlights: ExecutiveDigestResponse['highlights'] = [];
  if (driftedTargetsCount > 0) {
    const names = scorecards
      .filter((s) => s.healthStatus === 'DRIFT')
      .map((s) => s.name)
      .join(', ');
    highlights.push({
      severity: 'CRITICAL',
      message: `${driftedTargetsCount} target(s) have unresolved schema drift (${names}). Review and promote or reconcile baseline immediately.`,
    });
  }
  const lowScoreTargets = scorecards.filter((s) => s.healthScore < 75);
  if (lowScoreTargets.length > 0) {
    highlights.push({
      severity: 'WARNING',
      message: `${lowScoreTargets.length} database(s) scored below 75/100 health (${lowScoreTargets
        .map((t) => `${t.name}: ${t.healthScore}`)
        .join(', ')}).`,
    });
  }
  if (totalStorageBytes > 0) {
    highlights.push({
      severity: 'INFO',
      message: `Fleet storage stands at ${formatBytesPretty(totalStorageBytes)} with an estimated +${formatBytesPretty(projected30dGrowthBytes)} 30-day growth trajectory.`,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    periodDays: clampedDays,
    fleetSlaPct,
    avgHealthScore,
    totalTargets: dbs.length,
    healthyTargetsCount,
    driftedTargetsCount,
    totalIncidentsInPeriod: periodIncidents.length,
    openIncidentsCount: allOpenIncidents.length,
    resolvedIncidentsInPeriod: periodIncidents.filter(
      (i) => i.status === 'RESOLVED'
    ).length,
    avgMttrMinutes,
    totalStorageBytes,
    totalStoragePretty: formatBytesPretty(totalStorageBytes),
    projected30dGrowthBytes,
    projected30dGrowthPretty: formatBytesPretty(projected30dGrowthBytes),
    incidentsByType: Array.from(incTypeCounter.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    scorecards,
    highlights,
  };
}

function cleanPdfText(value: unknown, maxLen = 180): string {
  const cleaned = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= maxLen
    ? cleaned
    : `${cleaned.slice(0, maxLen - 3)}...`;
}

export async function generateExecutiveDigestPdf(
  ownerUid: string,
  actorEmail: string,
  periodDays = 7
): Promise<{ filename: string; buffer: Buffer }> {
  const digest = await getExecutiveDigest(ownerUid, periodDays);

  await recordAuditLog({
    ownerUid,
    actorEmail,
    action: 'EXECUTIVE_DIGEST_EXPORTED',
    entityType: 'report',
    entityLabel: `${digest.periodDays}d Executive Digest`,
    summary: `Generated ${digest.periodDays}-day fleet executive PDF digest (${digest.totalTargets} targets, ${digest.fleetSlaPct}% SLA).`,
  });

  const doc = new PDFDocument({ size: 'A4', margin: 44 });
  const chunks: Buffer[] = [];

  const bufferPromise = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor('#0F172A')
    .text('DriftGuard Executive Fleet Health Digest');
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#475569')
    .text(
      `Reporting Window: Last ${digest.periodDays} Days  |  Generated: ${digest.generatedAt.slice(0, 16).replace('T', ' ')} UTC`
    );

  doc.moveDown(1.2);
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#0F172A')
    .text('Fleet KPI Summary');
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(10).fillColor('#1E293B');
  doc.text(`• Fleet SLA Availability: ${digest.fleetSlaPct.toFixed(2)}%`);
  doc.text(
    `• Average Health Score: ${digest.avgHealthScore}/100 (${digest.healthyTargetsCount}/${digest.totalTargets} targets nominal)`
  );
  doc.text(
    `• Incidents (${digest.periodDays}d): ${digest.totalIncidentsInPeriod} total, ${digest.openIncidentsCount} open, ${digest.resolvedIncidentsInPeriod} resolved`
  );
  doc.text(
    `• Mean Time to Resolve (MTTR): ${digest.avgMttrMinutes !== null ? `${digest.avgMttrMinutes} minutes` : 'N/A (no resolved incidents in window)'}`
  );
  doc.text(
    `• Total Fleet Storage: ${digest.totalStoragePretty} (Projected 30d Growth: +${digest.projected30dGrowthPretty})`
  );

  if (digest.highlights.length > 0) {
    doc.moveDown(1);
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor('#0F172A')
      .text('Executive Highlights');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
    for (const h of digest.highlights) {
      doc.text(`[${h.severity}] ${cleanPdfText(h.message, 220)}`);
      doc.moveDown(0.25);
    }
  }

  doc.moveDown(0.8);
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#0F172A')
    .text('Per-Database SLA & Health Scorecard');
  doc.moveDown(0.4);

  for (const row of digest.scorecards) {
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#0F172A')
      .text(
        `${cleanPdfText(row.name, 48)} (${row.environment.toUpperCase()}) — ${row.healthStatus}`
      );
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor('#475569')
      .text(
        `   Score: ${row.healthScore}/100  |  SLA: ${row.slaAvailabilityPct.toFixed(2)}%  |  Open Alerts: ${row.openIncidentsCount}  |  Size: ${row.databaseSizePretty}  |  Cache Hit: ${row.cacheHitRatioPct ?? 'N/A'}%`
      );
    doc.moveDown(0.35);
  }

  doc.end();
  const buffer = await bufferPromise;
  const dateStamp = new Date().toISOString().slice(0, 10);
  return {
    filename: `driftguard-executive-digest-${digest.periodDays}d-${dateStamp}.pdf`,
    buffer,
  };
}
