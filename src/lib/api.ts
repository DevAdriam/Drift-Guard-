import type {
  ActivityHeatmapResponse,
  AlertWebhookDto,
  ApiKeyDto,
  AuditLogDto,
  CapacityPlanningResponse,
  ColumnCatalogRow,
  ColumnDiffItem,
  ConnectionMode,
  DatabaseTimelineResponse,
  EnvironmentCompareResult,
  EnvironmentType,
  ExplainPlanAnalysisResponse,
  HealthThresholdEvaluationResponse,
  HealthTrendsResponse,
  IncidentStatus,
  IncidentType,
  IndexAdvisorResponse,
  LiveLockContentionResponse,
  MigrationCheckDto,
  MonitoredDatabaseDto,
  PerformanceTrendsResponse,
  QueryPerformanceResponse,
  SchemaBaselineDto,
  SeverityLevel,
  TargetHealthThresholdDto,
  TelemetryIncidentDto,
  TelemetrySnapshotDto,
  WebhookProvider,
  WorkspaceSettingsDto,
} from '../types/telemetry.ts';

export interface DatabaseDetailResponse {
  database: Omit<
    MonitoredDatabaseDto,
    'latestBaseline' | 'openIncidentsCount' | 'criticalIncidentsCount'
  >;
  baselines: SchemaBaselineDto[];
  latestSnapshot: TelemetrySnapshotDto | null;
  snapshotHistory: {
    id: string;
    schemaHash: string;
    tableCount: number;
    columnCount: number;
    activeLocksCount: number;
    bloatedIndexesCount: number;
    durationMs: number;
    inspectedAt: string;
  }[];
  liveDiff: ColumnDiffItem[];
  revertToBaselineSql: string;
  incidents: TelemetryIncidentDto[];
}

export interface TelemetrySuiteResponse {
  provisioningSql: string;
  catalogQuery: string;
  lockTreeQuery: string;
  indexBloatQuery: string;
  tableHealthQuery: string;
  unusedIndexesQuery: string;
  databaseHealthQuery: string;
  topExpensiveQueriesQuery: string;
  capacityBloatQuery: string;
}

export class ApiClient {
  private getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.getToken = getToken;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof data.error === 'string'
          ? data.error
          : `Request failed with status ${res.status}`
      );
    }
    return data as T;
  }

  listDatabases() {
    return this.request<{ databases: MonitoredDatabaseDto[] }>('/api/databases');
  }

  getActivityHeatmap() {
    const tzOffsetMinutes = new Date().getTimezoneOffset();
    const qs = new URLSearchParams({
      tzOffsetMinutes: String(tzOffsetMinutes),
    }).toString();
    return this.request<ActivityHeatmapResponse>(
      `/api/dashboard/activity-heatmap?${qs}`
    );
  }

  createDatabase(payload: {
    name: string;
    environment: EnvironmentType;
    connectionMode: ConnectionMode;
    connectionUrl?: string;
    pollIntervalSeconds: number;
    gitCommitSha?: string;
    autoCaptureBaseline?: boolean;
  }) {
    return this.request<{ database: MonitoredDatabaseDto }>('/api/databases', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  updateDatabase(
    id: string,
    payload: {
      isActive?: boolean;
      pollIntervalSeconds?: number;
      name?: string;
      connectionUrl?: string;
    }
  ) {
    return this.request<{ database: MonitoredDatabaseDto }>(
      `/api/databases/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }
    );
  }

  deleteDatabase(id: string) {
    return this.request<{ ok: boolean }>(`/api/databases/${id}`, {
      method: 'DELETE',
    });
  }

  getDatabaseDetail(id: string) {
    return this.request<DatabaseDetailResponse>(`/api/databases/${id}`);
  }

  getDatabaseTimeline(id: string) {
    return this.request<DatabaseTimelineResponse>(
      `/api/databases/${id}/timeline`
    );
  }

  async downloadHealthReport(
    id: string
  ): Promise<{ blob: Blob; filename: string }> {
    const token = await this.getToken();
    const res = await fetch(`/api/databases/${id}/health-report`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(
        typeof data.error === 'string'
          ? data.error
          : `Failed to generate PDF report (HTTP ${res.status})`
      );
    }
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] ?? 'driftguard-health-report.pdf';
    const blob = await res.blob();
    return { blob, filename };
  }

  inspectDatabase(id: string) {
    return this.request<{
      snapshot: TelemetrySnapshotDto;
      healthStatus: string;
      newIncidentsCount: number;
    }>(`/api/databases/${id}/inspect`, {
      method: 'POST',
    });
  }

  inspectAllDatabases() {
    return this.request<{
      scannedCount: number;
      succeededCount: number;
      failedCount: number;
      results: {
        databaseId: string;
        name: string;
        ok: boolean;
        healthStatus?: string;
        newIncidentsCount?: number;
        error?: string;
      }[];
    }>('/api/databases/inspect-all', { method: 'POST' });
  }

  bulkInspectDatabases(databaseIds: string[]) {
    return this.request<{
      scannedCount: number;
      succeededCount: number;
      failedCount: number;
      results: {
        databaseId: string;
        name: string;
        ok: boolean;
        healthStatus?: string;
        newIncidentsCount?: number;
        error?: string;
      }[];
    }>('/api/databases/bulk-inspect', {
      method: 'POST',
      body: JSON.stringify({ databaseIds }),
    });
  }

  bulkDeleteDatabases(databaseIds: string[]) {
    return this.request<{
      deletedCount: number;
      deletedIds: string[];
      deletedNames: string[];
    }>('/api/databases/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ databaseIds }),
    });
  }

  captureBaseline(
    id: string,
    payload: { gitCommitSha?: string; customCatalog?: ColumnCatalogRow[] }
  ) {
    return this.request<{ baseline: SchemaBaselineDto }>(
      `/api/databases/${id}/baselines`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  }

  restoreBaseline(databaseId: string, baselineId: string) {
    return this.request<{ baseline: SchemaBaselineDto }>(
      `/api/databases/${databaseId}/baselines/${baselineId}/restore`,
      { method: 'POST' }
    );
  }

  compareHistoricalBaselines(
    databaseId: string,
    fromId: string,
    toId: string
  ) {
    const qs = new URLSearchParams({ from: fromId, to: toId }).toString();
    return this.request<{
      fromHash: string;
      toHash: string;
      diffs: ColumnDiffItem[];
      syncSql: string;
    }>(`/api/databases/${databaseId}/compare-baselines?${qs}`);
  }

  runDrill(id: string, scenario: 'drift' | 'lock' | 'bloat') {
    return this.request<{ incident: unknown }>(`/api/databases/${id}/drill`, {
      method: 'POST',
      body: JSON.stringify({ scenario }),
    });
  }

  compareEnvironments(sourceDatabaseId: string, targetDatabaseId: string) {
    return this.request<EnvironmentCompareResult>('/api/compare', {
      method: 'POST',
      body: JSON.stringify({ sourceDatabaseId, targetDatabaseId }),
    });
  }

  listMigrationChecks() {
    return this.request<{ checks: MigrationCheckDto[] }>('/api/migrations');
  }

  analyzeMigration(payload: {
    title: string;
    sqlText: string;
    databaseId?: string;
  }) {
    return this.request<{ check: MigrationCheckDto }>(
      '/api/migrations/analyze',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  }

  deleteMigrationCheck(id: string) {
    return this.request<{ ok: boolean }>(`/api/migrations/${id}`, {
      method: 'DELETE',
    });
  }

  listIncidents(filters?: {
    status?: IncidentStatus;
    type?: IncidentType;
    databaseId?: string;
  }) {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.type) params.set('type', filters.type);
    if (filters?.databaseId) params.set('databaseId', filters.databaseId);
    const qs = params.toString();
    return this.request<{ incidents: TelemetryIncidentDto[] }>(
      `/api/incidents${qs ? `?${qs}` : ''}`
    );
  }

  updateIncidentStatus(id: string, status: IncidentStatus) {
    return this.request<{ incident: TelemetryIncidentDto }>(
      `/api/incidents/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }
    );
  }

  listWebhooks() {
    return this.request<{ webhooks: AlertWebhookDto[] }>('/api/webhooks');
  }

  createWebhook(payload: {
    name: string;
    provider: WebhookProvider;
    webhookUrl: string;
    minSeverity: SeverityLevel;
  }) {
    return this.request<{ webhook: AlertWebhookDto }>('/api/webhooks', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  toggleWebhook(id: string, isActive: boolean) {
    return this.request<{ webhook: AlertWebhookDto }>(`/api/webhooks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
  }

  deleteWebhook(id: string) {
    return this.request<{ ok: boolean }>(`/api/webhooks/${id}`, {
      method: 'DELETE',
    });
  }

  testWebhook(id: string) {
    return this.request<{ ok: boolean; statusCode: number; message: string }>(
      `/api/webhooks/${id}/test`,
      { method: 'POST' }
    );
  }

  getSettings() {
    return this.request<{ settings: WorkspaceSettingsDto }>('/api/settings');
  }

  updateSettings(payload: Omit<WorkspaceSettingsDto, 'updatedAt'>) {
    return this.request<{ settings: WorkspaceSettingsDto }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  listTargetHealthThresholds() {
    return this.request<{ targets: TargetHealthThresholdDto[] }>(
      '/api/settings/target-thresholds'
    );
  }

  updateTargetHealthThreshold(
    databaseId: string,
    payload: {
      enabled: boolean;
      minHealthScore: number;
      cooldownMinutes: number;
      evaluateImmediately?: boolean;
    }
  ) {
    return this.request<{
      target: TargetHealthThresholdDto | null;
      targets: TargetHealthThresholdDto[];
      evaluation: HealthThresholdEvaluationResponse | null;
    }>(`/api/settings/target-thresholds/${databaseId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  evaluateTargetHealthThresholds(databaseId?: string) {
    return this.request<{
      evaluation: HealthThresholdEvaluationResponse;
      targets: TargetHealthThresholdDto[];
    }>('/api/settings/target-thresholds/evaluate', {
      method: 'POST',
      body: JSON.stringify(databaseId ? { databaseId } : {}),
    });
  }

  listApiKeys() {
    return this.request<{ keys: ApiKeyDto[] }>('/api/api-keys');
  }

  createApiKey(name: string) {
    return this.request<{ key: ApiKeyDto; plaintextKey: string }>(
      '/api/api-keys',
      {
        method: 'POST',
        body: JSON.stringify({ name }),
      }
    );
  }

  deleteApiKey(id: string) {
    return this.request<{ ok: boolean }>(`/api/api-keys/${id}`, {
      method: 'DELETE',
    });
  }

  listAuditLogs() {
    return this.request<{ logs: AuditLogDto[] }>('/api/audit-logs');
  }

  getTelemetrySuite() {
    return this.request<TelemetrySuiteResponse>('/api/telemetry-suite');
  }

  getQueryPerformance(databaseId?: string) {
    const qs = databaseId
      ? `?${new URLSearchParams({ databaseId }).toString()}`
      : '';
    return this.request<QueryPerformanceResponse>(
      `/api/telemetry-suite/performance${qs}`
    );
  }

  getPerformanceTrends(params?: {
    databaseId?: string;
    days?: number;
    capture?: boolean;
  }) {
    const qs = new URLSearchParams();
    if (params?.databaseId) qs.set('databaseId', params.databaseId);
    if (params?.days) qs.set('days', String(params.days));
    if (params?.capture) qs.set('capture', 'true');
    const queryStr = qs.toString();
    return this.request<PerformanceTrendsResponse>(
      `/api/telemetry-suite/performance-trends${queryStr ? `?${queryStr}` : ''}`
    );
  }

  getIndexAdvisor(databaseId?: string) {
    const qs = databaseId
      ? `?${new URLSearchParams({ databaseId }).toString()}`
      : '';
    return this.request<IndexAdvisorResponse>(
      `/api/telemetry-suite/index-advisor${qs}`
    );
  }

  explainQueryPlan(payload: { databaseId?: string; sql: string }) {
    return this.request<ExplainPlanAnalysisResponse>(
      '/api/telemetry-suite/index-advisor/explain',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  }

  getLiveLockContention(databaseId?: string) {
    const qs = databaseId
      ? `?${new URLSearchParams({ databaseId }).toString()}`
      : '';
    return this.request<LiveLockContentionResponse>(
      `/api/telemetry-suite/locks${qs}`
    );
  }

  getCapacityPlanning(databaseId?: string) {
    const qs = databaseId
      ? `?${new URLSearchParams({ databaseId }).toString()}`
      : '';
    return this.request<CapacityPlanningResponse>(
      `/api/telemetry-suite/capacity${qs}`
    );
  }

  getHealthTrends(params?: {
    databaseId?: string;
    windowSize?: number;
    sigmaThreshold?: number;
  }) {
    const qs = new URLSearchParams();
    if (params?.databaseId) qs.set('databaseId', params.databaseId);
    if (params?.windowSize) qs.set('windowSize', String(params.windowSize));
    if (params?.sigmaThreshold) {
      qs.set('sigmaThreshold', String(params.sigmaThreshold));
    }
    const queryStr = qs.toString();
    return this.request<HealthTrendsResponse>(
      `/api/telemetry-suite/trends${queryStr ? `?${queryStr}` : ''}`
    );
  }

  promoteTrendAlert(payload: {
    databaseId: string;
    incidentType: 'VACUUM_HEALTH' | 'INDEX_BLOAT';
    severity: SeverityLevel;
    fingerprint: string;
    summary: string;
    schemaname: string;
    tablename: string;
    indexname?: string;
    n_live_tup?: number;
    n_dead_tup?: number;
    dead_tuple_pct?: number;
    index_bytes?: number;
    index_size_pretty?: string;
    estimated_bloat_pct?: number;
  }) {
    return this.request<{ incidentId: string; alreadyExists: boolean }>(
      '/api/telemetry-suite/trends/promote',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  }
}
