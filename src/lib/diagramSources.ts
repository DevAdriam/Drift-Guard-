import type {
  AlertWebhookDto,
  MonitoredDatabaseDto,
  ReplicationMonitorResponse,
  SchemaErdResponse,
} from '../types/telemetry.ts';

export type DiagramKind =
  | 'usecase'
  | 'sequence'
  | 'architecture'
  | 'dfd'
  | 'state'
  | 'erd'
  | 'replication';

export type SequenceScenarioId =
  | 'drift-alert'
  | 'baseline-approval'
  | 'cicd-gate'
  | 'auto-reinspect';

export interface DiagramSourceBundle {
  mermaid: string;
  plantuml: string;
}

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function generateDiagramSources(params: {
  kind: DiagramKind;
  sequenceScenario: SequenceScenarioId;
  databases: MonitoredDatabaseDto[];
  webhooks: AlertWebhookDto[];
  erdMode: 'platform' | 'target';
  targetErd: SchemaErdResponse | null;
  replication: ReplicationMonitorResponse | null;
}): DiagramSourceBundle {
  const { kind, sequenceScenario, databases, webhooks, erdMode, targetErd, replication } =
    params;

  if (kind === 'usecase') {
    const mermaid = `flowchart LR
  Admin(["Workspace Admin"])
  DBA(["DBA / SRE"])
  Viewer(["Read-Only Viewer"])
  CI(["CI/CD Pipeline"])
  Alerts(["Slack / Discord / PagerDuty"])

  subgraph DriftGuard["DriftGuard PostgreSQL Monitoring Platform"]
    UC1(("Register & Encrypt PG Target"))
    UC2(("Inspect Live Catalog & Health"))
    UC3(("Live Session & Vacuum Ops"))
    UC4(("Lint Pre-Flight Migration DDL"))
    UC5(("Compare Staging vs Prod"))
    UC6(("Approve Baseline Promotion"))
    UC7(("Schedule Maintenance Windows"))
    UC8(("Export Executive PDF Digest"))
    UC9(("Dispatch Filtered Alerts"))
  end

  Admin --> UC1
  Admin --> UC6
  Admin --> UC7
  Admin --> UC8
  DBA --> UC2
  DBA --> UC3
  DBA --> UC4
  DBA --> UC5
  DBA --> UC6
  Viewer --> UC8
  CI --> UC2
  CI --> UC4
  UC2 -. "<<extend>>" .-> UC9
  UC9 --> Alerts`;

    const plantuml = `@startuml DriftGuard_UseCase
left to right direction
actor "Workspace Admin" as Admin
actor "DBA / SRE" as DBA
actor "Read-Only Viewer" as Viewer
actor "CI/CD Pipeline" as CI
actor "Alert Channels" as Alerts

rectangle "DriftGuard Monitoring Platform" {
  usecase "Register & Encrypt PG Target" as UC1
  usecase "Inspect Live Catalog & Health" as UC2
  usecase "Live Session & Vacuum Ops" as UC3
  usecase "Lint Pre-Flight Migration DDL" as UC4
  usecase "Compare Environments" as UC5
  usecase "Approve Baseline Promotion" as UC6
  usecase "Schedule Maintenance Windows" as UC7
  usecase "Export Executive PDF Digest" as UC8
  usecase "Dispatch Filtered Alerts" as UC9
}

Admin --> UC1
Admin --> UC6
Admin --> UC7
Admin --> UC8
DBA --> UC2
DBA --> UC3
DBA --> UC4
DBA --> UC5
DBA --> UC6
Viewer --> UC8
CI --> UC2
CI --> UC4
UC2 ..> UC9 : <<extend>>
UC9 --> Alerts
@enduml`;

    return { mermaid, plantuml };
  }

  if (kind === 'sequence') {
    if (sequenceScenario === 'baseline-approval') {
      return {
        mermaid: `sequenceDiagram
  autonumber
  actor Eng as Engineer
  participant API as Express Governance API
  participant DB as Cloud SQL Metadata
  actor DBA as DBA / Admin Reviewer
  participant Audit as Audit Log

  Eng->>API: POST /api/approvals (databaseId, gitCommitSha)
  API->>DB: Load latest snapshot & active baseline
  API->>DB: INSERT baseline_approval_requests (PENDING)
  API-->>Eng: 201 Created (Approval Request ID)
  DBA->>API: POST /api/approvals/:id/review (APPROVED)
  API->>DB: INSERT schema_baselines (new canonical SHA-256)
  API->>DB: UPDATE telemetry_incidents SET status='RESOLVED'
  API->>Audit: Record BASELINE_APPROVAL_APPROVED
  API-->>DBA: 200 OK (Baseline Promoted)`,
        plantuml: `@startuml Baseline_Approval_Sequence
autonumber
actor Engineer
participant "Express API" as API
database "Cloud SQL" as DB
actor "DBA / Admin" as DBA
participant "Audit Log" as Audit

Engineer -> API : POST /api/approvals
API -> DB : Load latest snapshot + baseline
API -> DB : Insert PENDING approval request
API --> Engineer : 201 Created
DBA -> API : POST /api/approvals/:id/review (APPROVED)
API -> DB : Promote canonical SHA-256 baseline
API -> DB : Auto-resolve open SCHEMA_DRIFT incidents
API -> Audit : Record BASELINE_APPROVAL_APPROVED
API --> DBA : 200 OK
@enduml`,
      };
    }

    if (sequenceScenario === 'cicd-gate') {
      return {
        mermaid: `sequenceDiagram
  autonumber
  participant GHA as GitHub Actions
  participant API as Express CI Gate
  participant Target as Target PostgreSQL (RO)
  participant DB as Cloud SQL Store

  GHA->>API: POST /api/ci/check-drift (X-DriftGuard-Key)
  API->>DB: Verify SHA-256 API Key Hash
  API->>Target: BEGIN READ ONLY -> Query information_schema.columns
  Target-->>API: Canonical Column Catalog
  API->>DB: Compare live SHA-256 vs latest baseline SHA-256
  alt Hash Matches Baseline
    API-->>GHA: 200 OK (Zero Drift - Proceed Deploy)
  else Unexpected Schema Drift Detected
    API->>DB: Record SCHEMA_DRIFT incident
    API-->>GHA: 409 Conflict (Block Deploy + Revert DDL)
  end`,
        plantuml: `@startuml CICD_Gate_Sequence
autonumber
participant "GitHub Actions" as GHA
participant "Express CI Gate" as API
database "Target PostgreSQL" as Target
database "Cloud SQL" as DB

GHA -> API : POST /api/ci/check-drift (X-DriftGuard-Key)
API -> DB : Verify SHA-256 API Key
API -> Target : BEGIN READ ONLY; Inspect information_schema
Target --> API : Canonical catalog rows
API -> DB : Compare SHA-256 against active baseline
alt Match
  API --> GHA : 200 OK (Safe to Deploy)
else Drift Detected
  API -> DB : Insert CRITICAL SCHEMA_DRIFT incident
  API --> GHA : 409 Conflict (Block Deploy + Revert SQL)
end
@enduml`,
      };
    }

    if (sequenceScenario === 'auto-reinspect') {
      return {
        mermaid: `sequenceDiagram
  autonumber
  participant Watcher as Health Threshold Watcher
  participant Scorer as Health Score Engine
  participant Maint as Maintenance Gate
  participant Target as Target PostgreSQL (RO)
  participant Audit as Audit Log

  Watcher->>Scorer: Evaluate targets against custom minHealthScore
  Scorer-->>Watcher: Score 68/100 < Threshold 80/100 (BREACHED)
  Watcher->>Maint: Check cooldown & active maintenance windows
  alt Suppressed (Cooldown or Maintenance Window)
    Maint-->>Watcher: Skip auto re-inspection cleanly
  else Eligible for Verification
    Watcher->>Audit: Log AUTO_REINSPECT_TRIGGERED
    Watcher->>Target: Execute bounded read-only verification scan
    Target-->>Watcher: Fresh telemetry snapshot + updated score
  end`,
        plantuml: `@startuml Auto_Reinspect_Sequence
autonumber
participant "Threshold Watcher" as Watcher
participant "Health Scorer" as Scorer
participant "Maintenance Gate" as Maint
database "Target PostgreSQL" as Target
participant "Audit Log" as Audit

Watcher -> Scorer : Evaluate per-target health scores
Scorer --> Watcher : Score < minHealthScore (Breach)
Watcher -> Maint : Verify cooldown & maintenance windows
alt Suppressed
  Maint --> Watcher : Skip auto re-inspection
else Eligible
  Watcher -> Audit : Record AUTO_REINSPECT_TRIGGERED
  Watcher -> Target : Run read-only verification inspection
  Target --> Watcher : Fresh telemetry snapshot
end
@enduml`,
      };
    }

    // Default: Schema Drift & Webhook Dispatch
    return {
      mermaid: `sequenceDiagram
  autonumber
  actor Op as Operator / Scheduler
  participant API as Express Monitor API
  participant Target as Target PostgreSQL (RO)
  participant Engine as Drift & Telemetry Engine
  participant DB as Cloud SQL Store
  participant Maint as Maintenance Window Gate
  participant Hook as Slack / Discord / PagerDuty

  Op->>API: POST /api/databases/:id/inspect
  API->>Target: BEGIN READ ONLY -> Catalog, Locks, Bloat, Stats
  Target-->>API: Telemetry Payload (bounded 4s timeout)
  API->>Engine: Compute Canonical SHA-256 & Column Diff
  Engine->>DB: Persist telemetry_snapshots & telemetry_incidents
  Engine->>Maint: Check active UTC silencing windows
  alt No Active Silencing Window
    Maint->>Hook: Dispatch signed HTTPS alert payload
    Hook-->>Maint: HTTP 200 Delivered
  else Window Active
    Maint-->>DB: Suppress outbound alert (logged)
  end
  API-->>Op: 200 OK (Snapshot + Diff + Revert SQL)`,
      plantuml: `@startuml Drift_Detection_Sequence
autonumber
actor Operator
participant "Express API" as API
database "Target PostgreSQL" as Target
participant "Drift Engine" as Engine
database "Cloud SQL" as DB
participant "Maintenance Gate" as Maint
participant "Alert Webhooks" as Hook

Operator -> API : POST /api/databases/:id/inspect
API -> Target : BEGIN READ ONLY (Catalog, Locks, Bloat, Health)
Target --> API : Read-only telemetry results
API -> Engine : Canonical SHA-256 + column diff + revert SQL
Engine -> DB : Store snapshot & open incidents
Engine -> Maint : Check active maintenance windows
alt Active Window = None
  Maint -> Hook : Dispatch Slack/Discord/PagerDuty webhook
  Hook --> Maint : 200 OK
else Silenced
  Maint --> DB : Log suppressed dispatch
end
API --> Operator : 200 OK (Telemetry + Revert SQL)
@enduml`,
    };
  }

  if (kind === 'architecture') {
    const dbLines = databases
      .slice(0, 6)
      .map(
        (d, idx) =>
          `    PG${idx}[("${d.name}\\n${d.environment} · ${d.lastHealthStatus}")]`
      )
      .join('\n');
    const hookLines =
      webhooks.length > 0
        ? webhooks
            .slice(0, 4)
            .map((w, idx) => `    WH${idx}["${w.name} (${w.provider})"]`)
            .join('\n')
        : '    WH0["Slack / Discord / PagerDuty"]';

    return {
      mermaid: `flowchart TB
  subgraph Client["Client Presentation Layer"]
    SPA["DriftGuard React + TypeScript SPA\\nEN / MY Localization · Interactive SVG Canvas"]
    Auth["Firebase Authentication\\nID Token / Isolated Demo Session"]
  end

  subgraph Server["Cloud Run / Express API Gateway"]
    MW["Auth & Zod Validation Middleware"]
    Vault["AES-256-GCM Credential Vault"]
    Inspector["Read-Only PG Telemetry & Live Monitor Engine"]
    Gov["Governance, Approvals, Maintenance & PDF Digest"]
  end

  subgraph Metadata["Primary Persistence"]
    CloudSQL[("Cloud SQL PostgreSQL\\n14 Relational Tables via Drizzle ORM")]
  end

  subgraph Fleet["Monitored PostgreSQL Fleet (Read-Only TLS)"]
${dbLines || '    PG0[("Monitored PostgreSQL Targets")]'}
  end

  subgraph Channels["Outbound Alerting"]
${hookLines}
  end

  SPA --> Auth
  SPA --> MW
  MW --> Vault
  MW --> Inspector
  MW --> Gov
  Inspector --> CloudSQL
  Gov --> CloudSQL
  Inspector -. "BEGIN READ ONLY" .-> Fleet
  Gov --> Channels`,
      plantuml: `@startuml DriftGuard_Architecture
package "Client Layer" {
  [React + TypeScript SPA] as SPA
  [Firebase Auth] as Auth
}
package "Express API Server" {
  [Auth & Zod Guard] as MW
  [AES-256-GCM Vault] as Vault
  [Read-Only Telemetry Engine] as Inspector
  [Governance & PDF Engine] as Gov
}
database "Cloud SQL PostgreSQL\\n(14 Tables)" as CloudSQL
cloud "Monitored PostgreSQL Fleet" {
${databases.slice(0, 5).map((d) => `  database "${d.name} (${d.environment})" as ${safeId(d.name)}`).join('\n') || '  database "PostgreSQL Targets" as PG0'}
}
cloud "Alert Channels" {
  [Slack / Discord / PagerDuty] as Hooks
}

SPA --> Auth
SPA --> MW
MW --> Vault
MW --> Inspector
MW --> Gov
Inspector --> CloudSQL
Gov --> CloudSQL
Inspector ..> "Monitored PostgreSQL Fleet" : Read-Only TLS
Gov --> Hooks : Filtered Webhooks
@enduml`,
    };
  }

  if (kind === 'dfd') {
    return {
      mermaid: `flowchart LR
  User["Operator / DBA"]
  CI["CI/CD Runner"]
  TargetPG["Target PostgreSQL"]
  AlertSink["Alert Webhooks"]

  P1(("1.0\\nCatalog & Schema\\nHarvester"))
  P2(("2.0\\nDrift Diff &\\nMigration Linter"))
  P3(("3.0\\nLive Session, I/O\\n& XID Collector"))
  P4(("4.0\\nGovernance, Digest\\n& Alert Router"))

  D1[("D1: monitored_databases")]
  D2[("D2: schema_baselines")]
  D3[("D3: telemetry_snapshots")]
  D4[("D4: telemetry_incidents")]
  D5[("D5: governance_policies")]

  User -- "Target Config / DDL" --> P1
  User -- "SQL Migration Script" --> P2
  CI -- "API Key + Target ID" --> P2
  P1 -- "Encrypted URI" --> D1
  D1 -- "TLS Read-Only Query" --> TargetPG
  TargetPG -- "information_schema" --> P1
  TargetPG -- "pg_stat_* Metrics" --> P3
  P1 -- "Canonical SHA-256" --> P2
  P2 <--> D2
  P2 -- "Drift & Lint Findings" --> D4
  P3 -- "Snapshots & Trends" --> D3
  D4 --> P4
  D5 --> P4
  P4 -- "Filtered Alerts" --> AlertSink
  P4 -- "Executive PDF / CSV" --> User`,
      plantuml: `@startuml DriftGuard_DFD_Level1
left to right direction
rectangle "Operator / DBA" as User
rectangle "CI/CD Runner" as CI
rectangle "Target PostgreSQL" as TargetPG
rectangle "Alert Channels" as AlertSink

usecase "1.0 Catalog Harvester" as P1
usecase "2.0 Drift & Migration Analyzer" as P2
usecase "3.0 Live Telemetry Collector" as P3
usecase "4.0 Governance & Alert Router" as P4

database "D1 monitored_databases" as D1
database "D2 schema_baselines" as D2
database "D3 telemetry_snapshots" as D3
database "D4 telemetry_incidents" as D4
database "D5 governance_policies" as D5

User --> P1 : Register target
User --> P2 : Submit DDL
CI --> P2 : Drift gate check
P1 --> D1 : Encrypted URI
TargetPG --> P1 : Catalog metadata
TargetPG --> P3 : pg_stat_* metrics
P1 --> P2 : SHA-256 catalog
P2 --> D2 : Compare / promote
P2 --> D4 : Open incidents
P3 --> D3 : Store snapshots
D4 --> P4
D5 --> P4
P4 --> AlertSink : Webhook alerts
P4 --> User : PDF / CSV digest
@enduml`,
    };
  }

  if (kind === 'state') {
    return {
      mermaid: `stateDiagram-v2
  [*] --> PENDING : Target registered
  PENDING --> HEALTHY : First inspection clean
  PENDING --> DRIFT : Hash != baseline
  PENDING --> ERROR : Connection timeout / auth fail

  HEALTHY --> WARNING : Lock / Bloat / Cache < threshold
  HEALTHY --> DRIFT : Unexpected DDL change detected
  HEALTHY --> ERROR : Unreachable target

  WARNING --> HEALTHY : Issue remediated + scan clean
  WARNING --> DRIFT : Schema hash diverged
  DRIFT --> HEALTHY : Baseline promoted or Revert SQL applied
  ERROR --> HEALTHY : Credentials updated + scan clean

  state Incident_Lifecycle {
    [*] --> OPEN
    OPEN --> ACKNOWLEDGED : Operator ack
    ACKNOWLEDGED --> RESOLVED : Root cause fixed
    OPEN --> RESOLVED : Baseline approved
  }`,
      plantuml: `@startuml DriftGuard_StateMachine
[*] --> PENDING : Register Target
PENDING --> HEALTHY : First Scan Nominal
PENDING --> DRIFT : SHA-256 Mismatch
PENDING --> ERROR : Connection Failure

HEALTHY --> WARNING : Lock / Bloat / Cache Breach
HEALTHY --> DRIFT : Undocumented DDL
HEALTHY --> ERROR : Poll Timeout

WARNING --> HEALTHY : Remediated
WARNING --> DRIFT : Catalog Diverged
DRIFT --> HEALTHY : Baseline Promoted / Reverted
ERROR --> HEALTHY : URI Updated & Verified
@enduml`,
    };
  }

  if (kind === 'erd') {
    if (erdMode === 'target' && targetErd && targetErd.tables.length > 0) {
      const tableBlocks = targetErd.tables
        .map((t) => {
          const cols = t.columns
            .slice(0, 10)
            .map(
              (c) =>
                `    ${safeId(c.dataType)} ${safeId(c.name)}${c.isPrimaryKey ? ' PK' : c.isForeignKey ? ' FK' : ''}`
            )
            .join('\n');
          return `  ${safeId(t.name)} {\n${cols}\n  }`;
        })
        .join('\n');
      const edgeLines = targetErd.edges
        .map(
          (e) =>
            `  ${safeId(e.targetTableId.split('.').pop() || e.targetTableId)} ||--o{ ${safeId(e.sourceTableId.split('.').pop() || e.sourceTableId)} : "${e.sourceColumn}"`
        )
        .join('\n');

      const pumlTables = targetErd.tables
        .map((t) => {
          const cols = t.columns
            .slice(0, 10)
            .map((c) => `  ${c.isPrimaryKey ? '* ' : ''}${c.name} : ${c.dataType}`)
            .join('\n');
          return `entity "${t.schema}.${t.name}" as ${safeId(t.name)} {\n${cols}\n}`;
        })
        .join('\n');
      const pumlEdges = targetErd.edges
        .map(
          (e) =>
            `${safeId(e.targetTableId.split('.').pop() || e.targetTableId)} ||--o{ ${safeId(e.sourceTableId.split('.').pop() || e.sourceTableId)} : ${e.sourceColumn}`
        )
        .join('\n');

      return {
        mermaid: `erDiagram\n${tableBlocks}\n${edgeLines}`,
        plantuml: `@startuml Target_Database_ERD\n${pumlTables}\n${pumlEdges}\n@enduml`,
      };
    }

    return {
      mermaid: `erDiagram
  users ||--o{ monitored_databases : owns
  users ||--o{ alert_webhooks : configures
  users ||--o{ api_keys : issues
  users ||--o{ team_members : invites
  users ||--o{ maintenance_windows : schedules
  users ||--o{ audit_logs : records
  monitored_databases ||--o{ schema_baselines : snapshots
  monitored_databases ||--o{ telemetry_snapshots : captures
  monitored_databases ||--o{ telemetry_incidents : triggers
  monitored_databases ||--o| target_health_thresholds : enforces
  monitored_databases ||--o{ baseline_approval_requests : gates
  monitored_databases ||--o{ migration_checks : validates`,
      plantuml: `@startuml DriftGuard_Platform_ERD
entity users {
  * uid : text
  email : text
}
entity monitored_databases {
  * id : uuid
  owner_uid : text
  name : text
  environment : text
  last_health_status : text
}
entity schema_baselines {
  * id : uuid
  database_id : uuid
  schema_hash : text
}
entity telemetry_snapshots {
  * id : uuid
  database_id : uuid
  schema_hash : text
  inspected_at : timestamptz
}
entity telemetry_incidents {
  * id : uuid
  database_id : uuid
  incident_type : text
  severity : text
  status : text
}
entity target_health_thresholds {
  * database_id : uuid
  min_health_score : int
  cooldown_minutes : int
}
entity maintenance_windows {
  * id : uuid
  owner_uid : text
  start_time_utc : text
  duration_minutes : int
}
entity baseline_approval_requests {
  * id : uuid
  database_id : uuid
  status : text
}
entity team_members {
  * id : uuid
  owner_uid : text
  role : text
}

users ||--o{ monitored_databases
monitored_databases ||--o{ schema_baselines
monitored_databases ||--o{ telemetry_snapshots
monitored_databases ||--o{ telemetry_incidents
monitored_databases ||--o| target_health_thresholds
monitored_databases ||--o{ baseline_approval_requests
users ||--o{ maintenance_windows
users ||--o{ team_members
@enduml`,
    };
  }

  // Replication & HA Topology
  const primaryName = replication?.targetLabel ?? databases[0]?.name ?? 'primary-pg';
  const standbys = replication?.standbys ?? [];
  const slots = replication?.slots ?? [];

  const standbyMermaid =
    standbys.length > 0
      ? standbys
          .map(
            (s, i) =>
              `  Primary -- "WAL ${s.syncState} · ${s.replayLagMs.toFixed(1)}ms lag" --> R${i}[("${s.applicationName}\\n${s.clientAddr} · ${s.state}")]`
          )
          .join('\n')
      : '  Primary -- "Streaming WAL" --> R0[("Read Replica Standby")]';

  const slotMermaid =
    slots.length > 0
      ? slots
          .map(
            (sl, i) =>
              `  Primary -. "${sl.slotType} · ${sl.retainedWalPretty}" .-> S${i}["Slot: ${sl.slotName} (${sl.active ? 'active' : 'INACTIVE'})"]`
          )
          .join('\n')
      : '  Primary -. "Physical WAL Slot" .-> S0["pg_replication_slots"]';

  return {
    mermaid: `flowchart LR
  AppW["Write Traffic (OLTP)"] --> Primary[("${primaryName}\\nPrimary Writer")]
${standbyMermaid}
${slotMermaid}
  AppR["Read / BI Analytics"] -.-> R0`,
    plantuml: `@startuml Replication_HA_Topology
node "Primary Writer" {
  database "${primaryName}" as Primary
}
${standbys.map((s, i) => `database "${s.applicationName}\\n(${s.syncState}, ${s.replayLagMs.toFixed(1)}ms)" as R${i}`).join('\n') || 'database "Read Replica" as R0'}
${standbys.map((_, i) => `Primary --> R${i} : Streaming WAL`).join('\n') || 'Primary --> R0 : Streaming WAL'}
${slots.map((sl, i) => `queue "Slot: ${sl.slotName}\\n(${sl.retainedWalPretty})" as S${i}\nPrimary ..> S${i}`).join('\n')}
@enduml`,
  };
}
