import { useId, useMemo, useState } from 'react';
import type { HealthStatus, HealthTrendDayPoint } from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';

interface HealthTrendSparklineProps {
  points?: HealthTrendDayPoint[];
  currentStatus: HealthStatus;
  variant?: 'card' | 'compact';
}

function formatDayShort(dateKey: string, locale: 'en' | 'my'): string {
  const parsed = new Date(`${dateKey}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateKey.slice(5);
  return parsed.toLocaleDateString(locale === 'my' ? 'my-MM' : 'en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function pointDotColor(status: HealthStatus): string {
  switch (status) {
    case 'HEALTHY':
      return '#059669'; // emerald-600
    case 'WARNING':
      return '#D97706'; // amber-600
    case 'DRIFT':
    case 'ERROR':
      return '#DC2626'; // red-600
    default:
      return '#CBD5E1'; // slate-300
  }
}

export function HealthTrendSparkline({
  points,
  currentStatus,
  variant = 'card',
}: HealthTrendSparklineProps) {
  const { locale, tr } = useI18n();
  const gradientId = useId().replace(/:/g, '');
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const normalizedPoints = useMemo<HealthTrendDayPoint[]>(() => {
    if (points && points.length === 7) return points;
    const now = new Date();
    const todayUtc = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    );
    return Array.from({ length: 7 }, (_, i) => {
      const dateKey = new Date(todayUtc - (6 - i) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const isToday = i === 6 && currentStatus !== 'PENDING';
      return {
        dateKey,
        score: isToday
          ? currentStatus === 'HEALTHY'
            ? 100
            : currentStatus === 'WARNING'
              ? 74
              : currentStatus === 'DRIFT'
                ? 45
                : 20
          : null,
        status: isToday ? currentStatus : 'PENDING',
        inspectionsCount: 0,
        incidentsCount: 0,
        criticalCount: 0,
        warningCount: 0,
      };
    });
  }, [points, currentStatus]);

  const observedPoints = normalizedPoints.filter((p) => p.score !== null);
  const avgScore =
    observedPoints.length > 0
      ? Math.round(
          observedPoints.reduce((s, p) => s + (p.score ?? 0), 0) /
            observedPoints.length
        )
      : null;
  const minScore =
    observedPoints.length > 0
      ? observedPoints.reduce(
          (m, p) => Math.min(m, p.score ?? 100),
          100
        )
      : null;
  const totalIncidents7d = normalizedPoints.reduce(
    (s, p) => s + p.incidentsCount,
    0
  );

  // Determine overall semantic stroke palette
  const palette = useMemo(() => {
    if (observedPoints.length === 0) {
      return {
        stroke: '#94A3B8',
        fillTop: '#94A3B8',
        textClass: 'text-slate-500',
      };
    }
    if (
      currentStatus === 'DRIFT' ||
      currentStatus === 'ERROR' ||
      (minScore !== null && minScore < 50)
    ) {
      return {
        stroke: '#DC2626',
        fillTop: '#EF4444',
        textClass: 'text-red-700',
      };
    }
    if (
      currentStatus === 'WARNING' ||
      (minScore !== null && minScore < 85) ||
      totalIncidents7d > 0
    ) {
      return {
        stroke: '#D97706',
        fillTop: '#F59E0B',
        textClass: 'text-amber-700',
      };
    }
    return {
      stroke: '#059669',
      fillTop: '#10B981',
      textClass: 'text-emerald-700',
    };
  }, [observedPoints.length, currentStatus, minScore, totalIncidents7d]);

  const statusLabel = (status: HealthStatus): string => {
    switch (status) {
      case 'HEALTHY':
        return tr('Healthy', 'ကောင်းမွန်သည်');
      case 'WARNING':
        return tr('Warning', 'သတိပေးချက်');
      case 'DRIFT':
        return tr('Schema Drift', 'ဖွဲ့စည်းပုံ ပြောင်းလဲမှု');
      case 'ERROR':
        return tr('Error', 'အမှား');
      default:
        return tr('No data', 'မှတ်တမ်းမရှိ');
    }
  };

  // SVG geometry
  const width = variant === 'card' ? 220 : 108;
  const height = variant === 'card' ? 40 : 26;
  const padX = 6;
  const padY = 5;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const coords = normalizedPoints.map((p, idx) => {
    const x = padX + (idx / 6) * plotW;
    const y =
      p.score !== null
        ? padY + ((100 - p.score) / 100) * plotH
        : padY + plotH * 0.5;
    return { x, y, point: p, idx };
  });

  // Build contiguous line segments & area polygons across observed points
  const segments = useMemo(() => {
    const observedCoords = coords.filter((c) => c.point.score !== null);
    if (observedCoords.length < 2) return null;

    const linePath = observedCoords
      .map(
        (c, i) =>
          `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`
      )
      .join(' ');

    const first = observedCoords[0];
    const last = observedCoords[observedCoords.length - 1];
    const bottomY = (height - 2).toFixed(1);
    const areaPath = `${linePath} L ${last.x.toFixed(1)} ${bottomY} L ${first.x.toFixed(1)} ${bottomY} Z`;

    return { linePath, areaPath };
  }, [coords, height]);

  const activePoint =
    hoveredIdx !== null ? normalizedPoints[hoveredIdx] : null;

  const ariaSummary =
    avgScore !== null
      ? tr(
          `7-day health trend: ${avgScore}% average across ${observedPoints.length} observed days, ${totalIncidents7d} incidents`,
          `၇ ရက် ကျန်းမာရေး လမ်းကြောင်း: ပျမ်းမျှ ${avgScore}% (စစ်ဆေးခဲ့သော ရက် ${observedPoints.length} ရက်၊ သတိပေးချက် ${totalIncidents7d} ခု)`
        )
      : tr(
          '7-day health trend: awaiting first inspection',
          '၇ ရက် ကျန်းမာရေး လမ်းကြောင်း: ပထမဆုံး စစ်ဆေးမှုကို စောင့်နေသည်'
        );

  if (variant === 'compact') {
    return (
      <div
        className="inline-flex items-center gap-2.5"
        onClick={(e) => e.stopPropagation()}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaSummary}
          className="shrink-0 overflow-visible"
        >
          <defs>
            <linearGradient
              id={`spark-fill-${gradientId}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor={palette.fillTop}
                stopOpacity="0.18"
              />
              <stop
                offset="100%"
                stopColor={palette.fillTop}
                stopOpacity="0.01"
              />
            </linearGradient>
          </defs>

          {/* Subtle baseline */}
          <line
            x1={padX}
            y1={height - 2}
            x2={width - padX}
            y2={height - 2}
            stroke="#E2E8F0"
            strokeWidth="1"
          />

          {segments && (
            <>
              <path
                d={segments.areaPath}
                fill={`url(#spark-fill-${gradientId})`}
              />
              <path
                d={segments.linePath}
                fill="none"
                stroke={palette.stroke}
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}

          {coords.map((c) => {
            const isHovered = hoveredIdx === c.idx;
            const observed = c.point.score !== null;
            return (
              <g key={c.point.dateKey}>
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={isHovered ? 3.5 : observed ? 2.25 : 1.5}
                  fill={observed ? pointDotColor(c.point.status) : '#CBD5E1'}
                  stroke={isHovered ? '#0F172A' : '#FFFFFF'}
                  strokeWidth={isHovered ? 1.25 : 0.75}
                />
                <rect
                  x={c.x - plotW / 14}
                  y={0}
                  width={plotW / 7}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() => setHoveredIdx(c.idx)}
                >
                  <title>
                    {`${formatDayShort(c.point.dateKey, locale)} · ${
                      c.point.score !== null ? `${c.point.score}%` : '—'
                    } · ${statusLabel(c.point.status)}`}
                  </title>
                </rect>
              </g>
            );
          })}
        </svg>

        <span
          className={`text-[11px] font-mono tabular-nums whitespace-nowrap ${
            activePoint
              ? activePoint.status === 'DRIFT' || activePoint.status === 'ERROR'
                ? 'text-red-700 font-semibold'
                : activePoint.status === 'WARNING'
                  ? 'text-amber-700 font-semibold'
                  : 'text-slate-700'
              : palette.textClass
          }`}
        >
          {activePoint
            ? `${formatDayShort(activePoint.dateKey, locale)} · ${
                activePoint.score !== null ? `${activePoint.score}%` : '—'
              }`
            : avgScore !== null
              ? `${avgScore}%`
              : '—'}
        </span>
      </div>
    );
  }

  return (
    <div
      className="space-y-1.5"
      onMouseLeave={() => setHoveredIdx(null)}
    >
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-slate-500">
          {tr('7-Day Health Trend', '၇ ရက် ကျန်းမာရေး လမ်းကြောင်း')}
        </span>

        {activePoint ? (
          <span className="font-mono tabular-nums text-slate-700 truncate">
            {formatDayShort(activePoint.dateKey, locale)}
            <span className="text-slate-300 mx-1" aria-hidden="true">
              ·
            </span>
            <span
              className={
                activePoint.status === 'DRIFT' || activePoint.status === 'ERROR'
                  ? 'font-semibold text-red-700'
                  : activePoint.status === 'WARNING'
                    ? 'font-semibold text-amber-700'
                    : activePoint.status === 'HEALTHY'
                      ? 'font-semibold text-emerald-700'
                      : 'text-slate-400'
              }
            >
              {activePoint.score !== null
                ? `${activePoint.score}%`
                : statusLabel('PENDING')}
            </span>
            {activePoint.incidentsCount > 0 && (
              <>
                <span className="text-slate-300 mx-1" aria-hidden="true">
                  ·
                </span>
                <span className="text-red-700">
                  {locale === 'my'
                    ? `${activePoint.incidentsCount} သတိပေးချက်`
                    : `${activePoint.incidentsCount} alert${activePoint.incidentsCount === 1 ? '' : 's'}`}
                </span>
              </>
            )}
          </span>
        ) : (
          <span
            className={`font-mono tabular-nums font-semibold ${palette.textClass}`}
          >
            {avgScore !== null
              ? locale === 'my'
                ? `ပျမ်းမျှ ${avgScore}%${totalIncidents7d > 0 ? ` · သတိပေးချက် ${totalIncidents7d}` : ''}`
                : `${avgScore}% avg${totalIncidents7d > 0 ? ` · ${totalIncidents7d} alert${totalIncidents7d === 1 ? '' : 's'}` : ''}`
              : tr('Awaiting scan', 'စစ်ဆေးမှု စောင့်နေသည်')}
          </span>
        )}
      </div>

      <div className="w-full">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaSummary}
          className="w-full h-10 overflow-visible block"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient
              id={`spark-card-${gradientId}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor={palette.fillTop}
                stopOpacity="0.16"
              />
              <stop
                offset="100%"
                stopColor={palette.fillTop}
                stopOpacity="0.01"
              />
            </linearGradient>
          </defs>

          {/* Reference guide lines (100% healthy top & 50% degraded mid) */}
          <line
            x1={padX}
            y1={padY}
            x2={width - padX}
            y2={padY}
            stroke="#F1F5F9"
            strokeWidth="1"
          />
          <line
            x1={padX}
            y1={padY + plotH * 0.5}
            x2={width - padX}
            y2={padY + plotH * 0.5}
            stroke="#E2E8F0"
            strokeWidth="0.75"
            strokeDasharray="2 3"
          />
          <line
            x1={padX}
            y1={height - 2}
            x2={width - padX}
            y2={height - 2}
            stroke="#E2E8F0"
            strokeWidth="1"
          />

          {segments && (
            <>
              <path
                d={segments.areaPath}
                fill={`url(#spark-card-${gradientId})`}
              />
              <path
                d={segments.linePath}
                fill="none"
                stroke={palette.stroke}
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}

          {coords.map((c) => {
            const isHovered = hoveredIdx === c.idx;
            const observed = c.point.score !== null;
            return (
              <g key={c.point.dateKey}>
                {isHovered && (
                  <line
                    x1={c.x}
                    y1={padY}
                    x2={c.x}
                    y2={height - 2}
                    stroke="#94A3B8"
                    strokeWidth="0.75"
                    strokeDasharray="2 2"
                  />
                )}
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={isHovered ? 3.75 : observed ? 2.6 : 1.75}
                  fill={observed ? pointDotColor(c.point.status) : '#CBD5E1'}
                  stroke={isHovered ? '#0F172A' : '#FFFFFF'}
                  strokeWidth={isHovered ? 1.25 : 0.9}
                />
                <rect
                  x={c.x - plotW / 14}
                  y={0}
                  width={plotW / 7}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() => setHoveredIdx(c.idx)}
                >
                  <title>
                    {`${formatDayShort(c.point.dateKey, locale)} · ${
                      c.point.score !== null ? `${c.point.score}%` : '—'
                    } · ${statusLabel(c.point.status)}`}
                  </title>
                </rect>
              </g>
            );
          })}
        </svg>

        {/* Minimal 7-day start / midpoint / today axis labels */}
        <div className="flex items-center justify-between text-[10px] font-mono tabular-nums text-slate-400 mt-0.5">
          <span>{formatDayShort(normalizedPoints[0].dateKey, locale)}</span>
          <span>{formatDayShort(normalizedPoints[3].dateKey, locale)}</span>
          <span>{tr('Today', 'ယနေ့')}</span>
        </div>
      </div>
    </div>
  );
}
