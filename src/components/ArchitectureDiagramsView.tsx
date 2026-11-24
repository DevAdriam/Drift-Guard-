import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  Download,
  Image as ImageIcon,
  Maximize2,
  Minus,
  Plus,
} from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  AlertWebhookDto,
  MonitoredDatabaseDto,
  ReplicationMonitorResponse,
  SchemaErdResponse,
} from '../types/telemetry.ts';
import {
  generateDiagramSources,
  type DiagramKind,
  type SequenceScenarioId,
} from '../lib/diagramSources.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';
import { useTheme } from '../context/ThemeContext.tsx';

interface ArchitectureDiagramsViewProps {
  api: ApiClient;
  databases: MonitoredDatabaseDto[];
  webhooks: AlertWebhookDto[];
}

interface SelectedInfo {
  title: string;
  category: string;
  description: string;
  meta?: string;
}

interface SequenceStep {
  from: number;
  to: number;
  label: string;
  detail: string;
  isReturn?: boolean;
  highlight?: 'normal' | 'warning' | 'critical' | 'success';
}

interface SequenceDefinition {
  title: string;
  subtitle: string;
  participants: { name: string; role: string }[];
  steps: SequenceStep[];
  altFrame?: { startIndex: number; endIndex: number; label: string };
}

export function ArchitectureDiagramsView({
  api,
  databases,
  webhooks,
}: ArchitectureDiagramsViewProps) {
  const { tr, formatEnv } = useI18n();
  const { isDark } = useTheme();
  const tc = (light: string, dark: string) => (isDark ? dark : light);

  const [diagramKind, setDiagramKind] = useState<DiagramKind>('usecase');
  const [sequenceScenario, setSequenceScenario] =
    useState<SequenceScenarioId>('drift-alert');
  const [erdMode, setErdMode] = useState<'platform' | 'target'>('platform');
  const [selectedTargetId, setSelectedTargetId] = useState<string>(
    databases[0]?.id ?? ''
  );

  const [targetErd, setTargetErd] = useState<SchemaErdResponse | null>(null);
  const [replication, setReplication] =
    useState<ReplicationMonitorResponse | null>(null);
  const [loadingDynamic, setLoadingDynamic] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const [selectedInfo, setSelectedInfo] = useState<SelectedInfo | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [sourceFormat, setSourceFormat] = useState<'mermaid' | 'plantuml'>(
    'mermaid'
  );
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!selectedTargetId && databases.length > 0) {
      setSelectedTargetId(databases[0].id);
    }
  }, [databases, selectedTargetId]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSelectedInfo(null);
  }, [diagramKind, sequenceScenario, erdMode]);

  const loadDynamicTargetData = useCallback(async () => {
    if (diagramKind === 'erd' && erdMode === 'target' && selectedTargetId) {
      setLoadingDynamic(true);
      try {
        const res = await api.getDatabaseErd(selectedTargetId);
        setTargetErd(res);
      } catch {
        setTargetErd(null);
      } finally {
        setLoadingDynamic(false);
      }
    } else if (diagramKind === 'replication') {
      setLoadingDynamic(true);
      try {
        const res = await api.getReplicationMonitor(selectedTargetId || undefined);
        setReplication(res);
      } catch {
        setReplication(null);
      } finally {
        setLoadingDynamic(false);
      }
    }
  }, [api, diagramKind, erdMode, selectedTargetId]);

  useEffect(() => {
    loadDynamicTargetData();
  }, [loadDynamicTargetData]);

  const sources = useMemo(
    () =>
      generateDiagramSources({
        kind: diagramKind,
        sequenceScenario,
        databases,
        webhooks,
        erdMode,
        targetErd,
        replication,
      }),
    [diagramKind, sequenceScenario, databases, webhooks, erdMode, targetErd, replication]
  );

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleExportSvg = () => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const serializer = new XMLSerializer();
    let svgString = serializer.serializeToString(svgEl);
    if (!svgString.includes('xmlns=')) {
      svgString = svgString.replace(
        '<svg',
        '<svg xmlns="http://www.w3.org/2000/svg"'
      );
    }
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `driftguard-${diagramKind}-diagram.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPng = () => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const serializer = new XMLSerializer();
    let svgString = serializer.serializeToString(svgEl);
    if (!svgString.includes('xmlns=')) {
      svgString = svgString.replace(
        '<svg',
        '<svg xmlns="http://www.w3.org/2000/svg"'
      );
    }
    const vb = svgEl.viewBox.baseVal;
    const width = vb && vb.width ? vb.width : 1120;
    const height = vb && vb.height ? vb.height : 620;
    const scale = 2;

    const img = new window.Image();
    const svgBlob = new Blob([svgString], {
      type: 'image/svg+xml;charset=utf-8',
    });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = tc('#ffffff', '#0f172a');
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((pngBlob) => {
          if (!pngBlob) return;
          const pngUrl = URL.createObjectURL(pngBlob);
          const a = document.createElement('a');
          a.href = pngUrl;
          a.download = `driftguard-${diagramKind}-diagram.png`;
          a.click();
          URL.revokeObjectURL(pngUrl);
        }, 'image/png');
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    setDragging(true);
    dragOrigin.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setPan({
      x: dragOrigin.current.panX + (e.clientX - dragOrigin.current.x),
      y: dragOrigin.current.panY + (e.clientY - dragOrigin.current.y),
    });
  };

  const handlePointerUp = () => setDragging(false);

  // Sequence diagram definitions
  const sequenceDefs: Record<SequenceScenarioId, SequenceDefinition> = useMemo(
    () => ({
      'drift-alert': {
        title: tr(
          'Schema Drift Detection & Alert Dispatch',
          'ဖွဲ့စည်းပုံ ကွာခြားမှု ရှာဖွေခြင်းနှင့် သတိပေးချက် ပေးပို့မှု'
        ),
        subtitle: tr(
          'End-to-end flow from read-only PostgreSQL catalog scan to maintenance-gated Slack/PagerDuty delivery.',
          'ဖတ်ရှုသီးသန့် PostgreSQL catalog စစ်ဆေးမှုမှ ပြုပြင်ထိန်းသိမ်းချိန် စစ်ဆေးပြီး Slack/PagerDuty သတိပေးပို့မှုအထိ။'
        ),
        participants: [
          { name: 'Operator / Cron', role: 'Actor' },
          { name: 'Express API', role: 'Gateway' },
          { name: 'Target PG (RO)', role: 'PostgreSQL' },
          { name: 'Drift Engine', role: 'SHA-256 Diff' },
          { name: 'Cloud SQL', role: 'Metadata' },
          { name: 'Maint. Gate', role: 'Silencer' },
          { name: 'Webhooks', role: 'Alert Sink' },
        ],
        steps: [
          {
            from: 0,
            to: 1,
            label: 'POST /api/databases/:id/inspect',
            detail: 'Authenticated Bearer token + UUID parameter validation.',
          },
          {
            from: 1,
            to: 2,
            label: 'BEGIN READ ONLY (4s timeout)',
            detail: 'Decrypts AES-256-GCM URI, runs read-only catalog, lock, bloat & health collectors.',
          },
          {
            from: 2,
            to: 1,
            label: 'Catalog + pg_stat_* rows',
            detail: 'Zero customer row access; strictly system views & information_schema.',
            isReturn: true,
          },
          {
            from: 1,
            to: 3,
            label: 'Compute canonical SHA-256 & column diff',
            detail: 'Compares live catalog columns against latest stored schema_baselines snapshot.',
          },
          {
            from: 3,
            to: 4,
            label: 'INSERT snapshot & SCHEMA_DRIFT incident',
            detail: 'Persists telemetry_snapshots and opens CRITICAL incident if hash diverged.',
            highlight: 'critical',
          },
          {
            from: 3,
            to: 5,
            label: 'Check active UTC maintenance windows',
            detail: 'Evaluates scope (all / environment / databaseId) and suppressWebhooks flag.',
          },
          {
            from: 5,
            to: 6,
            label: 'POST Slack / Discord / PagerDuty payload',
            detail: 'Dispatches alert with revert DDL when outside silencing windows.',
            highlight: 'warning',
          },
          {
            from: 1,
            to: 0,
            label: '200 OK (Snapshot + Diff + Revert SQL)',
            detail: 'Returns fresh health score, column diffs, and lock-timeout wrapped SQL.',
            isReturn: true,
            highlight: 'success',
          },
        ],
        altFrame: {
          startIndex: 5,
          endIndex: 6,
          label: 'opt [No active maintenance silencing window]',
        },
      },
      'baseline-approval': {
        title: tr(
          'Production Baseline Two-Person Approval',
          'Production မူလစံ နှစ်ဦး အတည်ပြုမှု လုပ်ငန်းစဉ်'
        ),
        subtitle: tr(
          'Controlled change governance requiring DBA or Admin review before promoting live schema changes.',
          'Production ဖွဲ့စည်းပုံ မူလစံအသစ် မသတ်မှတ်မီ DBA သို့မဟုတ် Admin ၏ အတည်ပြုချက် ရယူသည့် လုပ်ငန်းစဉ်။'
        ),
        participants: [
          { name: 'Engineer', role: 'Requester' },
          { name: 'Governance API', role: 'RBAC Guard' },
          { name: 'Cloud SQL', role: 'Approvals' },
          { name: 'DBA / Admin', role: 'Reviewer' },
          { name: 'Baseline Store', role: 'Catalog' },
          { name: 'Audit Log', role: 'Compliance' },
        ],
        steps: [
          {
            from: 0,
            to: 1,
            label: 'POST /api/approvals (databaseId, gitSha)',
            detail: 'Submits proposed live schema snapshot for production sign-off.',
          },
          {
            from: 1,
            to: 2,
            label: 'INSERT baseline_approval_requests (PENDING)',
            detail: 'Stores diff counts (+added, ~modified, -removed) and proposed SHA-256.',
          },
          {
            from: 1,
            to: 0,
            label: '201 Created (Pending Review)',
            detail: 'Request queued under Governance & Reports.',
            isReturn: true,
          },
          {
            from: 3,
            to: 1,
            label: 'POST /api/approvals/:id/review (APPROVED)',
            detail: 'Reviewer signs off with optional review note.',
            highlight: 'success',
          },
          {
            from: 1,
            to: 4,
            label: 'Promote new active schema_baselines row',
            detail: 'Updates baseline hash and auto-resolves open SCHEMA_DRIFT incidents.',
          },
          {
            from: 1,
            to: 5,
            label: 'Record BASELINE_APPROVAL_APPROVED',
            detail: 'Immutable actor, timestamp, and target audit trail entry.',
          },
          {
            from: 1,
            to: 3,
            label: '200 OK (Baseline Active & Target Nominal)',
            detail: 'Target health status refreshed immediately.',
            isReturn: true,
            highlight: 'success',
          },
        ],
      },
      'cicd-gate': {
        title: tr(
          'CI/CD Pre-Deploy Schema Drift Gate',
          'CI/CD Deploy မတိုင်မီ ဖွဲ့စည်းပုံ စစ်ဆေးဂိတ်'
        ),
        subtitle: tr(
          'Automated GitHub Actions / GitLab CI pipeline check that blocks deploys on undocumented drift.',
          'GitHub Actions / GitLab CI တွင် မမျှော်လင့်သော ဖွဲ့စည်းပုံ ကွာခြားချက်ရှိပါက Deploy ကို အလိုအလျောက် တားဆီးမှု။'
        ),
        participants: [
          { name: 'GitHub Actions', role: 'CI Runner' },
          { name: 'Express CI Gate', role: 'API Key Auth' },
          { name: 'Cloud SQL', role: 'Baselines' },
          { name: 'Target PG (RO)', role: 'Production' },
        ],
        steps: [
          {
            from: 0,
            to: 1,
            label: 'POST /api/ci/check-drift (X-DriftGuard-Key)',
            detail: 'Authenticates using hashed workspace CI/CD API key.',
          },
          {
            from: 1,
            to: 2,
            label: 'Verify SHA-256 API key & load baseline',
            detail: 'Rejects revoked or mismatched workspace keys with HTTP 401.',
          },
          {
            from: 1,
            to: 3,
            label: 'Scan live information_schema.columns',
            detail: 'Bounded read-only catalog inspection.',
          },
          {
            from: 3,
            to: 1,
            label: 'Live Canonical SHA-256',
            detail: 'Deterministic hash across schemas, tables, columns, defaults.',
            isReturn: true,
          },
          {
            from: 1,
            to: 0,
            label: '200 OK (Zero Drift — Safe to Deploy)',
            detail: 'Pipeline proceeds to application deployment.',
            isReturn: true,
            highlight: 'success',
          },
          {
            from: 1,
            to: 0,
            label: '409 Conflict (Drift Blocked + Revert SQL)',
            detail: 'Fails CI step before broken migration reaches production.',
            isReturn: true,
            highlight: 'critical',
          },
        ],
        altFrame: {
          startIndex: 4,
          endIndex: 5,
          label: 'alt [SHA matches baseline] / [else Drift detected]',
        },
      },
      'auto-reinspect': {
        title: tr(
          'Health Score Breach Auto Re-Inspection',
          'ကျန်းမာရေးရမှတ် ကျဆင်းမှု အလိုအလျောက် ပြန်စစ်ဆေးမှု'
        ),
        subtitle: tr(
          'Per-target threshold watcher with loop-free cooldown protection and maintenance window awareness.',
          'ဒေတာဘေ့စ်တစ်ခုချင်းစီ၏ ကျန်းမာရေးရမှတ် ကန့်သတ်ချက်နှင့် Cooldown / ပြုပြင်ထိန်းသိမ်းချိန် ကာကွယ်မှု။'
        ),
        participants: [
          { name: 'Threshold Watcher', role: '60s Loop' },
          { name: 'Health Scorer', role: '0-100 Rubric' },
          { name: 'Cooldown & Maint', role: 'Guard' },
          { name: 'Target PG (RO)', role: 'Verification' },
          { name: 'Audit Log', role: 'History' },
        ],
        steps: [
          {
            from: 0,
            to: 1,
            label: 'Compute target health score (0–100)',
            detail: 'Weights drift, critical/warning alerts, locks, bloat, cache hit & connections.',
          },
          {
            from: 1,
            to: 0,
            label: 'Score 64 < minHealthScore (80)',
            detail: 'Threshold breach identified for monitored database.',
            isReturn: true,
            highlight: 'warning',
          },
          {
            from: 0,
            to: 2,
            label: 'Check cooldown & active maintenance windows',
            detail: 'Prevents inspection storms and respects suppressAutoReinspect schedules.',
          },
          {
            from: 0,
            to: 4,
            label: 'Log AUTO_REINSPECT_TRIGGERED',
            detail: 'Records breach score and increments autoReinspectCount.',
          },
          {
            from: 0,
            to: 3,
            label: 'Run verification inspection (isAutoReinspect=true)',
            detail: 'Refreshes telemetry without triggering recursive re-inspection loops.',
            highlight: 'success',
          },
        ],
        altFrame: {
          startIndex: 3,
          endIndex: 4,
          label: 'opt [Outside cooldown & maintenance window]',
        },
      },
    }),
    [tr]
  );

  // ---------------------------------------------------------------------------
  // RENDERERS FOR EACH OF THE 7 INTERACTIVE VECTOR SVG DIAGRAMS
  // ---------------------------------------------------------------------------

  const renderUseCaseSvg = () => {
    const actors = [
      { id: 'admin', x: 92, y: 125, name: 'Workspace Admin', role: 'Manages targets, RBAC, maintenance windows, and approvals.' },
      { id: 'dba', x: 92, y: 310, name: 'DBA / SRE', role: 'Inspects live sessions, locks, bloat, XID wraparound, migration lints, and baselines.' },
      { id: 'viewer', x: 92, y: 490, name: 'Read-Only Viewer', role: 'Views dashboards, diagrams, and downloads executive PDF/CSV digests.' },
      { id: 'ci', x: 1025, y: 185, name: 'CI/CD Pipeline', role: 'Calls /api/ci/check-drift via scoped API key before deploying.' },
      { id: 'alerts', x: 1025, y: 430, name: 'Alert Channels', role: 'Receives filtered Slack, Discord, PagerDuty, or HTTP webhook notifications.' },
    ];

    const useCases = [
      { id: 'uc1', x: 385, y: 105, label: 'Register & Encrypt PG Target', detail: 'Validates TLS PostgreSQL URI and encrypts credentials with AES-256-GCM.' },
      { id: 'uc2', x: 385, y: 205, label: 'Inspect Schema & Drift Diff', detail: 'Computes canonical SHA-256 catalog hash, column diffs, and revert DDL.' },
      { id: 'uc3', x: 385, y: 305, label: 'Live Sessions, I/O & XID Ops', detail: 'Real-time pg_stat_activity, TPS, checkpoints, autovacuum & pg_settings audit.' },
      { id: 'uc4', x: 385, y: 405, label: 'Lint Migration DDL & Compare', detail: 'Detects ACCESS EXCLUSIVE lock hazards and diffs Staging vs Production.' },
      { id: 'uc5', x: 385, y: 505, label: 'Export Executive PDF Digest', detail: 'Generates 7d/30d fleet SLA scorecard reports in PDF, CSV, and JSON.' },
      { id: 'uc6', x: 710, y: 135, label: 'Approve Baseline Promotion', detail: 'Two-person governance workflow promoting baseline and resolving drift.' },
      { id: 'uc7', x: 710, y: 255, label: 'Schedule Maintenance Windows', detail: 'Silences outbound webhooks & auto re-inspections during UTC windows.' },
      { id: 'uc8', x: 710, y: 375, label: 'Dispatch Filtered Alerts', detail: 'Routes CRITICAL/WARNING incidents to active webhooks respecting maintenance.' },
      { id: 'uc9', x: 710, y: 490, label: 'Record Immutable Audit Log', detail: 'Captures actor, timestamp, entity, and summary for every mutation.' },
    ];

    const solidLinks: [string, string][] = [
      ['admin', 'uc1'],
      ['admin', 'uc6'],
      ['admin', 'uc7'],
      ['dba', 'uc2'],
      ['dba', 'uc3'],
      ['dba', 'uc4'],
      ['dba', 'uc6'],
      ['viewer', 'uc5'],
      ['ci', 'uc2'],
      ['ci', 'uc4'],
      ['alerts', 'uc8'],
    ];

    const dashedLinks: { from: string; to: string; stereo: string }[] = [
      { from: 'uc2', to: 'uc8', stereo: '«extend»' },
      { from: 'uc7', to: 'uc8', stereo: '«extend»' },
      { from: 'uc6', to: 'uc9', stereo: '«include»' },
      { from: 'uc1', to: 'uc9', stereo: '«include»' },
    ];

    const posMap = new Map<string, { x: number; y: number }>();
    actors.forEach((a) => posMap.set(a.id, { x: a.x, y: a.y }));
    useCases.forEach((u) => posMap.set(u.id, { x: u.x, y: u.y }));

    return (
      <svg
        ref={svgRef}
        viewBox="0 0 1120 600"
        className="w-full h-auto select-none"
      >
        <defs>
          <marker id="uml-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
            <path d="M1,1 L8,4.5 L1,8" fill="none" stroke={tc('#64748b', '#94a3b8')} strokeWidth="1.4" />
          </marker>
        </defs>

        {/* System Boundary */}
        <rect
          x="210"
          y="34"
          width="695"
          height="536"
          rx="12"
          fill={tc('#f8fafc', '#1e293b')}
          stroke={tc('#cbd5e1', '#334155')}
          strokeWidth="1.5"
        />
        <text x="557" y="60" textAnchor="middle" fontSize="13" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
          DriftGuard PostgreSQL Monitoring & Governance System
        </text>

        {/* Solid Actor-to-UseCase Associations */}
        {solidLinks.map(([fromId, toId]) => {
          const p1 = posMap.get(fromId)!;
          const p2 = posMap.get(toId)!;
          const x1 = p1.x < 200 ? p1.x + 28 : p1.x - 28;
          const x2 = p1.x < 200 ? p2.x - 122 : p2.x + 122;
          return (
            <line
              key={`${fromId}-${toId}`}
              x1={x1}
              y1={p1.y}
              x2={x2}
              y2={p2.y}
              stroke={tc('#94a3b8', '#64748b')}
              strokeWidth="1.35"
            />
          );
        })}

        {/* Dashed UML <<include>> / <<extend>> */}
        {dashedLinks.map((lnk) => {
          const p1 = posMap.get(lnk.from)!;
          const p2 = posMap.get(lnk.to)!;
          const midX = (p1.x + p2.x) / 2;
          const midY = (p1.y + p2.y) / 2;
          return (
            <g key={`${lnk.from}-${lnk.to}`}>
              <line
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke={tc('#64748b', '#94a3b8')}
                strokeWidth="1.3"
                strokeDasharray="5 4"
                markerEnd="url(#uml-arrow)"
              />
              <rect
                x={midX - 32}
                y={midY - 9}
                width="64"
                height="16"
                rx="3"
                fill={tc('#f8fafc', '#1e293b')}
              />
              <text
                x={midX}
                y={midY + 3}
                textAnchor="middle"
                fontSize="10"
                fontFamily="monospace"
                fill={tc('#475569', '#94a3b8')}
              >
                {lnk.stereo}
              </text>
            </g>
          );
        })}

        {/* Use Case Ellipses */}
        {useCases.map((u) => {
          const isSelected = selectedInfo?.title === u.label;
          return (
            <g
              key={u.id}
              onClick={() =>
                setSelectedInfo({
                  title: u.label,
                  category: 'UML Use Case',
                  description: u.detail,
                })
              }
              className="cursor-pointer"
            >
              <ellipse
                cx={u.x}
                cy={u.y}
                rx="124"
                ry="28"
                fill={isSelected ? tc('#eff6ff', '#172554') : tc('#ffffff', '#0f172a')}
                stroke={isSelected ? tc('#1d4ed8', '#60a5fa') : tc('#334155', '#cbd5e1')}
                strokeWidth={isSelected ? '2' : '1.3'}
              />
              <text
                x={u.x}
                y={u.y + 4}
                textAnchor="middle"
                fontSize="11.5"
                fontWeight="600"
                fill={tc('#0f172a', '#f1f5f9')}
              >
                {u.label}
              </text>
            </g>
          );
        })}

        {/* Stick-Figure UML Actors */}
        {actors.map((a) => {
          const isSelected = selectedInfo?.title === a.name;
          return (
            <g
              key={a.id}
              transform={`translate(${a.x}, ${a.y - 24})`}
              onClick={() =>
                setSelectedInfo({
                  title: a.name,
                  category: 'UML Actor',
                  description: a.role,
                })
              }
              className="cursor-pointer"
            >
              <circle
                cx="0"
                cy="0"
                r="11"
                fill={isSelected ? tc('#dbeafe', '#1e3a8a') : tc('#ffffff', '#0f172a')}
                stroke={isSelected ? tc('#1d4ed8', '#60a5fa') : tc('#0f172a', '#f1f5f9')}
                strokeWidth="1.8"
              />
              <line x1="0" y1="11" x2="0" y2="34" stroke={isSelected ? tc('#1d4ed8', '#60a5fa') : tc('#0f172a', '#f1f5f9')} strokeWidth="1.8" />
              <line x1="-15" y1="19" x2="15" y2="19" stroke={isSelected ? tc('#1d4ed8', '#60a5fa') : tc('#0f172a', '#f1f5f9')} strokeWidth="1.8" />
              <line x1="0" y1="34" x2="-13" y2="50" stroke={isSelected ? tc('#1d4ed8', '#60a5fa') : tc('#0f172a', '#f1f5f9')} strokeWidth="1.8" />
              <line x1="0" y1="34" x2="13" y2="50" stroke={isSelected ? tc('#1d4ed8', '#60a5fa') : tc('#0f172a', '#f1f5f9')} strokeWidth="1.8" />
              <text
                x="0"
                y="68"
                textAnchor="middle"
                fontSize="11.5"
                fontWeight="700"
                fill={tc('#0f172a', '#f1f5f9')}
              >
                {a.name}
              </text>
            </g>
          );
        })}
      </svg>
    );
  };

  const renderSequenceSvg = () => {
    const def = sequenceDefs[sequenceScenario];
    const count = def.participants.length;
    const width = 1120;
    const padX = 88;
    const spacing = count > 1 ? (width - padX * 2) / (count - 1) : 0;
    const topY = 26;
    const headerH = 46;
    const stepStartY = 118;
    const stepGap = 54;
    const height = Math.max(480, stepStartY + def.steps.length * stepGap + 60);

    return (
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto select-none"
      >
        <defs>
          <marker id="seq-solid" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
            <path d="M1,1 L8,4.5 L1,8 Z" fill={tc('#1e293b', '#e2e8f0')} />
          </marker>
          <marker id="seq-blue" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
            <path d="M1,1 L8,4.5 L1,8 Z" fill={tc('#1d4ed8', '#60a5fa')} />
          </marker>
          <marker id="seq-red" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
            <path d="M1,1 L8,4.5 L1,8 Z" fill={tc('#b91c1c', '#f87171')} />
          </marker>
          <marker id="seq-green" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
            <path d="M1,1 L8,4.5 L1,8 Z" fill={tc('#047857', '#34d399')} />
          </marker>
        </defs>

        {/* Optional Alt/Opt Combined Fragment Frame */}
        {def.altFrame && (() => {
          const y1 = stepStartY + def.altFrame.startIndex * stepGap - 26;
          const y2 = stepStartY + def.altFrame.endIndex * stepGap + 24;
          return (
            <g>
              <rect
                x="36"
                y={y1}
                width={width - 72}
                height={y2 - y1}
                rx="6"
                fill={tc('#f8fafc', '#1e293b')}
                fillOpacity="0.65"
                stroke={tc('#94a3b8', '#64748b')}
                strokeWidth="1.2"
                strokeDasharray="6 4"
              />
              <rect x="36" y={y1} width="265" height="20" rx="4" fill={tc('#e2e8f0', '#1e293b')} />
              <text
                x="46"
                y={y1 + 14}
                fontSize="10.5"
                fontFamily="monospace"
                fontWeight="600"
                fill={tc('#334155', '#cbd5e1')}
              >
                {def.altFrame.label}
              </text>
            </g>
          );
        })()}

        {/* Participant Boxes & Vertical Lifelines */}
        {def.participants.map((p, idx) => {
          const cx = padX + idx * spacing;
          return (
            <g key={p.name}>
              <line
                x1={cx}
                y1={topY + headerH}
                x2={cx}
                y2={height - 28}
                stroke={tc('#cbd5e1', '#334155')}
                strokeWidth="1.5"
                strokeDasharray="5 5"
              />
              <rect
                x={cx - 64}
                y={topY}
                width="128"
                height={headerH}
                rx="8"
                fill={tc('#ffffff', '#0f172a')}
                stroke={tc('#1e293b', '#e2e8f0')}
                strokeWidth="1.4"
              />
              <text
                x={cx}
                y={topY + 20}
                textAnchor="middle"
                fontSize="11.5"
                fontWeight="700"
                fill={tc('#0f172a', '#f1f5f9')}
              >
                {p.name}
              </text>
              <text
                x={cx}
                y={topY + 36}
                textAnchor="middle"
                fontSize="10"
                fontFamily="monospace"
                fill={tc('#64748b', '#94a3b8')}
              >
                {p.role}
              </text>
            </g>
          );
        })}

        {/* Sequence Messages */}
        {def.steps.map((step, idx) => {
          const y = stepStartY + idx * stepGap;
          const x1 = padX + step.from * spacing;
          const x2 = padX + step.to * spacing;
          const dir = x2 >= x1 ? 1 : -1;
          const midX = (x1 + x2) / 2;
          const strokeColor =
            step.highlight === 'critical'
              ? tc('#b91c1c', '#f87171')
              : step.highlight === 'success'
                ? tc('#047857', '#34d399')
                : step.highlight === 'warning'
                  ? tc('#b45309', '#fbbf24')
                  : tc('#1e293b', '#e2e8f0');
          const marker =
            step.highlight === 'critical'
              ? 'url(#seq-red)'
              : step.highlight === 'success'
                ? 'url(#seq-green)'
                : 'url(#seq-solid)';
          const isSelected = selectedInfo?.title === `${idx + 1}. ${step.label}`;

          return (
            <g
              key={`${idx}-${step.label}`}
              onClick={() =>
                setSelectedInfo({
                  title: `${idx + 1}. ${step.label}`,
                  category: `${def.participants[step.from].name} → ${def.participants[step.to].name}`,
                  description: step.detail,
                })
              }
              className="cursor-pointer"
            >
              {/* Activation ticks */}
              <rect
                x={x1 - 5}
                y={y - 10}
                width="10"
                height="24"
                rx="2"
                fill={isSelected ? tc('#dbeafe', '#1e3a8a') : tc('#f1f5f9', '#1e293b')}
                stroke={tc('#64748b', '#94a3b8')}
                strokeWidth="1"
              />
              <rect
                x={x2 - 5}
                y={y - 6}
                width="10"
                height="24"
                rx="2"
                fill={isSelected ? tc('#dbeafe', '#1e3a8a') : tc('#e2e8f0', '#1e293b')}
                stroke={tc('#475569', '#94a3b8')}
                strokeWidth="1"
              />

              <line
                x1={x1 + dir * 6}
                y1={y}
                x2={x2 - dir * 8}
                y2={y}
                stroke={isSelected ? tc('#1d4ed8', '#60a5fa') : strokeColor}
                strokeWidth={isSelected ? '2.4' : '1.7'}
                strokeDasharray={step.isReturn ? '6 4' : undefined}
                markerEnd={isSelected ? 'url(#seq-blue)' : marker}
              />

              <rect
                x={midX - Math.min(210, step.label.length * 3.5 + 18)}
                y={y - 22}
                width={Math.min(420, step.label.length * 7 + 36)}
                height="18"
                rx="4"
                fill={isSelected ? tc('#eff6ff', '#172554') : tc('#ffffff', '#0f172a')}
              />
              <text
                x={midX}
                y={y - 9}
                textAnchor="middle"
                fontSize="11"
                fontFamily="monospace"
                fontWeight={isSelected ? '700' : '600'}
                fill={isSelected ? tc('#1d4ed8', '#60a5fa') : strokeColor}
              >
                {idx + 1}. {step.label}
              </text>
            </g>
          );
        })}
      </svg>
    );
  };

  const renderArchitectureSvg = () => {
    const fleet = databases.slice(0, 4);
    const fleetDisplay =
      fleet.length > 0
        ? fleet
        : [
            {
              id: 'sample-pg',
              name: 'prod-primary-pg',
              environment: 'production' as const,
              lastHealthStatus: 'HEALTHY' as const,
            },
          ];

    return (
      <svg
        ref={svgRef}
        viewBox="0 0 1120 590"
        className="w-full h-auto select-none"
      >
        <defs>
          <marker id="arch-arr" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
            <path d="M1,1 L8,4.5 L1,8 Z" fill={tc('#475569', '#94a3b8')} />
          </marker>
        </defs>

        {/* Tier 1: Client SPA */}
        <rect x="30" y="30" width="235" height="530" rx="10" fill={tc('#f8fafc', '#1e293b')} stroke={tc('#cbd5e1', '#334155')} strokeWidth="1.4" />
        <text x="147" y="56" textAnchor="middle" fontSize="12" fontWeight="700" fill={tc('#334155', '#cbd5e1')}>
          1. Client Workspace
        </text>
        {[
          { y: 85, title: 'React 19 + Tailwind SPA', sub: 'EN / MY · Tabular Telemetry UI', desc: 'Single-page web application with live polling, interactive SVG diagrams, and CSV/PDF export.' },
          { y: 195, title: 'Firebase Auth SDK', sub: 'Bearer ID Tokens + Demo Mode', desc: 'Authenticates every API request via verified ID tokens or isolated signed demo sessions.' },
          { y: 305, title: 'Interactive Diagram & ERD', sub: 'Pan/Zoom · SVG/PNG · Mermaid', desc: 'Renders live-hydrated UML, DFD, State, ERD, and Replication topology views.' },
          { y: 415, title: 'Live Ops & Alert Console', sub: '5s Auto-Refresh · Incident Feed', desc: 'Monitors TPS, sessions, lock trees, XID wraparound, and migration safety.' },
        ].map((box) => (
          <g
            key={box.title}
            onClick={() =>
              setSelectedInfo({
                title: box.title,
                category: 'Client Presentation Layer',
                description: box.desc,
              })
            }
            className="cursor-pointer"
          >
            <rect x="48" y={box.y} width="199" height="78" rx="8" fill={tc('#ffffff', '#0f172a')} stroke={tc('#1d4ed8', '#60a5fa')} strokeWidth="1.3" />
            <text x="147" y={box.y + 32} textAnchor="middle" fontSize="11.5" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
              {box.title}
            </text>
            <text x="147" y={box.y + 52} textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#64748b', '#94a3b8')}>
              {box.sub}
            </text>
          </g>
        ))}

        {/* Tier 2: Express Server & Security */}
        <rect x="315" y="30" width="335" height="530" rx="10" fill={tc('#f8fafc', '#1e293b')} stroke={tc('#cbd5e1', '#334155')} strokeWidth="1.4" />
        <text x="482" y="56" textAnchor="middle" fontSize="12" fontWeight="700" fill={tc('#334155', '#cbd5e1')}>
          2. Express API & Security Plane
        </text>
        {[
          { y: 85, title: 'Auth & Zod Validation Guard', sub: 'requireAuth · UUID & Schema Validation', desc: 'Verifies user ownership on every database, policy, webhook, and approval mutation.' },
          { y: 195, title: 'AES-256-GCM Credential Vault', sub: 'Encrypted PG URIs · Host Allowlist', desc: 'Encrypts external PostgreSQL URIs at rest using authenticated symmetric encryption.' },
          { y: 305, title: 'Read-Only Telemetry & Drift Engine', sub: 'BEGIN READ ONLY · 4s Statement Timeout', desc: 'Executes bounded catalog, pg_stat_activity, EXPLAIN, replication, and XID queries.' },
          { y: 415, title: 'Governance, Watcher & PDF Engine', sub: 'Approvals · Maint. Gate · PDFKit', desc: 'Evaluates custom health thresholds, silences alerts during windows, and renders executive PDFs.' },
        ].map((box) => (
          <g
            key={box.title}
            onClick={() =>
              setSelectedInfo({
                title: box.title,
                category: 'Application & Security Layer',
                description: box.desc,
              })
            }
            className="cursor-pointer"
          >
            <rect x="335" y={box.y} width="295" height="78" rx="8" fill={tc('#ffffff', '#0f172a')} stroke={tc('#0f172a', '#f1f5f9')} strokeWidth="1.3" />
            <text x="482" y={box.y + 32} textAnchor="middle" fontSize="11.5" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
              {box.title}
            </text>
            <text x="482" y={box.y + 52} textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#475569', '#94a3b8')}>
              {box.sub}
            </text>
          </g>
        ))}

        {/* Tier 3: Data & External Infrastructure */}
        <rect x="705" y="30" width="385" height="175" rx="10" fill={tc('#f8fafc', '#1e293b')} stroke={tc('#cbd5e1', '#334155')} strokeWidth="1.4" />
        <text x="897" y="55" textAnchor="middle" fontSize="12" fontWeight="700" fill={tc('#334155', '#cbd5e1')}>
          3A. Cloud SQL Metadata Store
        </text>
        <g
          onClick={() =>
            setSelectedInfo({
              title: 'Cloud SQL PostgreSQL (14 Tables)',
              category: 'Primary Persistence',
              description:
                'Stores users, monitored_databases, schema_baselines, telemetry_snapshots, telemetry_incidents, webhooks, thresholds, maintenance_windows, team_members, approvals, and audit_logs via Drizzle ORM.',
            })
          }
          className="cursor-pointer"
        >
          <rect x="728" y="74" width="339" height="110" rx="8" fill={tc('#ffffff', '#0f172a')} stroke={tc('#047857', '#34d399')} strokeWidth="1.5" />
          <text x="897" y="106" textAnchor="middle" fontSize="12.5" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
            Cloud SQL PostgreSQL (Drizzle ORM)
          </text>
          <text x="897" y="130" textAnchor="middle" fontSize="10.5" fontFamily="monospace" fill={tc('#475569', '#94a3b8')}>
            baselines · snapshots · incidents · thresholds
          </text>
          <text x="897" y="150" textAnchor="middle" fontSize="10.5" fontFamily="monospace" fill={tc('#475569', '#94a3b8')}>
            approvals · maintenance_windows · team_members · audit_logs
          </text>
        </g>

        {/* Live Monitored Fleet */}
        <rect x="705" y="225" width="385" height="225" rx="10" fill={tc('#f8fafc', '#1e293b')} stroke={tc('#cbd5e1', '#334155')} strokeWidth="1.4" />
        <text x="897" y="250" textAnchor="middle" fontSize="12" fontWeight="700" fill={tc('#334155', '#cbd5e1')}>
          3B. Monitored PostgreSQL Fleet ({databases.length || 1} live)
        </text>
        {fleetDisplay.map((dbItem, idx) => {
          const col = idx % 2;
          const row = Math.floor(idx / 2);
          const x = 725 + col * 178;
          const y = 268 + row * 82;
          const stroke =
            dbItem.lastHealthStatus === 'DRIFT' || dbItem.lastHealthStatus === 'ERROR'
              ? tc('#dc2626', '#f87171')
              : dbItem.lastHealthStatus === 'WARNING'
                ? tc('#d97706', '#fbbf24')
                : tc('#16a34a', '#4ade80');
          return (
            <g
              key={dbItem.id}
              onClick={() =>
                setSelectedInfo({
                  title: dbItem.name,
                  category: `Monitored Target · ${formatEnv(dbItem.environment)}`,
                  description: `Current status: ${dbItem.lastHealthStatus}. Queried strictly in READ ONLY transactions with bounded timeouts.`,
                })
              }
              className="cursor-pointer"
            >
              <rect x={x} y={y} width="166" height="68" rx="8" fill={tc('#ffffff', '#0f172a')} stroke={stroke} strokeWidth="1.5" />
              <text x={x + 83} y={y + 28} textAnchor="middle" fontSize="11" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
                {dbItem.name.length > 20 ? `${dbItem.name.slice(0, 19)}…` : dbItem.name}
              </text>
              <text x={x + 83} y={y + 48} textAnchor="middle" fontSize="10" fontFamily="monospace" fill={stroke}>
                {dbItem.environment} · {dbItem.lastHealthStatus}
              </text>
            </g>
          );
        })}

        {/* Outbound Alert Channels */}
        <rect x="705" y="470" width="385" height="90" rx="10" fill={tc('#f8fafc', '#1e293b')} stroke={tc('#cbd5e1', '#334155')} strokeWidth="1.4" />
        <text x="897" y="494" textAnchor="middle" fontSize="12" fontWeight="700" fill={tc('#334155', '#cbd5e1')}>
          3C. Outbound Alert Channels ({webhooks.length} configured)
        </text>
        <text x="897" y="528" textAnchor="middle" fontSize="11" fontFamily="monospace" fill={tc('#475569', '#94a3b8')}>
          Slack · Discord · PagerDuty · Generic HTTPS Webhooks
        </text>

        {/* Connector Arrows */}
        <line x1="265" y1="125" x2="333" y2="125" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.6" markerEnd="url(#arch-arr)" />
        <line x1="265" y1="235" x2="333" y2="235" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.6" markerEnd="url(#arch-arr)" />
        <line x1="630" y1="130" x2="726" y2="130" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.6" markerEnd="url(#arch-arr)" />
        <line x1="630" y1="340" x2="703" y2="340" stroke={tc('#1d4ed8', '#60a5fa')} strokeWidth="1.6" strokeDasharray="5 3" markerEnd="url(#arch-arr)" />
        <line x1="630" y1="455" x2="703" y2="510" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.6" markerEnd="url(#arch-arr)" />
      </svg>
    );
  };

  const renderDfdSvg = () => {
    const processes = [
      { id: 'P1', x: 350, y: 140, num: '1.0', title: 'Catalog & Schema\nHarvester', desc: 'Connects in READ ONLY mode to extract information_schema columns, PKs, FKs, and role grants.' },
      { id: 'P2', x: 640, y: 140, num: '2.0', title: 'Drift Diff &\nMigration Linter', desc: 'Computes deterministic SHA-256 hashes, column diffs, revert SQL, and lock hazard reports.' },
      { id: 'P3', x: 350, y: 410, num: '3.0', title: 'Live Telemetry &\nXID Collector', desc: 'Collects pg_stat_activity, pg_stat_database, bgwriter checkpoints, replication lag & XID wraparound.' },
      { id: 'P4', x: 640, y: 410, num: '4.0', title: 'Governance, Digest\n& Alert Router', desc: 'Evaluates thresholds, checks maintenance windows, manages approvals, and renders executive PDFs.' },
    ];

    const stores = [
      { id: 'D1', x: 890, y: 90, label: 'D1 | monitored_databases' },
      { id: 'D2', x: 890, y: 180, label: 'D2 | schema_baselines' },
      { id: 'D3', x: 890, y: 270, label: 'D3 | telemetry_snapshots' },
      { id: 'D4', x: 890, y: 360, label: 'D4 | telemetry_incidents' },
      { id: 'D5', x: 890, y: 450, label: 'D5 | governance_policies' },
    ];

    return (
      <svg ref={svgRef} viewBox="0 0 1120 560" className="w-full h-auto select-none">
        <defs>
          <marker id="dfd-arr" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
            <path d="M1,1 L8,4.5 L1,8 Z" fill={tc('#475569', '#94a3b8')} />
          </marker>
        </defs>

        {/* External Entities (Rectangles) */}
        {[
          { x: 30, y: 80, w: 165, h: 64, label: 'Operator / DBA', desc: 'Registers targets, runs inspections, reviews approvals, and exports reports.' },
          { x: 30, y: 215, w: 165, h: 64, label: 'CI/CD Pipeline', desc: 'Calls schema drift gate before deploying migrations.' },
          { x: 30, y: 350, w: 165, h: 64, label: 'Target PostgreSQL', desc: 'Monitored PostgreSQL clusters queried read-only over TLS.' },
          { x: 30, y: 465, w: 165, h: 64, label: 'Alert Channels', desc: 'Slack, Discord, PagerDuty, and generic HTTPS webhook endpoints.' },
        ].map((ent) => (
          <g
            key={ent.label}
            onClick={() =>
              setSelectedInfo({
                title: ent.label,
                category: 'DFD External Entity',
                description: ent.desc,
              })
            }
            className="cursor-pointer"
          >
            <rect x={ent.x} y={ent.y} width={ent.w} height={ent.h} rx="4" fill={tc('#ffffff', '#0f172a')} stroke={tc('#0f172a', '#f1f5f9')} strokeWidth="1.8" />
            <text x={ent.x + ent.w / 2} y={ent.y + 36} textAnchor="middle" fontSize="12" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
              {ent.label}
            </text>
          </g>
        ))}

        {/* Flow Connectors */}
        <line x1="195" y1="112" x2="278" y2="128" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.5" markerEnd="url(#dfd-arr)" />
        <line x1="195" y1="247" x2="572" y2="178" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.5" markerEnd="url(#dfd-arr)" />
        <line x1="195" y1="382" x2="278" y2="402" stroke={tc('#1d4ed8', '#60a5fa')} strokeWidth="1.5" markerEnd="url(#dfd-arr)" />
        <line x1="195" y1="365" x2="292" y2="188" stroke={tc('#1d4ed8', '#60a5fa')} strokeWidth="1.4" strokeDasharray="5 3" markerEnd="url(#dfd-arr)" />
        <line x1="422" y1="140" x2="565" y2="140" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.6" markerEnd="url(#dfd-arr)" />
        <line x1="422" y1="410" x2="565" y2="410" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.6" markerEnd="url(#dfd-arr)" />
        <line x1="640" y1="210" x2="640" y2="338" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.5" markerEnd="url(#dfd-arr)" />
        <line x1="572" y1="448" x2="197" y2="495" stroke={tc('#b91c1c', '#f87171')} strokeWidth="1.5" markerEnd="url(#dfd-arr)" />

        {/* Flows to Data Stores */}
        <line x1="712" y1="124" x2="886" y2="112" stroke={tc('#64748b', '#94a3b8')} strokeWidth="1.4" markerEnd="url(#dfd-arr)" />
        <line x1="712" y1="150" x2="886" y2="202" stroke={tc('#64748b', '#94a3b8')} strokeWidth="1.4" markerEnd="url(#dfd-arr)" />
        <line x1="416" y1="376" x2="886" y2="294" stroke={tc('#64748b', '#94a3b8')} strokeWidth="1.4" markerEnd="url(#dfd-arr)" />
        <line x1="712" y1="395" x2="886" y2="382" stroke={tc('#64748b', '#94a3b8')} strokeWidth="1.4" markerEnd="url(#dfd-arr)" />
        <line x1="712" y1="425" x2="886" y2="472" stroke={tc('#64748b', '#94a3b8')} strokeWidth="1.4" markerEnd="url(#dfd-arr)" />

        {/* Labels on Key Flows */}
        <text x="492" y="130" textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#475569', '#94a3b8')}>
          Canonical SHA-256
        </text>
        <text x="492" y="400" textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#475569', '#94a3b8')}>
          Health Score + Events
        </text>
        <text x="390" y="492" textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#b91c1c', '#f87171')}>
          Filtered Webhook Alerts
        </text>

        {/* Numbered Processes (Circles) */}
        {processes.map((proc) => (
          <g
            key={proc.id}
            onClick={() =>
              setSelectedInfo({
                title: `${proc.num} ${proc.title.replace('\n', ' ')}`,
                category: 'DFD Process',
                description: proc.desc,
              })
            }
            className="cursor-pointer"
          >
            <circle cx={proc.x} cy={proc.y} r="70" fill={tc('#eff6ff', '#172554')} stroke={tc('#1d4ed8', '#60a5fa')} strokeWidth="1.8" />
            <line x1={proc.x - 62} y1={proc.y - 22} x2={proc.x + 62} y2={proc.y - 22} stroke={tc('#93c5fd', '#3b82f6')} strokeWidth="1.2" />
            <text x={proc.x} y={proc.y - 32} textAnchor="middle" fontSize="11.5" fontFamily="monospace" fontWeight="700" fill={tc('#1d4ed8', '#60a5fa')}>
              {proc.num}
            </text>
            {proc.title.split('\n').map((line, i) => (
              <text
                key={line}
                x={proc.x}
                y={proc.y + 4 + i * 16}
                textAnchor="middle"
                fontSize="11.5"
                fontWeight="700"
                fill={tc('#0f172a', '#f1f5f9')}
              >
                {line}
              </text>
            ))}
          </g>
        ))}

        {/* Open-Ended Data Stores */}
        {stores.map((st) => (
          <g
            key={st.id}
            onClick={() =>
              setSelectedInfo({
                title: st.label,
                category: 'DFD Data Store (Cloud SQL)',
                description: `Relational PostgreSQL persistence backing ${st.label}.`,
              })
            }
            className="cursor-pointer"
          >
            <rect x={st.x} y={st.y} width="205" height="44" fill={tc('#ffffff', '#0f172a')} />
            <line x1={st.x} y1={st.y} x2={st.x + 205} y2={st.y} stroke={tc('#0f172a', '#f1f5f9')} strokeWidth="1.6" />
            <line x1={st.x} y1={st.y + 44} x2={st.x + 205} y2={st.y + 44} stroke={tc('#0f172a', '#f1f5f9')} strokeWidth="1.6" />
            <line x1={st.x} y1={st.y} x2={st.x} y2={st.y + 44} stroke={tc('#0f172a', '#f1f5f9')} strokeWidth="1.6" />
            <text x={st.x + 12} y={st.y + 26} fontSize="11" fontFamily="monospace" fontWeight="600" fill={tc('#0f172a', '#f1f5f9')}>
              {st.label}
            </text>
          </g>
        ))}
      </svg>
    );
  };

  const renderStateSvg = () => {
    const states = [
      { id: 'PENDING', x: 130, y: 170, color: tc('#475569', '#94a3b8'), bg: tc('#f8fafc', '#1e293b'), desc: 'Target newly added; awaiting first read-only inspection.' },
      { id: 'HEALTHY', x: 420, y: 170, color: tc('#047857', '#34d399'), bg: tc('#ecfdf5', '#064e3b'), desc: 'Live SHA-256 matches baseline and all telemetry metrics are nominal.' },
      { id: 'WARNING', x: 760, y: 95, color: tc('#b45309', '#fbbf24'), bg: tc('#fffbeb', '#451a03'), desc: 'Active lock contention, index bloat, dead tuples, or cache saturation.' },
      { id: 'DRIFT', x: 760, y: 245, color: tc('#b91c1c', '#f87171'), bg: tc('#fef2f2', '#450a0a'), desc: 'Live schema SHA-256 diverged from stored Git baseline.' },
      { id: 'ERROR', x: 420, y: 345, color: tc('#991b1b', '#fca5a5'), bg: tc('#fef2f2', '#450a0a'), desc: 'Target unreachable, TLS failure, or invalid credentials.' },
    ];

    return (
      <svg ref={svgRef} viewBox="0 0 1120 550" className="w-full h-auto select-none">
        <defs>
          <marker id="st-arr" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
            <path d="M1,1 L8,4.5 L1,8 Z" fill={tc('#475569', '#94a3b8')} />
          </marker>
        </defs>

        {/* Top Region: Target Health State Machine */}
        <rect x="28" y="24" width="1064" height="368" rx="10" fill={tc('#f8fafc', '#1e293b')} stroke={tc('#cbd5e1', '#334155')} strokeWidth="1.3" />
        <text x="52" y="50" fontSize="12.5" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
          Monitored Target Health Lifecycle (UML State Machine)
        </text>

        {/* Initial Pseudostate */}
        <circle cx="62" cy="198" r="10" fill={tc('#0f172a', '#f1f5f9')} />
        <line x1="72" y1="198" x2="126" y2="198" stroke={tc('#0f172a', '#f1f5f9')} strokeWidth="1.6" markerEnd="url(#st-arr)" />

        {/* Transitions */}
        <line x1="274" y1="198" x2="416" y2="198" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.6" markerEnd="url(#st-arr)" />
        <text x="345" y="188" textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#475569', '#94a3b8')}>
          [scan nominal]
        </text>

        <path d="M 564 185 Q 660 120 756 120" fill="none" stroke={tc('#b45309', '#fbbf24')} strokeWidth="1.6" markerEnd="url(#st-arr)" />
        <text x="655" y="114" textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#b45309', '#fbbf24')}>
          [lock / bloat / cache]
        </text>

        <path d="M 564 212 Q 660 272 756 272" fill="none" stroke={tc('#b91c1c', '#f87171')} strokeWidth="1.6" markerEnd="url(#st-arr)" />
        <text x="655" y="294" textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#b91c1c', '#f87171')}>
          [SHA != baseline]
        </text>

        <path d="M 760 250 Q 660 218 566 205" fill="none" stroke={tc('#047857', '#34d399')} strokeWidth="1.5" strokeDasharray="5 3" markerEnd="url(#st-arr)" />
        <text x="658" y="218" textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#047857', '#34d399')}>
          [baseline promoted]
        </text>

        <line x1="492" y1="228" x2="492" y2="341" stroke={tc('#991b1b', '#fca5a5')} strokeWidth="1.5" markerEnd="url(#st-arr)" />
        <text x="556" y="290" textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#991b1b', '#fca5a5')}>
          [connection fail]
        </text>

        {states.map((st) => (
          <g
            key={st.id}
            onClick={() =>
              setSelectedInfo({
                title: st.id,
                category: 'Target Health State',
                description: st.desc,
              })
            }
            className="cursor-pointer"
          >
            <rect x={st.x} y={st.y} width="144" height="56" rx="14" fill={st.bg} stroke={st.color} strokeWidth="1.8" />
            <text x={st.x + 72} y={st.y + 33} textAnchor="middle" fontSize="12.5" fontFamily="monospace" fontWeight="700" fill={st.color}>
              {st.id}
            </text>
          </g>
        ))}

        {/* Bottom Region: Incident & Approval Sub-State Machines */}
        <rect x="28" y="410" width="520" height="120" rx="10" fill={tc('#ffffff', '#0f172a')} stroke={tc('#cbd5e1', '#334155')} strokeWidth="1.3" />
        <text x="48" y="435" fontSize="12" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
          Incident Resolution Lifecycle
        </text>
        {[
          { x: 52, label: 'OPEN', color: tc('#b91c1c', '#f87171') },
          { x: 214, label: 'ACKNOWLEDGED', color: tc('#b45309', '#fbbf24') },
          { x: 396, label: 'RESOLVED', color: tc('#047857', '#34d399') },
        ].map((inc) => (
          <g key={inc.label}>
            <rect x={inc.x} y="458" width="128" height="44" rx="10" fill={tc('#f8fafc', '#1e293b')} stroke={inc.color} strokeWidth="1.6" />
            <text x={inc.x + 64} y="485" textAnchor="middle" fontSize="11" fontFamily="monospace" fontWeight="700" fill={inc.color}>
              {inc.label}
            </text>
          </g>
        ))}
        <line x1="180" y1="480" x2="210" y2="480" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.5" markerEnd="url(#st-arr)" />
        <line x1="342" y1="480" x2="392" y2="480" stroke={tc('#475569', '#94a3b8')} strokeWidth="1.5" markerEnd="url(#st-arr)" />

        <rect x="572" y="410" width="520" height="120" rx="10" fill={tc('#ffffff', '#0f172a')} stroke={tc('#cbd5e1', '#334155')} strokeWidth="1.3" />
        <text x="592" y="435" fontSize="12" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
          Baseline Approval Governance Lifecycle
        </text>
        {[
          { x: 600, label: 'PENDING', color: tc('#1d4ed8', '#60a5fa') },
          { x: 774, label: 'APPROVED', color: tc('#047857', '#34d399') },
          { x: 942, label: 'REJECTED', color: tc('#b91c1c', '#f87171') },
        ].map((ap) => (
          <g key={ap.label}>
            <rect x={ap.x} y="458" width="124" height="44" rx="10" fill={tc('#f8fafc', '#1e293b')} stroke={ap.color} strokeWidth="1.6" />
            <text x={ap.x + 62} y="485" textAnchor="middle" fontSize="11" fontFamily="monospace" fontWeight="700" fill={ap.color}>
              {ap.label}
            </text>
          </g>
        ))}
        <line x1="724" y1="480" x2="770" y2="480" stroke={tc('#047857', '#34d399')} strokeWidth="1.5" markerEnd="url(#st-arr)" />
        <path d="M 662 502 Q 830 526 1004 504" fill="none" stroke={tc('#b91c1c', '#f87171')} strokeWidth="1.4" strokeDasharray="4 3" markerEnd="url(#st-arr)" />
      </svg>
    );
  };

  const renderErdSvg = () => {
    const tables =
      erdMode === 'target' && targetErd && targetErd.tables.length > 0
        ? targetErd.tables.slice(0, 8).map((t) => ({
            id: t.id,
            name: `${t.schema}.${t.name}`,
            cols: t.columns.slice(0, 5).map((c) => ({
              name: c.name,
              type: c.dataType,
              tag: c.isPrimaryKey ? 'PK' : c.isForeignKey ? 'FK' : '',
            })),
          }))
        : [
            {
              id: 'users',
              name: 'users',
              cols: [
                { name: 'uid', type: 'text', tag: 'PK' },
                { name: 'email', type: 'text', tag: '' },
                { name: 'created_at', type: 'timestamptz', tag: '' },
              ],
            },
            {
              id: 'monitored_databases',
              name: 'monitored_databases',
              cols: [
                { name: 'id', type: 'uuid', tag: 'PK' },
                { name: 'owner_uid', type: 'text', tag: 'FK' },
                { name: 'name', type: 'text', tag: '' },
                { name: 'environment', type: 'text', tag: '' },
                { name: 'last_health_status', type: 'text', tag: '' },
              ],
            },
            {
              id: 'schema_baselines',
              name: 'schema_baselines',
              cols: [
                { name: 'id', type: 'uuid', tag: 'PK' },
                { name: 'database_id', type: 'uuid', tag: 'FK' },
                { name: 'schema_hash', type: 'text', tag: '' },
                { name: 'git_commit_sha', type: 'text', tag: '' },
              ],
            },
            {
              id: 'telemetry_snapshots',
              name: 'telemetry_snapshots',
              cols: [
                { name: 'id', type: 'uuid', tag: 'PK' },
                { name: 'database_id', type: 'uuid', tag: 'FK' },
                { name: 'schema_hash', type: 'text', tag: '' },
                { name: 'health_json', type: 'jsonb', tag: '' },
              ],
            },
            {
              id: 'telemetry_incidents',
              name: 'telemetry_incidents',
              cols: [
                { name: 'id', type: 'uuid', tag: 'PK' },
                { name: 'database_id', type: 'uuid', tag: 'FK' },
                { name: 'incident_type', type: 'text', tag: '' },
                { name: 'severity / status', type: 'text', tag: '' },
              ],
            },
            {
              id: 'target_health_thresholds',
              name: 'target_health_thresholds',
              cols: [
                { name: 'database_id', type: 'uuid', tag: 'PK/FK' },
                { name: 'min_health_score', type: 'int', tag: '' },
                { name: 'cooldown_minutes', type: 'int', tag: '' },
              ],
            },
            {
              id: 'baseline_approval_requests',
              name: 'baseline_approval_requests',
              cols: [
                { name: 'id', type: 'uuid', tag: 'PK' },
                { name: 'database_id', type: 'uuid', tag: 'FK' },
                { name: 'proposed_hash', type: 'text', tag: '' },
                { name: 'status', type: 'text', tag: '' },
              ],
            },
            {
              id: 'maintenance_windows',
              name: 'maintenance_windows',
              cols: [
                { name: 'id', type: 'uuid', tag: 'PK' },
                { name: 'owner_uid', type: 'text', tag: 'FK' },
                { name: 'start_time_utc', type: 'text', tag: '' },
                { name: 'suppress_webhooks', type: 'bool', tag: '' },
              ],
            },
          ];

    const cardW = 240;
    const colsPerRow = 4;
    const positioned = tables.map((t, i) => {
      const col = i % colsPerRow;
      const row = Math.floor(i / colsPerRow);
      return {
        ...t,
        x: 34 + col * 268,
        y: 44 + row * 250,
        h: 36 + t.cols.length * 24 + 10,
      };
    });

    const posById = new Map(positioned.map((p) => [p.id, p]));
    const edges =
      erdMode === 'target' && targetErd
        ? targetErd.edges.map((e) => ({
            from: e.sourceTableId,
            to: e.targetTableId,
            label: e.sourceColumn,
          }))
        : [
            { from: 'monitored_databases', to: 'users', label: 'owner_uid' },
            { from: 'maintenance_windows', to: 'users', label: 'owner_uid' },
            { from: 'schema_baselines', to: 'monitored_databases', label: 'database_id' },
            { from: 'telemetry_snapshots', to: 'monitored_databases', label: 'database_id' },
            { from: 'telemetry_incidents', to: 'monitored_databases', label: 'database_id' },
            { from: 'target_health_thresholds', to: 'monitored_databases', label: 'database_id' },
            { from: 'baseline_approval_requests', to: 'monitored_databases', label: 'database_id' },
          ];

    return (
      <svg ref={svgRef} viewBox="0 0 1120 555" className="w-full h-auto select-none">
        <defs>
          <marker id="erd-arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M1,1 L7,4 L1,7" fill="none" stroke={tc('#1d4ed8', '#60a5fa')} strokeWidth="1.4" />
          </marker>
        </defs>

        {/* Relationship Curves */}
        {edges.map((e, i) => {
          const a = posById.get(e.from);
          const b = posById.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + cardW / 2;
          const y1 = a.y + a.h / 2;
          const x2 = b.x + cardW / 2;
          const y2 = b.y + b.h / 2;
          return (
            <line
              key={`${e.from}-${e.to}-${i}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={tc('#93c5fd', '#3b82f6')}
              strokeWidth="1.6"
              markerEnd="url(#erd-arr)"
            />
          );
        })}

        {/* Entity Boxes */}
        {positioned.map((t) => (
          <g
            key={t.id}
            onClick={() =>
              setSelectedInfo({
                title: t.name,
                category: erdMode === 'target' ? 'Live Target Table' : 'Cloud SQL Metadata Table',
                description: `Columns: ${t.cols.map((c) => `${c.name} (${c.type})`).join(', ')}`,
              })
            }
            className="cursor-pointer"
          >
            <rect x={t.x} y={t.y} width={cardW} height={t.h} rx="8" fill={tc('#ffffff', '#0f172a')} stroke={tc('#334155', '#cbd5e1')} strokeWidth="1.4" />
            <rect x={t.x} y={t.y} width={cardW} height="34" rx="8" fill={tc('#0f172a', '#f1f5f9')} />
            <rect x={t.x} y={t.y + 24} width={cardW} height="10" fill={tc('#0f172a', '#f1f5f9')} />
            <text x={t.x + 12} y={t.y + 21} fontSize="11.5" fontFamily="monospace" fontWeight="700" fill={tc('#ffffff', '#0f172a')}>
              {t.name.length > 26 ? `${t.name.slice(0, 25)}…` : t.name}
            </text>
            {t.cols.map((c, idx) => (
              <g key={c.name}>
                <text x={t.x + 12} y={t.y + 52 + idx * 24} fontSize="10.5" fontFamily="monospace" fontWeight={c.tag ? '700' : '400'} fill={tc('#0f172a', '#f1f5f9')}>
                  {c.tag ? `[${c.tag}] ` : ''}{c.name}
                </text>
                <text x={t.x + cardW - 10} y={t.y + 52 + idx * 24} textAnchor="end" fontSize="10" fontFamily="monospace" fill={tc('#64748b', '#94a3b8')}>
                  {c.type.slice(0, 12)}
                </text>
              </g>
            ))}
          </g>
        ))}
      </svg>
    );
  };

  const renderReplicationSvg = () => {
    const primaryLabel =
      replication?.targetLabel ?? databases[0]?.name ?? 'prod-primary-pg';
    const standbys = replication?.standbys ?? [];
    const slots = replication?.slots ?? [];

    return (
      <svg ref={svgRef} viewBox="0 0 1120 520" className="w-full h-auto select-none">
        <defs>
          <marker id="rep-arr" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
            <path d="M1,1 L8,4.5 L1,8 Z" fill={tc('#1d4ed8', '#60a5fa')} />
          </marker>
        </defs>

        {/* Application Traffic Layer */}
        <rect x="34" y="160" width="180" height="72" rx="8" fill={tc('#ffffff', '#0f172a')} stroke={tc('#0f172a', '#f1f5f9')} strokeWidth="1.5" />
        <text x="124" y="191" textAnchor="middle" fontSize="12" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
          OLTP Write Services
        </text>
        <text x="124" y="211" textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#64748b', '#94a3b8')}>
          PgBouncer RW Pool
        </text>

        <line x1="214" y1="196" x2="296" y2="196" stroke={tc('#1d4ed8', '#60a5fa')} strokeWidth="1.8" markerEnd="url(#rep-arr)" />

        {/* Primary Writer Node */}
        <g
          onClick={() =>
            setSelectedInfo({
              title: primaryLabel,
              category: 'Primary Read-Write PostgreSQL Node',
              description: `Streaming WAL to ${standbys.length} standby replica(s) with ${slots.length} tracked replication slot(s).`,
            })
          }
          className="cursor-pointer"
        >
          <rect x="300" y="142" width="220" height="108" rx="10" fill={tc('#eff6ff', '#172554')} stroke={tc('#1d4ed8', '#60a5fa')} strokeWidth="2" />
          <text x="410" y="176" textAnchor="middle" fontSize="13" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
            {primaryLabel}
          </text>
          <text x="410" y="198" textAnchor="middle" fontSize="10.5" fontFamily="monospace" fill={tc('#1d4ed8', '#60a5fa')}>
            PRIMARY WRITER · WAL SENDER
          </text>
          <text x="410" y="220" textAnchor="middle" fontSize="10" fontFamily="monospace" fill={tc('#475569', '#94a3b8')}>
            {standbys.length} standbys · {slots.length} WAL slots
          </text>
        </g>

        {/* Standby Replicas */}
        {(standbys.length > 0
          ? standbys.slice(0, 3)
          : [
              {
                pid: 0,
                applicationName: 'No active standbys detected',
                clientAddr: 'single-node',
                state: 'standalone',
                syncState: 'async',
                replayLagMs: 0,
                replayLagPretty: '0 B',
                sentLsn: '—',
                replayLsn: '—',
              },
            ]
        ).map((s, idx) => {
          const y = 46 + idx * 124;
          const isHighLag = s.replayLagMs >= 1000;
          const stroke = isHighLag ? tc('#dc2626', '#f87171') : s.syncState === 'sync' ? tc('#047857', '#34d399') : tc('#1d4ed8', '#60a5fa');
          return (
            <g key={`${s.applicationName}-${idx}`}>
              <path
                d={`M 520 196 C 600 196, 610 ${y + 44}, 682 ${y + 44}`}
                fill="none"
                stroke={stroke}
                strokeWidth="1.7"
                markerEnd="url(#rep-arr)"
              />
              <text x="602" y={y + 34} textAnchor="middle" fontSize="10" fontFamily="monospace" fill={stroke}>
                {s.syncState} · {s.replayLagMs.toFixed(1)} ms
              </text>
              <g
                onClick={() =>
                  setSelectedInfo({
                    title: s.applicationName,
                    category: `Standby Replica (${s.syncState})`,
                    description: `Client ${s.clientAddr} · State: ${s.state} · Replay Lag: ${s.replayLagMs.toFixed(1)} ms (${s.replayLagPretty}) · LSN ${s.replayLsn}`,
                  })
                }
                className="cursor-pointer"
              >
                <rect x="688" y={y} width="390" height="88" rx="10" fill={tc('#ffffff', '#0f172a')} stroke={stroke} strokeWidth="1.6" />
                <text x="708" y={y + 28} fontSize="12" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
                  {s.applicationName}
                </text>
                <text x="708" y={y + 48} fontSize="10.5" fontFamily="monospace" fill={tc('#475569', '#94a3b8')}>
                  {s.clientAddr} · {s.state} · LSN {s.replayLsn}
                </text>
                <text x="708" y={y + 68} fontSize="10.5" fontFamily="monospace" fontWeight="600" fill={stroke}>
                  Replay Lag: {s.replayLagMs.toFixed(1)} ms ({s.replayLagPretty})
                </text>
              </g>
            </g>
          );
        })}

        {/* WAL Slots Strip at Bottom */}
        <rect x="34" y="405" width="1044" height="90" rx="10" fill={tc('#f8fafc', '#1e293b')} stroke={tc('#cbd5e1', '#334155')} strokeWidth="1.3" />
        <text x="54" y="430" fontSize="12" fontWeight="700" fill={tc('#0f172a', '#f1f5f9')}>
          WAL Replication Slots (pg_replication_slots)
        </text>
        {slots.length === 0 ? (
          <text x="54" y="462" fontSize="11" fontFamily="monospace" fill={tc('#64748b', '#94a3b8')}>
            No persistent replication slots registered on this PostgreSQL instance.
          </text>
        ) : (
          slots.slice(0, 3).map((sl, i) => {
            const x = 54 + i * 336;
            const stroke = !sl.active ? tc('#dc2626', '#f87171') : tc('#047857', '#34d399');
            return (
              <g
                key={sl.slotName}
                onClick={() =>
                  setSelectedInfo({
                    title: sl.slotName,
                    category: `WAL Slot (${sl.slotType})`,
                    description: `${sl.active ? 'Active streaming slot' : 'INACTIVE orphaned slot retaining WAL disk space!'} · Retained WAL: ${sl.retainedWalPretty}`,
                  })
                }
                className="cursor-pointer"
              >
                <rect x={x} y="442" width="320" height="40" rx="6" fill={tc('#ffffff', '#0f172a')} stroke={stroke} strokeWidth="1.4" />
                <text x={x + 12} y="466" fontSize="10.5" fontFamily="monospace" fontWeight="600" fill={tc('#0f172a', '#f1f5f9')}>
                  {sl.slotName.slice(0, 22)} · {sl.active ? 'ACTIVE' : 'INACTIVE'} ({sl.retainedWalPretty})
                </text>
              </g>
            );
          })
        )}
      </svg>
    );
  };

  const diagramTabs: { id: DiagramKind; label: string }[] = [
    { id: 'usecase', label: tr('Use Case (UML)', 'Use Case (UML)') },
    { id: 'sequence', label: tr('Sequence (UML)', 'Sequence (UML)') },
    { id: 'architecture', label: tr('System Architecture', 'စနစ် ဗိသုကာပုံ') },
    { id: 'dfd', label: tr('Data Flow (DFD)', 'ဒေတာ စီးဆင်းပုံ (DFD)') },
    { id: 'state', label: tr('State Machine', 'အခြေအနေ ပြောင်းလဲပုံ') },
    { id: 'erd', label: tr('ERD & Data Model', 'ERD နှင့် ဒေတာပုံစံ') },
    { id: 'replication', label: tr('Replication & HA', 'Replication နှင့် HA') },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {tr(
              'Architecture & UML Diagram Studio',
              'စနစ် ဗိသုကာနှင့် UML ပုံကြမ်း စတူဒီယို'
            )}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {tr(
              'Interactive Use Case, Sequence, System Architecture, Data Flow (DFD), State Machine, Live ERD, and Replication Topology diagrams — hydrated from your workspace with SVG, PNG, Mermaid.js, and PlantUML export.',
              'လုပ်ငန်းခွင် ဒေတာအစစ်များဖြင့် ချိတ်ဆက်ထားသော Use Case၊ Sequence၊ System Architecture၊ Data Flow (DFD)၊ State Machine၊ Live ERD နှင့် Replication ပုံကြမ်းများ (SVG/PNG/Mermaid/PlantUML ထုတ်ယူနိုင်သည်)။'
            )}
          </p>
        </div>

        {/* Export Actions */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowSource((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showSource
                ? 'text-blue-800 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900/70'
                : 'text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>{tr('Mermaid / PlantUML', 'Mermaid / PlantUML')}</span>
          </button>
          <button
            type="button"
            onClick={handleExportSvg}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{tr('Export SVG', 'SVG ထုတ်ယူရန်')}</span>
          </button>
          <button
            type="button"
            onClick={handleExportPng}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 dark:bg-blue-600 hover:bg-blue-800 dark:hover:bg-blue-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ImageIcon className="w-3.5 h-3.5" />
            <span>{tr('Download PNG', 'PNG ဒေါင်းလုဒ်')}</span>
          </button>
        </div>
      </div>

      {/* Diagram Type Selector Bar */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit max-w-full overflow-x-auto">
        {diagramTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setDiagramKind(tab.id)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              diagramKind === tab.id
                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Main Interactive Diagram Card */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {/* Contextual Toolbar (Scenario / Target / Zoom Controls) */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/60 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {diagramKind === 'sequence' && (
              <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-700/70 rounded-lg">
                {(
                  [
                    { id: 'drift-alert', label: tr('Drift & Alert', 'Drift နှင့် သတိပေး') },
                    { id: 'baseline-approval', label: tr('Baseline Approval', 'မူလစံ အတည်ပြု') },
                    { id: 'cicd-gate', label: tr('CI/CD Gate', 'CI/CD ဂိတ်') },
                    { id: 'auto-reinspect', label: tr('Auto Re-Inspect', 'အလိုအလျောက် စစ်ဆေး') },
                  ] as { id: SequenceScenarioId; label: string }[]
                ).map((sc) => (
                  <button
                    key={sc.id}
                    type="button"
                    onClick={() => setSequenceScenario(sc.id)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      sequenceScenario === sc.id
                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                  >
                    {sc.label}
                  </button>
                ))}
              </div>
            )}

            {diagramKind === 'erd' && (
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-700/70 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setErdMode('platform')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                      erdMode === 'platform'
                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                  >
                    {tr('Platform Schema (Cloud SQL)', 'ပလက်ဖောင်း ဖွဲ့စည်းပုံ')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setErdMode('target')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                      erdMode === 'target'
                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                  >
                    {tr('Live Target Database ERD', 'တိုက်ရိုက် ပစ်မှတ် ERD')}
                  </button>
                </div>

                {erdMode === 'target' && databases.length > 0 && (
                  <select
                    value={selectedTargetId}
                    onChange={(e) => setSelectedTargetId(e.target.value)}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg"
                  >
                    {databases.map((db) => (
                      <option key={db.id} value={db.id}>
                        {db.name} ({formatEnv(db.environment)})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {diagramKind === 'replication' && databases.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <span>{tr('Target', 'ပစ်မှတ်')}</span>
                <select
                  value={selectedTargetId}
                  onChange={(e) => setSelectedTargetId(e.target.value)}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg"
                >
                  {databases.map((db) => (
                    <option key={db.id} value={db.id}>
                      {db.name} ({formatEnv(db.environment)})
                    </option>
                  ))}
                </select>
              </label>
            )}

            {diagramKind !== 'sequence' &&
              diagramKind !== 'erd' &&
              diagramKind !== 'replication' && (
                <span className="text-xs text-slate-600 dark:text-slate-300">
                  {tr(
                    'Click any actor, process, node, or transition to inspect its technical specification · Drag to pan',
                    'အသေးစိတ် ကြည့်ရှုရန် မည်သည့်အစိတ်အပိုင်းကိုမဆို နှိပ်ပါ · ဆွဲရွှေ့နိုင်ပါသည်'
                  )}
                </span>
              )}
          </div>

          {/* Zoom Controls */}
          <div className="inline-flex items-center gap-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-1 shrink-0">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.15).toFixed(2)))}
              aria-label={tr('Zoom out', 'ချုံ့ရန်')}
              className="p-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded cursor-pointer"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 text-xs font-mono tabular-nums text-slate-700 dark:text-slate-300">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(1.8, +(z + 0.15).toFixed(2)))}
              aria-label={tr('Zoom in', 'ချဲ့ရန်')}
              className="p-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              aria-label={tr('Reset view', 'မူလအရွယ် ပြန်ထားရန်')}
              className="p-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Interactive SVG Viewport */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          className={`relative overflow-hidden bg-white dark:bg-slate-900 min-h-[460px] p-4 ${
            dragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          {loadingDynamic ? (
            <div className="h-[460px] flex items-center justify-center text-xs text-slate-500 dark:text-slate-400">
              {tr('Loading live topology from PostgreSQL…', 'PostgreSQL မှ တိုက်ရိုက်ပုံကြမ်း ရယူနေသည်…')}
            </div>
          ) : (
            <div
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: 'center top',
                transition: dragging ? 'none' : 'transform 120ms ease-out',
              }}
            >
              {diagramKind === 'usecase' && renderUseCaseSvg()}
              {diagramKind === 'sequence' && renderSequenceSvg()}
              {diagramKind === 'architecture' && renderArchitectureSvg()}
              {diagramKind === 'dfd' && renderDfdSvg()}
              {diagramKind === 'state' && renderStateSvg()}
              {diagramKind === 'erd' && renderErdSvg()}
              {diagramKind === 'replication' && renderReplicationSvg()}
            </div>
          )}
        </div>

        {/* Click-to-Inspect Element Details Strip */}
        <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/50 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
          {selectedInfo ? (
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {selectedInfo.title}
                </span>
                <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">·</span>
                <span className="font-mono text-blue-700 dark:text-blue-400">
                  {selectedInfo.category}
                </span>
              </div>
              <p className="text-slate-600 dark:text-slate-300">{selectedInfo.description}</p>
            </div>
          ) : (
            <p className="text-slate-500 dark:text-slate-400">
              {diagramKind === 'sequence'
                ? sequenceDefs[sequenceScenario].subtitle
                : tr(
                    'Select any diagram element above to inspect its live operational role and technical contract.',
                    'လုပ်ဆောင်ချက် အသေးစိတ် ကြည့်ရှုရန် အပေါ်ရှိ ပုံကြမ်း အစိတ်အပိုင်း တစ်ခုခုကို နှိပ်ပါ။'
                  )}
            </p>
          )}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => handleCopy('mermaid-quick', sources.mermaid)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md cursor-pointer whitespace-nowrap"
            >
              {copiedKey === 'mermaid-quick' ? (
                <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>{tr('Copy Mermaid', 'Mermaid ကူးယူရန်')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleCopy('puml-quick', sources.plantuml)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md cursor-pointer whitespace-nowrap"
            >
              {copiedKey === 'puml-quick' ? (
                <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>{tr('Copy PlantUML', 'PlantUML ကူးယူရန်')}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Collapsible Mermaid.js / PlantUML Source Code Drawer */}
      {showSource && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-slate-50/70 dark:bg-slate-800/60">
            <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-700/70 rounded-lg">
              <button
                type="button"
                onClick={() => setSourceFormat('mermaid')}
                className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer ${
                  sourceFormat === 'mermaid'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                Mermaid.js
              </button>
              <button
                type="button"
                onClick={() => setSourceFormat('plantuml')}
                className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer ${
                  sourceFormat === 'plantuml'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                PlantUML
              </button>
            </div>

            <button
              type="button"
              onClick={() =>
                handleCopy(
                  `src-${sourceFormat}`,
                  sourceFormat === 'mermaid' ? sources.mermaid : sources.plantuml
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg cursor-pointer"
            >
              {copiedKey === `src-${sourceFormat}` ? (
                <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>{tr('Copy Diagram Source', 'ပုံကြမ်း ကုဒ် ကူးယူရန်')}</span>
            </button>
          </div>
          <pre className="p-5 bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto leading-relaxed max-h-80">
            {sourceFormat === 'mermaid' ? sources.mermaid : sources.plantuml}
          </pre>
        </div>
      )}
    </div>
  );
}
