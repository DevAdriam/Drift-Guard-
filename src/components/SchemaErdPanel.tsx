import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { ApiClient } from '../lib/api.ts';
import type {
  ErdTableNode,
  SchemaErdResponse,
} from '../types/telemetry.ts';
import { useI18n } from '../i18n/LocaleContext.tsx';
import { useTheme } from '../context/ThemeContext.tsx';

interface SchemaErdPanelProps {
  api: ApiClient;
  databaseId: string;
}

interface PositionedTable {
  table: ErdTableNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

const CARD_WIDTH = 264;
const HEADER_H = 38;
const ROW_H = 24;
const CARD_PAD_BOTTOM = 10;
const GAP_X = 76;
const GAP_Y = 48;

export function SchemaErdPanel({ api, databaseId }: SchemaErdPanelProps) {
  const { tr } = useI18n();
  const { isDark } = useTheme();
  const [erd, setErd] = useState<SchemaErdResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [driftedOnly, setDriftedOnly] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const loadErd = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getDatabaseErd(databaseId);
      setErd(data);
      if (data.tables.length > 0) {
        const drifted = data.tables.find((t) => t.hasDrift);
        setSelectedTableId((prev) => prev ?? drifted?.id ?? data.tables[0].id);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr(
              'Unable to load schema ERD graph.',
              'ERD ဇယားဆက်နွယ်မှုပုံကို ဖွင့်၍ မရပါ။'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [api, databaseId, tr]);

  useEffect(() => {
    loadErd();
  }, [loadErd]);

  const visibleTables = useMemo(() => {
    if (!erd) return [];
    const q = search.trim().toLowerCase();
    return erd.tables.filter((t) => {
      if (driftedOnly && !t.hasDrift) return false;
      if (!q) return true;
      return (
        t.id.toLowerCase().includes(q) ||
        t.columns.some((c) => c.name.toLowerCase().includes(q))
      );
    });
  }, [erd, search, driftedOnly]);

  const visibleTableSet = useMemo(
    () => new Set(visibleTables.map((t) => t.id)),
    [visibleTables]
  );

  const visibleEdges = useMemo(() => {
    if (!erd) return [];
    return erd.edges.filter(
      (e) =>
        visibleTableSet.has(e.sourceTableId) &&
        visibleTableSet.has(e.targetTableId)
    );
  }, [erd, visibleTableSet]);

  const layout = useMemo(() => {
    const colsPerRow = visibleTables.length <= 2 ? Math.max(1, visibleTables.length) : Math.min(3, Math.ceil(Math.sqrt(visibleTables.length)));
    const positions = new Map<string, PositionedTable>();
    const rowHeights: number[] = [];

    visibleTables.forEach((table, idx) => {
      const row = Math.floor(idx / colsPerRow);
      const shownCols = Math.min(table.columns.length, 10);
      const extraRow = table.columns.length > 10 ? 1 : 0;
      const h = HEADER_H + (shownCols + extraRow) * ROW_H + CARD_PAD_BOTTOM;
      rowHeights[row] = Math.max(rowHeights[row] ?? 0, h);
    });

    const rowOffsets: number[] = [32];
    for (let r = 0; r < rowHeights.length; r++) {
      rowOffsets[r + 1] = rowOffsets[r] + rowHeights[r] + GAP_Y;
    }

    let maxX = 820;
    let maxY = 380;

    visibleTables.forEach((table, idx) => {
      const col = idx % colsPerRow;
      const row = Math.floor(idx / colsPerRow);
      const shownCols = Math.min(table.columns.length, 10);
      const extraRow = table.columns.length > 10 ? 1 : 0;
      const h = HEADER_H + (shownCols + extraRow) * ROW_H + CARD_PAD_BOTTOM;
      const x = 36 + col * (CARD_WIDTH + GAP_X);
      const y = rowOffsets[row];
      positions.set(table.id, { table, x, y, width: CARD_WIDTH, height: h });
      maxX = Math.max(maxX, x + CARD_WIDTH + 48);
      maxY = Math.max(maxY, y + h + 44);
    });

    return {
      positions,
      canvasWidth: maxX,
      canvasHeight: maxY,
    };
  }, [visibleTables]);

  const selectedTable = useMemo(
    () => erd?.tables.find((t) => t.id === selectedTableId) ?? null,
    [erd, selectedTableId]
  );

  const handleExportSvg = () => {
    if (!svgRef.current || !erd) return;
    const serializer = new XMLSerializer();
    const raw = serializer.serializeToString(svgRef.current);
    const blob = new Blob([raw], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${erd.databaseName}_erd_${erd.schemaHash.slice(0, 8) || 'schema'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 animate-pulse">
        <div className="h-5 bg-slate-200 dark:bg-slate-700 rounded w-64" />
        <div className="h-80 bg-slate-100 dark:bg-slate-800 rounded-lg" />
      </div>
    );
  }

  if (error || !erd) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/70 rounded-xl p-6 text-sm text-red-700 dark:text-red-400">
        {error ?? tr('No ERD data available.', 'ERD အချက်အလက် မရှိသေးပါ။')}
      </div>
    );
  }

  const driftedCount = erd.tables.filter((t) => t.hasDrift).length;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      {/* Header & Controls */}
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {tr(
                'Interactive Entity-Relationship Diagram (ERD)',
                'ဇယား ဆက်နွယ်မှုပုံ (Interactive ERD)'
              )}
            </h2>
            <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              {tr(
                `${erd.tables.length} tables · ${erd.edges.length} relationships`,
                `ဇယား ${erd.tables.length} ခု · ဆက်နွယ်မှု ${erd.edges.length} ခု`
              )}
            </span>
            {driftedCount > 0 && (
              <>
                <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                  ·
                </span>
                <span className="text-xs font-semibold text-red-700 dark:text-red-400 tabular-nums">
                  {tr(
                    `${driftedCount} drifted table(s)`,
                    `ပြောင်းလဲနေသော ဇယား ${driftedCount} ခု`
                  )}
                </span>
              </>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {erd.source === 'live_constraints'
              ? tr(
                  'Foreign key edges resolved directly from live information_schema constraints.',
                  'Foreign Key ဆက်နွယ်မှုများကို live information_schema မှ တိုက်ရိုက် ဖတ်ယူထားပါသည်။'
                )
              : tr(
                  'Primary & foreign key edges mapped from canonical catalog columns and drift annotations.',
                  'Primary နှင့် Foreign Key ဆက်နွယ်မှုများကို ကတ်တလောက် ဖွဲ့စည်းပုံနှင့် ကွာခြားချက်များမှ တည်ဆောက်ထားပါသည်။'
                )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr('Filter tables/columns…', 'ဇယား/ကော်လံ ရှာရန်…')}
              className="pl-8 pr-3 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 w-44 focus:outline-none focus:ring-2 focus:ring-blue-700/20 dark:focus:ring-blue-500/30"
            />
          </div>

          <button
            type="button"
            onClick={() => setDriftedOnly((v) => !v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              driftedOnly
                ? 'bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300 border-red-200 dark:border-red-900/70'
                : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60'
            }`}
          >
            {tr('Drifted Only', 'ပြောင်းလဲမှုသာ')} ({driftedCount})
          </button>

          <div className="flex items-center border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.15).toFixed(2)))}
              aria-label={tr('Zoom out', 'ချုံ့ရန်')}
              className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 text-xs font-mono tabular-nums text-slate-700 dark:text-slate-300">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.15).toFixed(2)))}
              aria-label={tr('Zoom in', 'ချဲ့ရန်')}
              className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              aria-label={tr('Reset zoom', 'မူလအရွယ်')}
              className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 border-l border-slate-200 dark:border-slate-800 cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={handleExportSvg}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{tr('Export SVG', 'SVG ဒေါင်းလုဒ်')}</span>
          </button>

          <button
            type="button"
            onClick={loadErd}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-lg cursor-pointer"
            aria-label={tr('Refresh ERD', 'ERD ပြန်လည်စစ်ဆေးရန်')}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* SVG Interactive Canvas */}
      {visibleTables.length === 0 ? (
        <div className="p-12 text-center text-sm text-slate-500 dark:text-slate-400">
          {tr(
            'No tables match the current filter.',
            'လက်ရှိ စစ်ထုတ်မှုနှင့် ကိုက်ညီသော ဇယား မရှိပါ။'
          )}
        </div>
      ) : (
        <div className="overflow-auto bg-slate-50/70 dark:bg-slate-800/60 max-h-[540px] border-b border-slate-200 dark:border-slate-800">
          <svg
            ref={svgRef}
            width={Math.round(layout.canvasWidth * zoom)}
            height={Math.round(layout.canvasHeight * zoom)}
            viewBox={`0 0 ${layout.canvasWidth} ${layout.canvasHeight}`}
            className="block select-none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <pattern
                id="erd-grid-dots"
                width="20"
                height="20"
                patternUnits="userSpaceOnUse"
              >
                <circle
                  cx="2"
                  cy="2"
                  r="1"
                  fill={isDark ? '#1E293B' : '#E2E8F0'}
                />
              </pattern>
              <marker
                id="erd-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path
                  d="M 0 1.5 L 9 5 L 0 8.5 z"
                  fill={isDark ? '#60A5FA' : '#2563EB'}
                />
              </marker>
            </defs>

            <rect
              x="0"
              y="0"
              width={layout.canvasWidth}
              height={layout.canvasHeight}
              fill="url(#erd-grid-dots)"
            />

            {/* Relationship Bezier Curves */}
            {visibleEdges.map((edge) => {
              const src = layout.positions.get(edge.sourceTableId);
              const dst = layout.positions.get(edge.targetTableId);
              if (!src || !dst) return null;

              const srcColIdx = Math.max(
                0,
                Math.min(
                  9,
                  src.table.columns.findIndex((c) => c.name === edge.sourceColumn)
                )
              );
              const dstColIdx = Math.max(
                0,
                Math.min(
                  9,
                  dst.table.columns.findIndex((c) => c.name === edge.targetColumn)
                )
              );

              const srcY = src.y + HEADER_H + srcColIdx * ROW_H + ROW_H / 2;
              const dstY = dst.y + HEADER_H + dstColIdx * ROW_H + ROW_H / 2;
              const goRight = dst.x >= src.x;
              const x1 = goRight ? src.x + src.width : src.x;
              const x2 = goRight ? dst.x : dst.x + dst.width;
              const ctrlOffset = Math.max(48, Math.abs(x2 - x1) * 0.45);
              const cx1 = goRight ? x1 + ctrlOffset : x1 - ctrlOffset;
              const cx2 = goRight ? x2 - ctrlOffset : x2 + ctrlOffset;
              const highlighted =
                selectedTableId === edge.sourceTableId ||
                selectedTableId === edge.targetTableId;

              return (
                <g key={edge.id}>
                  <path
                    d={`M ${x1} ${srcY} C ${cx1} ${srcY}, ${cx2} ${dstY}, ${x2} ${dstY}`}
                    fill="none"
                    stroke={
                      highlighted
                        ? isDark
                          ? '#60A5FA'
                          : '#1D4ED8'
                        : isDark
                          ? '#475569'
                          : '#94A3B8'
                    }
                    strokeWidth={highlighted ? 2 : 1.35}
                    strokeDasharray={edge.inferred ? '5 3' : undefined}
                    markerEnd="url(#erd-arrow)"
                    opacity={highlighted ? 1 : 0.78}
                  />
                  <circle
                    cx={x1}
                    cy={srcY}
                    r={3.5}
                    fill={
                      highlighted
                        ? isDark
                          ? '#60A5FA'
                          : '#1D4ED8'
                        : isDark
                          ? '#64748B'
                          : '#64748B'
                    }
                  />
                </g>
              );
            })}

            {/* Table Entity Cards */}
            {visibleTables.map((table) => {
              const pos = layout.positions.get(table.id);
              if (!pos) return null;
              const isSelected = selectedTableId === table.id;
              const shownCols = table.columns.slice(0, 10);
              const overflowCount = table.columns.length - shownCols.length;

              return (
                <g
                  key={table.id}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onClick={() => setSelectedTableId(table.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <rect
                    width={pos.width}
                    height={pos.height}
                    rx={10}
                    fill={isDark ? '#0F172A' : '#FFFFFF'}
                    stroke={
                      table.hasDrift
                        ? isDark
                          ? '#F87171'
                          : '#DC2626'
                        : isSelected
                          ? isDark
                            ? '#60A5FA'
                            : '#1D4ED8'
                          : isDark
                            ? '#334155'
                            : '#CBD5E1'
                    }
                    strokeWidth={isSelected || table.hasDrift ? 1.75 : 1}
                  />
                  {/* Table Header */}
                  <path
                    d={`M 0 10 Q 0 0 10 0 L ${pos.width - 10} 0 Q ${pos.width} 0 ${pos.width} 10 L ${pos.width} ${HEADER_H} L 0 ${HEADER_H} Z`}
                    fill={
                      table.hasDrift
                        ? isDark
                          ? '#450A0A'
                          : '#FEF2F2'
                        : isSelected
                          ? isDark
                            ? '#172554'
                            : '#EFF6FF'
                          : isDark
                            ? '#1E293B'
                            : '#F8FAFC'
                    }
                  />
                  <line
                    x1={0}
                    y1={HEADER_H}
                    x2={pos.width}
                    y2={HEADER_H}
                    stroke={
                      table.hasDrift
                        ? isDark
                          ? '#7F1D1D'
                          : '#FECACA'
                        : isDark
                          ? '#334155'
                          : '#E2E8F0'
                    }
                  />
                  <text
                    x={12}
                    y={23}
                    fontSize="12"
                    fontWeight="700"
                    fill={isDark ? '#F1F5F9' : '#0F172A'}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {table.id.length > 26 ? `${table.id.slice(0, 25)}…` : table.id}
                  </text>
                  {table.hasDrift && (
                    <text
                      x={pos.width - 12}
                      y={23}
                      textAnchor="end"
                      fontSize="10"
                      fontWeight="700"
                      fill={isDark ? '#FCA5A5' : '#B91C1C'}
                      fontFamily="sans-serif"
                    >
                      DRIFT
                    </text>
                  )}

                  {/* Column Rows */}
                  {shownCols.map((col, cIdx) => {
                    const rowY = HEADER_H + cIdx * ROW_H;
                    const driftBg =
                      col.driftKind === 'ADDED'
                        ? isDark
                          ? '#064E3B'
                          : '#ECFDF5'
                        : col.driftKind === 'MODIFIED'
                          ? isDark
                            ? '#451A03'
                            : '#FFFBEB'
                          : col.driftKind === 'REMOVED'
                            ? isDark
                              ? '#450A0A'
                              : '#FEF2F2'
                            : 'transparent';
                    const colTextColor =
                      col.driftKind === 'ADDED'
                        ? isDark
                          ? '#6EE7B7'
                          : '#047857'
                        : col.driftKind === 'MODIFIED'
                          ? isDark
                            ? '#FCD34D'
                            : '#B45309'
                          : col.driftKind === 'REMOVED'
                            ? isDark
                              ? '#FCA5A5'
                              : '#B91C1C'
                            : isDark
                              ? '#E2E8F0'
                              : '#1E293B';
                    const keyMark = col.isPrimaryKey
                      ? 'PK'
                      : col.isForeignKey
                        ? 'FK'
                        : '';

                    return (
                      <g key={col.name} transform={`translate(0, ${rowY})`}>
                        {driftBg !== 'transparent' && (
                          <rect
                            x={2}
                            y={1}
                            width={pos.width - 4}
                            height={ROW_H - 2}
                            rx={4}
                            fill={driftBg}
                          />
                        )}
                        {keyMark && (
                          <text
                            x={12}
                            y={16}
                            fontSize="9.5"
                            fontWeight="700"
                            fill={
                              col.isPrimaryKey
                                ? isDark
                                  ? '#60A5FA'
                                  : '#1D4ED8'
                                : isDark
                                  ? '#C4B5FD'
                                  : '#7C3AED'
                            }
                            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                          >
                            {keyMark}
                          </text>
                        )}
                        <text
                          x={keyMark ? 32 : 12}
                          y={16}
                          fontSize="11"
                          fontWeight={col.isPrimaryKey ? '600' : '400'}
                          fill={colTextColor}
                          textDecoration={
                            col.driftKind === 'REMOVED'
                              ? 'line-through'
                              : undefined
                          }
                          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                        >
                          {col.name.length > 18
                            ? `${col.name.slice(0, 17)}…`
                            : col.name}
                        </text>
                        <text
                          x={pos.width - 12}
                          y={16}
                          textAnchor="end"
                          fontSize="10"
                          fill={isDark ? '#94A3B8' : '#64748B'}
                          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                        >
                          {col.dataType.length > 13
                            ? `${col.dataType.slice(0, 12)}…`
                            : col.dataType}
                        </text>
                      </g>
                    );
                  })}

                  {overflowCount > 0 && (
                    <text
                      x={12}
                      y={HEADER_H + shownCols.length * ROW_H + 15}
                      fontSize="10"
                      fill={isDark ? '#94A3B8' : '#64748B'}
                      fontFamily="sans-serif"
                    >
                      +{overflowCount} {tr('more columns', 'ကော်လံ ထပ်ရှိ')}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Selected Table Inspector Footer */}
      {selectedTable && (
        <div className="p-4 bg-white dark:bg-slate-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
              {selectedTable.id}
            </span>
            <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
              ·
            </span>
            <span className="text-slate-600 dark:text-slate-300 tabular-nums">
              {selectedTable.columns.length} {tr('columns', 'ကော်လံ')}
            </span>
            {selectedTable.estimatedRowCount != null && (
              <>
                <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  ~{selectedTable.estimatedRowCount.toLocaleString()}{' '}
                  {tr('live rows', 'အတန်း')}
                </span>
              </>
            )}
            {selectedTable.hasDrift && (
              <>
                <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                  ·
                </span>
                <span className="font-medium text-red-700 dark:text-red-400 tabular-nums">
                  +{selectedTable.driftCounts.added} / ~
                  {selectedTable.driftCounts.modified} / -
                  {selectedTable.driftCounts.removed}{' '}
                  {tr('drift delta', 'ကွာခြားချက်')}
                </span>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="font-mono text-blue-700 dark:text-blue-400 font-semibold">
              PK = {tr('Primary Key', 'မူလသော့')}
            </span>
            <span className="font-mono text-violet-700 dark:text-violet-400 font-semibold">
              FK = {tr('Foreign Key', 'ချိတ်ဆက်သော့')}
            </span>
            <span className="text-emerald-700 dark:text-emerald-400 font-medium">
              {tr('Green = Added', 'အစိမ်း = အသစ်')}
            </span>
            <span className="text-amber-700 dark:text-amber-400 font-medium">
              {tr('Amber = Modified', 'အဝါ = ပြောင်းလဲ')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
