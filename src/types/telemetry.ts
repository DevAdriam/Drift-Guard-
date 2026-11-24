export type EnvironmentType = 'production' | 'staging' | 'development';
export type ConnectionMode = 'external' | 'workspace_pg';
export type IncidentType =
  | 'SCHEMA_DRIFT'
  | 'LOCK_CONTENTION'
  | 'INDEX_BLOAT'
  | 'VACUUM_HEALTH'
  | 'CONNECTION_SATURATION';
export type SeverityLevel = 'INFO' | 'WARNING' | 'CRITICAL';
export type IncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
export type HealthStatus = 'HEALTHY' | 'DRIFT' | 'WARNING' | 'ERROR' | 'PENDING';
export type WebhookProvider = 'slack' | 'discord' | 'webhook';

export interface ColumnCatalogRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  ordinal_position?: number;
  column_default: string | null;
  is_nullable: string;
  data_type: string;
  udt_name?: string;
}

export interface LockTreeRow {
  blocked_pid: number;
  blocked_user: string;
  blocking_pid: number;
  blocking_user: string;
  blocked_statement: string;
  blocking_statement: string;
  wait_duration_seconds: number;
  wait_duration_display: string;
}

export interface IndexBloatRow {
  schemaname: string;
  tablename: string;
  indexname: string;
  index_size_pretty: string;
  index_bytes: number;
  estimated_bloat_pct: number;
  remediation_sql: string;
}

export interface TableHealthRow {
  schemaname: string;
  relname: string;
  n_live_tup: number;
  n_dead_tup: number;
  dead_tuple_pct: number;
  seq_scan: number;
  idx_scan: number;
  total_size_pretty: string;
  total_bytes: number;
  last_autovacuum: string | null;
  last_autoanalyze: string | null;
  remediation_sql: string;
}

export interface UnusedIndexRow {
  schemaname: string;
  tablename: string;
  indexname: string;
  idx_scan: number;
  index_size_pretty: string;
  index_bytes: number;
  remediation_sql: string;
}

export interface DatabaseHealthSummary {
  database_size_pretty: string;
  database_size_bytes: number;
  cache_hit_ratio_pct: number;
  active_connections: number;
  idle_connections: number;
  idle_in_transaction: number;
  max_connections: number;
  connection_usage_pct: number;
  pg_version: string;
  table_health: TableHealthRow[];
  unused_indexes: UnusedIndexRow[];
}

export interface ColumnDiffItem {
  kind: 'ADDED' | 'REMOVED' | 'MODIFIED';
  table_schema: string;
  table_name: string;
  column_name: string;
  baseline?: {
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  };
  live?: {
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  };
}

export interface SchemaDriftDetails {
  summary: string;
  baseline_hash: string;
  live_hash: string;
  git_commit_sha: string | null;
  added_count: number;
  removed_count: number;
  modified_count: number;
  diffs: ColumnDiffItem[];
}

export interface LockContentionDetails {
  summary: string;
  blocked_pid: number;
  blocked_user: string;
  blocking_pid: number;
  blocking_user: string;
  wait_duration_seconds: number;
  wait_duration_display: string;
  blocked_statement_redacted: string;
  blocking_statement_redacted: string;
}

export interface IndexBloatDetails {
  summary: string;
  schemaname: string;
  tablename: string;
  indexname: string;
  index_size_pretty: string;
  index_bytes: number;
  estimated_bloat_pct: number;
  remediation_sql: string;
}

export interface VacuumHealthDetails {
  summary: string;
  schemaname: string;
  relname: string;
  n_live_tup: number;
  n_dead_tup: number;
  dead_tuple_pct: number;
  remediation_sql: string;
}

export interface ConnectionSaturationDetails {
  summary: string;
  active_connections: number;
  max_connections: number;
  connection_usage_pct: number;
  idle_in_transaction: number;
}

export type IncidentDetails =
  | SchemaDriftDetails
  | LockContentionDetails
  | IndexBloatDetails
  | VacuumHealthDetails
  | ConnectionSaturationDetails;

export interface HealthTrendDayPoint {
  dateKey: string;
  score: number | null;
  status: HealthStatus;
  inspectionsCount: number;
  incidentsCount: number;
  criticalCount: number;
  warningCount: number;
}

export interface MonitoredDatabaseDto {
  id: string;
  name: string;
  environment: EnvironmentType;
  connectionMode: ConnectionMode;
  maskedTarget: string;
  pollIntervalSeconds: number;
  isActive: boolean;
  lastPolledAt: string | null;
  lastSchemaHash: string | null;
  lastHealthStatus: HealthStatus;
  createdAt: string;
  latestBaseline: {
    id: string;
    gitCommitSha: string | null;
    schemaHash: string;
    columnCount: number;
    tableCount: number;
    createdAt: string;
  } | null;
  openIncidentsCount: number;
  criticalIncidentsCount: number;
  credentialsValid?: boolean;
  healthTrend7d?: HealthTrendDayPoint[];
}

export interface SchemaBaselineDto {
  id: string;
  databaseId: string;
  gitCommitSha: string | null;
  schemaHash: string;
  tablesJson: ColumnCatalogRow[];
  createdAt: string;
}

export interface TelemetryIncidentDto {
  id: string;
  databaseId: string;
  databaseName: string;
  environment: EnvironmentType;
  incidentType: IncidentType;
  severity: SeverityLevel;
  fingerprint: string;
  details: IncidentDetails;
  status: IncidentStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TelemetrySnapshotDto {
  id: string;
  databaseId: string;
  schemaHash: string;
  tableCount: number;
  columnCount: number;
  activeLocksCount: number;
  bloatedIndexesCount: number;
  catalogJson: ColumnCatalogRow[];
  locksJson: LockTreeRow[];
  bloatJson: IndexBloatRow[];
  healthJson: DatabaseHealthSummary | null;
  durationMs: number;
  inspectedAt: string;
}

export interface AlertWebhookDto {
  id: string;
  name: string;
  provider: WebhookProvider;
  maskedUrl: string;
  minSeverity: SeverityLevel;
  isActive: boolean;
  lastTriggeredAt: string | null;
  lastStatusCode: number | null;
  createdAt: string;
}

export interface WorkspaceSettingsDto {
  lockThresholdSeconds: number;
  bloatMbThreshold: number;
  bloatPctThreshold: number;
  deadTuplePctThreshold: number;
  cacheHitMinPct: number;
  connSaturationPct: number;
  updatedAt: string | null;
}

export interface TargetHealthThresholdDto {
  databaseId: string;
  databaseName: string;
  environment: EnvironmentType;
  isActive: boolean;
  lastHealthStatus: HealthStatus;
  lastPolledAt: string | null;
  openIncidentsCount: number;
  criticalIncidentsCount: number;
  currentHealthScore: number;
  enabled: boolean;
  minHealthScore: number;
  cooldownMinutes: number;
  lastEvaluatedScore: number | null;
  lastBreachAt: string | null;
  lastAutoReinspectAt: string | null;
  autoReinspectCount: number;
  isBreached: boolean;
  inCooldown: boolean;
  cooldownRemainingSeconds: number;
  updatedAt: string | null;
}

export interface TargetThresholdEvaluationItem {
  databaseId: string;
  databaseName: string;
  previousScore: number;
  newScore: number | null;
  minHealthScore: number;
  breached: boolean;
  triggered: boolean;
  skippedReason?:
    | 'disabled'
    | 'healthy'
    | 'cooldown'
    | 'inactive'
    | 'in_progress'
    | 'maintenance_window';
  newHealthStatus?: HealthStatus;
  newIncidentsCount?: number;
  error?: string;
}

export interface HealthThresholdEvaluationResponse {
  evaluatedCount: number;
  breachedCount: number;
  triggeredCount: number;
  cooldownSkippedCount: number;
  results: TargetThresholdEvaluationItem[];
}

export interface MigrationFinding {
  ruleId: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  title: string;
  plainEnglishImpact: string;
  lockLevel: string;
  statementPreview: string;
  recommendation: string;
  safeRewrite?: string;
}

export interface MigrationCheckDto {
  id: string;
  databaseId: string | null;
  title: string;
  sqlText: string;
  riskLevel: 'SAFE' | 'WARNING' | 'BLOCKED';
  findings: MigrationFinding[];
  wrappedSafeSql: string;
  createdAt: string;
}

export interface ApiKeyDto {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface AuditLogDto {
  id: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityLabel: string;
  summary: string;
  createdAt: string;
}

export interface EnvironmentCompareResult {
  source: {
    id: string;
    name: string;
    environment: EnvironmentType;
    schemaHash: string;
    tableCount: number;
    columnCount: number;
    capturedAt: string;
  };
  target: {
    id: string;
    name: string;
    environment: EnvironmentType;
    schemaHash: string;
    tableCount: number;
    columnCount: number;
    capturedAt: string;
  };
  identical: boolean;
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  diffs: ColumnDiffItem[];
  syncSql: string;
}

export interface ExpensiveQueryRow {
  query_id: string;
  query: string;
  calls: number;
  mean_exec_time_ms: number;
  total_exec_time_ms: number;
  max_exec_time_ms: number;
  total_rows: number;
  cache_hit_pct: number;
}

export interface QueryPerformanceResponse {
  targetLabel: string;
  databaseId: string | null;
  extensionAvailable: boolean;
  collectedAt: string;
  queries: ExpensiveQueryRow[];
  unavailableReason?: string;
  enableExtensionSql?: string;
}

export interface LiveLockEdge {
  blocked_pid: number;
  blocked_user: string;
  blocked_app: string;
  blocked_state: string;
  blocked_statement: string;
  blocking_pid: number;
  blocking_user: string;
  blocking_app: string;
  blocking_state: string;
  blocking_statement: string;
  lock_type: string;
  waiting_mode: string;
  held_mode: string;
  target_relation: string;
  wait_duration_seconds: number;
  wait_duration_display: string;
}

export interface LiveLockContentionResponse {
  targetLabel: string;
  databaseId: string | null;
  collectedAt: string;
  edges: LiveLockEdge[];
  totalBlockedPids: number;
  rootBlockerCount: number;
  maxWaitSeconds: number;
  permissionWarning?: string;
}

export interface TableBloatGrowthRow {
  schemaname: string;
  relname: string;
  total_bytes: number;
  total_size_pretty: string;
  table_bytes: number;
  index_bytes: number;
  n_live_tup: number;
  n_dead_tup: number;
  dead_tuple_pct: number;
  estimated_bloat_bytes: number;
  estimated_bloat_pretty: string;
  daily_growth_bytes: number;
  daily_bloat_bytes: number;
  growth_share_pct: number;
  n_tup_ins: number;
  n_tup_upd: number;
  n_tup_del: number;
  remediation_sql: string;
}

export interface CapacityHistoryPoint {
  timestamp: string;
  usedBytes: number;
  bloatBytes: number;
}

export interface CapacityPlanningResponse {
  targetLabel: string;
  databaseId: string | null;
  collectedAt: string;
  dataSource: 'historical_snapshots' | 'pg_stat_bloat_velocity';
  snapshotCount: number;
  statsWindowDays: number;
  currentDbBytes: number;
  currentDbPretty: string;
  estimatedBloatBytes: number;
  estimatedBloatPretty: string;
  bloatRatioPct: number;
  defaultMaxCapacityGb: number;
  dailyGrowthBytes: number;
  dailyBloatBytes: number;
  mitigatedDailyGrowthBytes: number;
  monthlyGrowthBytes: number;
  historyPoints: CapacityHistoryPoint[];
  topTables: TableBloatGrowthRow[];
}

export interface HealthTrendPoint {
  timestamp: string;
  label: string;
  deadTuplePct: number;
  deadTuples: number;
  vacuumEvents: number;
  vacuumBaselineMean: number | null;
  vacuumUpperBound: number | null;
  vacuumZScore: number | null;
  vacuumAnomaly: boolean;
  indexBloatPct: number;
  bloatedIndexBytes: number;
  bloatedIndexCount: number;
  bloatBaselineMean: number | null;
  bloatUpperBound: number | null;
  bloatZScore: number | null;
  bloatAnomaly: boolean;
}

export interface SuggestedTrendAlert {
  id: string;
  fingerprint: string;
  category: 'VACUUM_SPIKE' | 'INDEX_BLOAT_GROWTH';
  incidentType: 'VACUUM_HEALTH' | 'INDEX_BLOAT';
  severity: SeverityLevel;
  title: string;
  targetObject: string;
  observedLabel: string;
  baselineLabel: string;
  deviationLabel: string;
  plainEnglishReason: string;
  remediationSql: string;
  detectedAt: string;
  alreadyPromoted: boolean;
  metrics: {
    schemaname: string;
    tablename: string;
    indexname?: string;
    n_live_tup?: number;
    n_dead_tup?: number;
    dead_tuple_pct?: number;
    index_bytes?: number;
    index_size_pretty?: string;
    estimated_bloat_pct?: number;
  };
}

export interface HealthTrendsResponse {
  targetLabel: string;
  databaseId: string | null;
  canPromoteAlerts: boolean;
  collectedAt: string;
  windowSize: number;
  sigmaThreshold: number;
  snapshotCount: number;
  points: HealthTrendPoint[];
  vacuumAnomalyCount: number;
  bloatAnomalyCount: number;
  latestDeadTuplePct: number;
  latestIndexBloatPct: number;
  totalVacuumCycles: number;
  suggestedAlerts: SuggestedTrendAlert[];
}

export type TimelineEventCategory =
  | 'schema_change'
  | 'alert_trigger'
  | 'manual_inspection';

export interface DatabaseTimelineEvent {
  id: string;
  category: TimelineEventCategory;
  subtype: string;
  title: string;
  summary: string;
  timestamp: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL' | 'SUCCESS';
  actor: string | null;
  statusLabel?: string;
  schemaHash?: string | null;
  gitCommitSha?: string | null;
  durationMs?: number | null;
  targetTab?: 'diff' | 'catalog' | 'health' | 'locks' | 'bloat' | 'baselines';
  remediationSql?: string | null;
  meta: { label: string; value: string; mono?: boolean }[];
}

export interface DatabaseTimelineResponse {
  databaseId: string;
  databaseName: string;
  environment: EnvironmentType;
  generatedAt: string;
  counts: {
    all: number;
    schema_change: number;
    alert_trigger: number;
    manual_inspection: number;
  };
  events: DatabaseTimelineEvent[];
}

export type RegressionStatus = 'REGRESSION' | 'ELEVATED' | 'STABLE' | 'IMPROVED';

export interface QueryTrendPoint {
  bucketKey: string;
  label: string;
  timestamp: string;
  avgLatencyMs: number;
  maxLatencyMs: number;
  calls: number;
  deltaPct: number;
  isRegression: boolean;
}

export interface QueryLatencySeries {
  queryId: string;
  shortLabel: string;
  queryText: string;
  baselineMs: number;
  regressionThresholdMs: number;
  latestMs: number;
  peakMs: number;
  deltaPct: number;
  status: RegressionStatus;
  regressionCount: number;
  totalCalls: number;
  avgCacheHitPct: number;
  points: QueryTrendPoint[];
}

export interface PerformanceTrendsResponse {
  targetLabel: string;
  databaseId: string | null;
  extensionAvailable: boolean;
  unavailableReason?: string;
  days: number;
  collectedAt: string;
  totalSamplesStored: number;
  distinctDays: number;
  bucketDates: { key: string; label: string; timestamp: string }[];
  blendedBaselineMs: number;
  blendedLatestMs: number;
  blendedDeltaPct: number;
  regressionQueriesCount: number;
  worstDeltaPct: number;
  series: QueryLatencySeries[];
}

export type IndexRecommendationKind = 'COMPOSITE' | 'SINGLE_COLUMN';

export interface IndexAdvisorRecommendation {
  id: string;
  kind: IndexRecommendationKind;
  severity: SeverityLevel;
  source: 'QUERY_PLAN' | 'SEQ_SCAN_STATS' | 'EXPLAIN_ANALYZER';
  schemaName: string;
  tableName: string;
  columns: string[];
  indexName: string;
  createIndexSql: string;
  rationale: string;
  estimatedSpeedupLabel: string;
  evidence: {
    seqScans?: number;
    seqTupRead?: number;
    idxScans?: number;
    seqScanPct?: number;
    tableSizePretty?: string;
    meanLatencyMs?: number;
    planCost?: number;
    filterPreview?: string;
    sortKeyPreview?: string;
    sampleQuery?: string;
  };
}

export interface SeqScanHotspotRow {
  schemaname: string;
  relname: string;
  seq_scan: number;
  seq_tup_read: number;
  idx_scan: number;
  seq_scan_pct: number;
  n_live_tup: number;
  table_size_pretty: string;
  table_bytes: number;
  existing_index_count: number;
}

export interface QueryPlanNodeDto {
  nodeType: string;
  relationName?: string;
  schema?: string;
  alias?: string;
  startupCost: number;
  totalCost: number;
  planRows: number;
  planWidth: number;
  filter?: string;
  indexName?: string;
  indexCond?: string;
  sortKey?: string[];
  joinType?: string;
  hashCond?: string;
  isSeqScanBottleneck: boolean;
  children: QueryPlanNodeDto[];
}

export interface ExplainPlanAnalysisResponse {
  targetLabel: string;
  databaseId: string | null;
  analyzedSql: string;
  totalCost: number;
  estimatedRows: number;
  seqScanCount: number;
  sortNodeCount: number;
  planRoot: QueryPlanNodeDto;
  recommendations: IndexAdvisorRecommendation[];
}

export interface IndexAdvisorResponse {
  targetLabel: string;
  databaseId: string | null;
  collectedAt: string;
  tablesAnalyzed: number;
  highLatencyQueriesAnalyzed: number;
  seqScanHotspots: SeqScanHotspotRow[];
  recommendations: IndexAdvisorRecommendation[];
  sampleQueriesForExplain: { label: string; sql: string }[];
  warningNote?: string;
}

export interface ActivityHeatmapBucketMeta {
  index: number;
  startIso: string;
  endIso: string;
  hourLabel: string;
  rangeLabel: string;
}

export interface ActivityHeatmapCell {
  bucketIndex: number;
  activityCount: number;
  activityLevel: 0 | 1 | 2 | 3 | 4;
  inspectionsCount: number;
  queryCalls: number;
  avgConnectionPct: number | null;
  incidentsCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  errorRatePct: number;
  errorLevel: 0 | 1 | 2 | 3 | 4;
  topIncidentType: IncidentType | null;
}

export interface ActivityHeatmapTargetRow {
  databaseId: string;
  name: string;
  environment: EnvironmentType;
  lastHealthStatus: HealthStatus;
  totalActivity24h: number;
  totalIncidents24h: number;
  avgErrorRatePct: number;
  peakErrorBucketIndex: number | null;
  cells: ActivityHeatmapCell[];
}

export interface ActivityHeatmapSummary {
  totalActivityEvents24h: number;
  totalInspections24h: number;
  totalIncidents24h: number;
  totalCritical24h: number;
  overallErrorRatePct: number;
  activeTargetsCount: number;
  peakIncidentBucketIndex: number | null;
  peakIncidentRangeLabel: string | null;
  peakIncidentCount: number;
  peakErrorRatePct: number;
  peakActivityBucketIndex: number | null;
  peakActivityRangeLabel: string | null;
  peakActivityCount: number;
  hasLiveData: boolean;
}

export interface ActivityHeatmapResponse {
  generatedAt: string;
  windowHours: number;
  buckets: ActivityHeatmapBucketMeta[];
  targets: ActivityHeatmapTargetRow[];
  fleetTotals: ActivityHeatmapCell[];
  summary: ActivityHeatmapSummary;
}

// 1. Interactive ERD & Schema Dependency Graph
export interface ErdColumnNode {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  driftKind?: 'ADDED' | 'MODIFIED' | 'REMOVED' | null;
}

export interface ErdTableNode {
  id: string; // schema.table
  schema: string;
  name: string;
  columns: ErdColumnNode[];
  hasDrift: boolean;
  driftCounts: { added: number; modified: number; removed: number };
  estimatedRowCount?: number | null;
}

export interface ErdRelationshipEdge {
  id: string;
  sourceTableId: string;
  sourceColumn: string;
  targetTableId: string;
  targetColumn: string;
  constraintName: string;
  inferred: boolean;
}

export interface SchemaErdResponse {
  databaseId: string;
  databaseName: string;
  schemaHash: string;
  generatedAt: string;
  source: 'live_constraints' | 'catalog_inferred';
  tables: ErdTableNode[];
  edges: ErdRelationshipEdge[];
}

// 2. Schema Snapshot Time Machine & Rollback Generator
export interface TimeMachineRevision {
  id: string;
  kind: 'baseline' | 'snapshot';
  label: string;
  schemaHash: string;
  gitCommitSha: string | null;
  tableCount: number;
  columnCount: number;
  createdAt: string;
  isCurrentBaseline?: boolean;
}

export interface SchemaTimeMachineResponse {
  databaseId: string;
  databaseName: string;
  revisions: TimeMachineRevision[];
  comparison: {
    fromRevision: TimeMachineRevision;
    toRevision: TimeMachineRevision;
    identical: boolean;
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    diffs: ColumnDiffItem[];
    upMigrationSql: string;
    downRollbackSql: string;
  } | null;
}

// 3. PostgreSQL Security & Privilege Drift Auditor
export type SecurityFindingCategory =
  | 'SUPERUSER_ROLE'
  | 'MISSING_RLS'
  | 'PUBLIC_GRANT'
  | 'NON_SSL_SESSION'
  | 'BYPASS_RLS';

export interface SecurityAuditFinding {
  id: string;
  category: SecurityFindingCategory;
  severity: SeverityLevel;
  title: string;
  targetObject: string;
  description: string;
  remediationSql: string;
}

export interface SecurityRoleRow {
  roleName: string;
  isSuperuser: boolean;
  canLogin: boolean;
  canCreateRole: boolean;
  canCreateDb: boolean;
  bypassRls: boolean;
  validUntil: string | null;
}

export interface SecurityRlsTableRow {
  schemaName: string;
  tableName: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policyCount: number;
  hasPublicGrant: boolean;
}

export interface SecurityAuditResponse {
  databaseId: string;
  databaseName: string;
  environment: EnvironmentType;
  collectedAt: string;
  source: 'live_pg' | 'demo_catalog';
  securityScore: number;
  superuserCount: number;
  tablesTotal: number;
  tablesWithoutRlsCount: number;
  publicGrantsCount: number;
  sslSessionsCount: number;
  nonSslSessionsCount: number;
  sslCoveragePct: number;
  findings: SecurityAuditFinding[];
  roles: SecurityRoleRow[];
  rlsTables: SecurityRlsTableRow[];
}

// 5. Replication Lag & WAL Slot Monitor
export interface ReplicationStandbyRow {
  pid: number;
  applicationName: string;
  clientAddr: string;
  state: string;
  syncState: string;
  sentLsn: string;
  replayLsn: string;
  writeLagMs: number;
  flushLagMs: number;
  replayLagMs: number;
  replayLagBytes: number;
  replayLagPretty: string;
}

export interface ReplicationSlotRow {
  slotName: string;
  slotType: string;
  database: string | null;
  active: boolean;
  walStatus: string;
  retainedWalBytes: number;
  retainedWalPretty: string;
  remediationSql: string | null;
}

export interface ReplicationMonitorResponse {
  targetLabel: string;
  databaseId: string | null;
  collectedAt: string;
  source: 'live_pg' | 'demo_topology';
  isStandby: boolean;
  standbys: ReplicationStandbyRow[];
  slots: ReplicationSlotRow[];
  peakReplayLagMs: number;
  peakReplayLagBytes: number;
  peakReplayLagPretty: string;
  inactiveSlotsCount: number;
  totalRetainedWalBytes: number;
  totalRetainedWalPretty: string;
  warningNote?: string;
}

// 6. Maintenance Windows & Alert Silencing Schedules
export interface MaintenanceWindowDto {
  id: string;
  databaseId: string | null;
  databaseName: string | null;
  environment: 'all' | EnvironmentType;
  title: string;
  dayOfWeek: number; // -1 = daily, 0 = Sun .. 6 = Sat
  startTimeUtc: string; // "HH:MM"
  durationMinutes: number;
  suppressWebhooks: boolean;
  suppressAutoReinspect: boolean;
  isActive: boolean;
  currentlyInWindow: boolean;
  createdAt: string;
}

// 7. Team RBAC & Baseline Promotion Approvals
export type WorkspaceRole = 'admin' | 'dba' | 'viewer';

export interface TeamMemberDto {
  id: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
  status: 'active' | 'invited';
  invitedBy: string;
  isOwner?: boolean;
  createdAt: string;
}

export interface BaselineApprovalRequestDto {
  id: string;
  databaseId: string;
  databaseName: string;
  environment: EnvironmentType;
  requestedByEmail: string;
  gitCommitSha: string | null;
  proposedSchemaHash: string;
  currentBaselineHash: string | null;
  diffSummary: string;
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewedByEmail: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

// 8. Executive Health Digest
export interface ExecutiveTargetScorecard {
  databaseId: string;
  name: string;
  environment: EnvironmentType;
  healthStatus: HealthStatus;
  healthScore: number;
  slaAvailabilityPct: number;
  inspectionsCount: number;
  openIncidentsCount: number;
  resolvedIncidentsCount: number;
  driftEventsCount: number;
  mttrMinutes: number | null;
  databaseSizePretty: string;
  databaseSizeBytes: number;
  cacheHitRatioPct: number | null;
  connectionUsagePct: number | null;
}

export interface ExecutiveDigestResponse {
  generatedAt: string;
  periodDays: number;
  fleetSlaPct: number;
  avgHealthScore: number;
  totalTargets: number;
  healthyTargetsCount: number;
  driftedTargetsCount: number;
  totalIncidentsInPeriod: number;
  openIncidentsCount: number;
  resolvedIncidentsInPeriod: number;
  avgMttrMinutes: number | null;
  totalStorageBytes: number;
  totalStoragePretty: string;
  projected30dGrowthBytes: number;
  projected30dGrowthPretty: string;
  incidentsByType: { type: IncidentType; count: number }[];
  scorecards: ExecutiveTargetScorecard[];
  highlights: { severity: 'INFO' | 'WARNING' | 'CRITICAL'; message: string }[];
}

// 9. Comprehensive Live Database Operations Monitor
export interface LiveSessionRow {
  pid: number;
  usename: string;
  applicationName: string;
  clientAddr: string;
  state:
    | 'active'
    | 'idle'
    | 'idle in transaction'
    | 'idle in transaction (aborted)'
    | 'fastpath function call'
    | 'disabled'
    | 'other';
  waitEventType: string | null;
  waitEvent: string | null;
  durationSeconds: number;
  xactDurationSeconds: number | null;
  xactStartIso: string | null;
  queryStartIso: string | null;
  query: string;
  isBlocked: boolean;
  blockingPids: number[];
}

export interface DatabaseThroughputStats {
  pgVersion: string;
  uptimeSeconds: number;
  databaseName: string;
  databaseSizePretty: string;
  maxConnections: number;
  activeConnections: number;
  idleConnections: number;
  idleInTransaction: number;
  waitingConnections: number;
  totalConnections: number;
  connectionUsagePct: number;
  xactCommit: number;
  xactRollback: number;
  rollbackRatioPct: number;
  estimatedTps: number;
  blksHit: number;
  blksRead: number;
  cacheHitRatioPct: number;
  tupReturned: number;
  tupFetched: number;
  tupInserted: number;
  tupUpdated: number;
  tupDeleted: number;
  deadlocks: number;
  tempFiles: number;
  tempBytes: number;
  tempBytesPretty: string;
  blkReadTimeMs: number;
  blkWriteTimeMs: number;
}

export interface BgWriterStats {
  checkpointsTimed: number;
  checkpointsReq: number;
  requestedCheckpointPct: number;
  checkpointWriteTimeMs: number;
  checkpointSyncTimeMs: number;
  buffersCheckpoint: number;
  buffersClean: number;
  buffersBackend: number;
  buffersAlloc: number;
  maxwrittenClean: number;
  statsResetIso: string | null;
}

export interface XidWraparoundTableRow {
  schemaName: string;
  tableName: string;
  xidAge: number;
  pctTowardFreeze: number;
  pctTowardWraparound: number;
  nDeadTup: number;
  lastAutovacuumIso: string | null;
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  remediationSql: string;
}

export interface VacuumProgressRow {
  pid: number;
  schemaName: string;
  tableName: string;
  phase: string;
  heapBlksTotal: number;
  heapBlksScanned: number;
  heapBlksVacuumed: number;
  progressPct: number;
  indexVacuumCount: number;
}

export interface PgSettingAuditRow {
  name: string;
  setting: string;
  unit: string | null;
  displayValue: string;
  category: string;
  context: string;
  source: string;
  status: 'OPTIMAL' | 'ADVISORY' | 'WARNING';
  recommendation: string | null;
  tuningSql: string | null;
}

export interface LiveMonitorResponse {
  targetLabel: string;
  databaseId: string | null;
  environment: EnvironmentType | 'workspace';
  collectedAt: string;
  source: 'live_pg' | 'demo_live';
  throughput: DatabaseThroughputStats;
  bgwriter: BgWriterStats;
  sessions: LiveSessionRow[];
  databaseXidAge: number;
  databaseXidWraparoundPct: number;
  autovacuumFreezeMaxAge: number;
  wraparoundTables: XidWraparoundTableRow[];
  activeVacuums: VacuumProgressRow[];
  settingsAudit: PgSettingAuditRow[];
  warningNote?: string;
}




