import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { BarChart3, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { api } from '../api/client';
import type { SanitizedAccount, StatsGranularity, StatsResponse, StatTotals } from '../api/client';

// Series colours, validated for CVD separation and contrast against --bg-surface in both themes (dataviz validator); values live in index.css.
// Likes/comments/DMs keep the hue families used on the Overview cards.
type MetricKey = keyof StatTotals;
type Series = { key: MetricKey; label: string; color: string };

const INTERACTION_SERIES: Series[] = [
  { key: 'likes', label: 'Likes', color: 'var(--chart-orange)' },
  { key: 'comments', label: 'Comments', color: 'var(--chart-blue)' },
  { key: 'dms', label: 'DMs', color: 'var(--chart-green)' },
  { key: 'commentLikes', label: 'Comment likes', color: 'var(--chart-violet)' },
];
const PROBLEM_SERIES: Series[] = [
  { key: 'actionBlocks', label: 'Action blocks', color: 'var(--chart-red)' },
  { key: 'rateLimits', label: 'Rate limits (429)', color: 'var(--chart-violet)' },
  { key: 'challenges', label: 'Challenges', color: 'var(--chart-yellow)' },
  { key: 'errors', label: 'Errors', color: 'var(--chart-aqua)' },
];
const SESSION_SERIES: Series[] = [
  { key: 'sessions', label: 'Productive sessions', color: 'var(--chart-blue)' }, // value = sessions - emptySessions
  { key: 'emptySessions', label: 'Empty sessions', color: 'var(--chart-yellow)' },
];

const GRANULARITY_OPTIONS: Array<{ value: StatsGranularity; label: string; hint: string }> = [
  { value: 'hour', label: 'Hour', hint: 'one day, by hour' },
  { value: 'day', label: 'Day', hint: 'one month, by day' },
  { value: 'week', label: 'Week', hint: '13 weeks, by week' },
  { value: 'month', label: 'Month', hint: 'one year, by month' },
  { value: 'year', label: 'Year', hint: 'all time, by year' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SURFACE = 'var(--bg-surface)'; // used for the 2px gap between stacked segments

// ---------- Time windows (browser-local calendar) ----------

interface StatsWindow { from?: Date; to?: Date; prevFrom?: Date; title: string }

function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7)); // Monday
  return r;
}

function fmtDate(d: Date, withYear = true): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
}

function computeWindow(g: StatsGranularity, offset: number): StatsWindow {
  const now = new Date();
  switch (g) {
    case 'hour': {
      const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
      const prevFrom = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
      const weekday = from.toLocaleDateString(undefined, { weekday: 'long' });
      return { from, to, prevFrom, title: `${weekday}, ${fmtDate(from)}` };
    }
    case 'day': {
      const from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
      const prevFrom = new Date(from.getFullYear(), from.getMonth() - 1, 1);
      return { from, to, prevFrom, title: `${from.toLocaleDateString(undefined, { month: 'long' })} ${from.getFullYear()}` };
    }
    case 'week': {
      const thisWeek = startOfWeek(now);
      const to = new Date(thisWeek.getFullYear(), thisWeek.getMonth(), thisWeek.getDate() + 7 + offset * 13 * 7);
      const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 13 * 7);
      const prevFrom = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 13 * 7);
      const lastWeek = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 7);
      return { from, to, prevFrom, title: `Weeks of ${fmtDate(from, false)} – ${fmtDate(lastWeek)}` };
    }
    case 'month': {
      const from = new Date(now.getFullYear() + offset, 0, 1);
      const to = new Date(from.getFullYear() + 1, 0, 1);
      const prevFrom = new Date(from.getFullYear() - 1, 0, 1);
      return { from, to, prevFrom, title: String(from.getFullYear()) };
    }
    case 'year':
      return { title: 'All time' };
  }
}

/** Short axis label for a bucket key returned by the API. */
function bucketLabel(g: StatsGranularity, key: string): string {
  switch (g) {
    case 'hour': return `${key.slice(11, 13)}:00`;
    case 'day': return String(Number(key.slice(8, 10)));
    case 'week': return `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}`;
    case 'month': return MONTHS[Number(key.slice(5, 7)) - 1];
    case 'year': return key;
  }
}

/** Long label used in tooltips and the data table. */
function bucketLongLabel(g: StatsGranularity, key: string): string {
  const y = key.slice(0, 4), m = Number(key.slice(5, 7)), d = Number(key.slice(8, 10));
  switch (g) {
    case 'hour': return `${d} ${MONTHS[m - 1]} ${y}, ${key.slice(11, 13)}:00–${String((Number(key.slice(11, 13)) + 1) % 24).padStart(2, '0')}:00`;
    case 'day': return `${d} ${MONTHS[m - 1]} ${y}`;
    case 'week': return `Week of ${d} ${MONTHS[m - 1]} ${y}`;
    case 'month': return `${MONTHS[m - 1]} ${y}`;
    case 'year': return key;
  }
}

const statsKeyFor = (acc: SanitizedAccount) =>
  acc.userDataDir ? acc.userDataDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || acc.username : acc.username;

const problemsOf = (t: StatTotals) => t.actionBlocks + t.rateLimits + t.challenges + t.errors;
const fmtNum = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const fmtHours = (minutes: number) => (minutes >= 60 ? `${fmtNum(Math.round(minutes / 6) / 10)}h` : `${Math.round(minutes)}m`);

// ---------- Small UI pieces ----------

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  padding: '16px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
};

const controlStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: '12px',
  backgroundColor: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

const Delta: React.FC<{ current: number; previous?: number }> = ({ current, previous }) => {
  if (previous === undefined) return null;
  if (previous === 0) {
    return <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{current === 0 ? 'no change' : 'new vs prev. period'}</span>;
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '•';
  return (
    <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
      {arrow} {Math.abs(pct)}% <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-sans)' }}>vs prev. ({fmtNum(previous)})</span>
    </span>
  );
};

const StatTile: React.FC<{ label: string; value: string; current: number; previous?: number; sub?: string; color?: string }> = ({
  label, value, current, previous, sub, color,
}) => (
  <div style={cardStyle}>
    <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '6px' }}>
      {color && <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color, display: 'inline-block' }} />}
      {label}
    </div>
    <div style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-mono)', marginTop: '6px' }}>{value}</div>
    <div style={{ marginTop: '6px', minHeight: '16px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {sub && <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{sub}</span>}
      <Delta current={current} previous={previous} />
    </div>
  </div>
);

const Legend: React.FC<{ series: Series[]; totals: StatTotals; valueOf?: (s: Series, t: StatTotals) => number }> = ({ series, totals, valueOf }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', fontSize: '12px', color: 'var(--text-secondary)' }}>
    {series.map(s => (
      <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: s.color, display: 'inline-block' }} />
        {s.label}
        <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{fmtNum(valueOf ? valueOf(s, totals) : totals[s.key])}</span>
      </span>
    ))}
  </div>
);

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number; color?: string; payload?: any }>;
  series: Series[];
  granularity: StatsGranularity;
}

const ChartTooltip: React.FC<ChartTooltipProps> = ({ active, payload, series, granularity }) => {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div style={{
      backgroundColor: 'var(--bg-surface-elevated)', border: '1px solid var(--border-medium)', borderRadius: 'var(--radius-md)',
      padding: '10px 12px', fontSize: '12px', boxShadow: 'var(--shadow-card)', minWidth: '170px',
    }}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: '6px' }}>{bucketLongLabel(granularity, row.key)}</div>
      {[...series].reverse().map(s => (
        <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' }}>
          <span style={{ width: 12, height: 2, backgroundColor: s.color, display: 'inline-block' }} />
          <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontWeight: 600, minWidth: '28px' }}>{fmtNum(row[`__${s.key}`] ?? row[s.key] ?? 0)}</span>
          <span style={{ color: 'var(--text-secondary)' }}>{s.label}</span>
        </div>
      ))}
    </div>
  );
};

const StackedBars: React.FC<{
  title: string;
  series: Series[];
  data: any[];
  granularity: StatsGranularity;
  totals: StatTotals;
  legendValue?: (s: Series, t: StatTotals) => number;
  loading: boolean;
}> = ({ title, series, data, granularity, totals, legendValue, loading }) => (
  <div style={{ ...cardStyle, opacity: loading ? 0.55 : 1, transition: 'opacity 150ms' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600 }}>{title}</div>
      <Legend series={series} totals={totals} valueOf={legendValue} />
    </div>
    <div style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }} barCategoryGap="18%">
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis
            dataKey="key"
            tickFormatter={(k: string) => bucketLabel(granularity, k)}
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--border-medium)' }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={8}
          />
          <YAxis allowDecimals={false} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
          <Tooltip
            cursor={{ fill: 'var(--chart-cursor)' }}
            content={(props: any) => <ChartTooltip {...props} series={series} granularity={granularity} />}
          />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="stack"
              fill={s.color}
              stroke={SURFACE}
              strokeWidth={1}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  </div>
);

// ---------- Page ----------

export const StatsPage: React.FC = () => {
  const [granularity, setGranularity] = useState<StatsGranularity>('day');
  const [offset, setOffset] = useState(0);
  const [accountId, setAccountId] = useState('all');
  const [accounts, setAccounts] = useState<SanitizedAccount[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const win = useMemo(() => computeWindow(granularity, offset), [granularity, offset]);
  const isCurrent = offset === 0;

  useEffect(() => {
    api.getAccounts().then(r => setAccounts(r.accounts)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getStats({
        granularity,
        accountId,
        tz,
        from: win.from?.toISOString(),
        to: win.to?.toISOString(),
        prevFrom: win.prevFrom?.toISOString(),
      });
      setStats(res);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Failed to load statistics');
    } finally {
      setLoading(false);
    }
  }, [granularity, accountId, tz, win]);

  useEffect(() => {
    load();
    if (!isCurrent) return;
    const t = setInterval(load, 60_000); // Only the window containing "now" changes
    return () => clearInterval(t);
  }, [load, isCurrent]);

  const accountName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) map.set(statsKeyFor(a), a.username === a.id ? a.id : `${a.id} (@${a.username})`);
    return (id: string) => map.get(id) || id;
  }, [accounts]);

  // Sessions chart stacks productive + empty so the bar height equals all sessions
  const chartData = useMemo(() => (stats?.buckets || []).map(b => ({
    ...b,
    sessions: Math.max(0, b.sessions - b.emptySessions),
    __sessions: Math.max(0, b.sessions - b.emptySessions),
  })), [stats]);

  const t = stats?.totals;
  const p = stats?.previousTotals || undefined;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />

      <main style={{ padding: '24px', flex: 1, maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
        <div style={{ marginBottom: '20px' }}>
          <h1 style={{ fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BarChart3 size={20} color="var(--accent)" />
            Bot Statistics
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            Interactions, sessions and problems per bot. Times shown in {tz}.
          </p>
        </div>

        {/* Filters: one row, scoping everything below */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <div role="tablist" style={{ display: 'flex', gap: '2px', padding: '2px', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
            {GRANULARITY_OPTIONS.map(o => {
              const active = o.value === granularity;
              return (
                <button
                  key={o.value}
                  role="tab"
                  aria-selected={active}
                  title={o.hint}
                  onClick={() => { setGranularity(o.value); setOffset(0); }}
                  style={{
                    padding: '5px 14px', fontSize: '12px', fontWeight: 500, borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                    backgroundColor: active ? 'var(--bg-surface-active)' : 'transparent',
                    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>

          <select value={accountId} onChange={e => setAccountId(e.target.value)} style={controlStyle} aria-label="Account">
            <option value="all">All accounts</option>
            {accounts.map(a => (
              <option key={a.id} value={statsKeyFor(a)}>{a.username === a.id ? a.id : `${a.id} (@${a.username})`}</option>
            ))}
          </select>

          {granularity !== 'year' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <button style={controlStyle} onClick={() => setOffset(o => o - 1)} aria-label="Previous period"><ChevronLeft size={14} /></button>
              <span style={{ fontSize: '13px', fontWeight: 600, minWidth: '170px', textAlign: 'center' }}>{win.title}</span>
              <button style={{ ...controlStyle, opacity: isCurrent ? 0.4 : 1 }} disabled={isCurrent} onClick={() => setOffset(o => Math.min(0, o + 1))} aria-label="Next period"><ChevronRight size={14} /></button>
              {!isCurrent && <button style={controlStyle} onClick={() => setOffset(0)}>Current</button>}
            </div>
          )}
          {granularity === 'year' && <span style={{ fontSize: '13px', fontWeight: 600 }}>{win.title}</span>}

          <button style={{ ...controlStyle, marginLeft: 'auto' }} onClick={load} disabled={loading}>
            <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
            Refresh
          </button>
        </div>

        {error && (
          <div style={{ ...cardStyle, borderColor: 'var(--state-error-border)', backgroundColor: 'var(--state-error-bg)', color: 'var(--state-error)', fontSize: '13px', marginBottom: '16px' }}>
            {error}
          </div>
        )}

        {t && (
          <>
            {/* KPI tiles */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
              <StatTile label="Likes" value={fmtNum(t.likes)} current={t.likes} previous={p?.likes} color={INTERACTION_SERIES[0].color} />
              <StatTile label="Comments" value={fmtNum(t.comments)} current={t.comments} previous={p?.comments} color={INTERACTION_SERIES[1].color} />
              <StatTile label="DMs sent" value={fmtNum(t.dms)} current={t.dms} previous={p?.dms} color={INTERACTION_SERIES[2].color}
                sub={`${fmtNum(t.dmRequestsAccepted)} requests accepted · ${fmtNum(t.spamRequestsDeleted)} spam deleted`} />
              <StatTile label="Comment likes" value={fmtNum(t.commentLikes)} current={t.commentLikes} previous={p?.commentLikes} color={INTERACTION_SERIES[3].color} />
              <StatTile label="Sessions" value={fmtNum(t.sessions)} current={t.sessions} previous={p?.sessions}
                sub={`${fmtNum(t.emptySessions)} empty · ${t.sessions ? fmtNum(Math.round((t.likes / t.sessions) * 10) / 10) : 0} likes/session`} />
              <StatTile label="Active time" value={fmtHours(t.activeMinutes)} current={t.activeMinutes} previous={p?.activeMinutes} />
              <StatTile label="Problems" value={fmtNum(problemsOf(t))} current={problemsOf(t)} previous={p ? problemsOf(p) : undefined}
                sub={`${fmtNum(t.actionBlocks)} blocks · ${fmtNum(t.rateLimits)} 429s · ${fmtNum(t.challenges)} challenges`} />
            </div>

            {/* Charts */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
              <StackedBars title="Interactions" series={INTERACTION_SERIES} data={chartData} granularity={granularity} totals={t} loading={loading} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '12px' }}>
                <StackedBars title="Problems" series={PROBLEM_SERIES} data={chartData} granularity={granularity} totals={t} loading={loading} />
                <StackedBars
                  title="Sessions"
                  series={SESSION_SERIES}
                  data={chartData}
                  granularity={granularity}
                  totals={t}
                  loading={loading}
                  legendValue={(s, tt) => (s.key === 'sessions' ? Math.max(0, tt.sessions - tt.emptySessions) : tt[s.key])}
                />
              </div>
            </div>

            {/* Per-account table */}
            <div style={{ ...cardStyle, marginBottom: '16px', overflowX: 'auto' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px' }}>Per account</div>
              <StatsTable
                firstColumn="Account"
                rows={stats.perAccount.map(r => ({ label: accountName(r.accountId), totals: r }))}
                emptyText="No activity recorded in this period."
              />
            </div>

            {/* Bucket data table (accessible view of the charts) */}
            <div style={{ ...cardStyle, overflowX: 'auto' }}>
              <button onClick={() => setShowTable(v => !v)} style={{ ...controlStyle, border: 'none', padding: 0, backgroundColor: 'transparent', fontSize: '13px', fontWeight: 600 }}>
                {showTable ? '▾' : '▸'} Data table ({stats.buckets.length} rows)
              </button>
              {showTable && (
                <div style={{ marginTop: '10px' }}>
                  <StatsTable
                    firstColumn="Period"
                    rows={stats.buckets.map(b => ({ label: bucketLongLabel(granularity, b.key), totals: b }))}
                    emptyText="No data."
                  />
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
};

const TABLE_COLUMNS: Array<{ label: string; value: (t: StatTotals) => string }> = [
  { label: 'Likes', value: t => fmtNum(t.likes) },
  { label: 'Comments', value: t => fmtNum(t.comments) },
  { label: 'DMs', value: t => fmtNum(t.dms) },
  { label: 'Comment likes', value: t => fmtNum(t.commentLikes) },
  { label: 'DM req. accepted', value: t => fmtNum(t.dmRequestsAccepted) },
  { label: 'Sessions', value: t => fmtNum(t.sessions) },
  { label: 'Empty', value: t => fmtNum(t.emptySessions) },
  { label: 'Likes / session', value: t => (t.sessions ? fmtNum(Math.round((t.likes / t.sessions) * 10) / 10) : '–') },
  { label: 'Active', value: t => fmtHours(t.activeMinutes) },
  { label: 'Blocks', value: t => fmtNum(t.actionBlocks) },
  { label: '429s', value: t => fmtNum(t.rateLimits) },
  { label: 'Challenges', value: t => fmtNum(t.challenges) },
  { label: 'Errors', value: t => fmtNum(t.errors) },
];

const StatsTable: React.FC<{ firstColumn: string; rows: Array<{ label: string; totals: StatTotals }>; emptyText: string }> = ({ firstColumn, rows, emptyText }) => {
  if (!rows.length) return <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{emptyText}</div>;
  const th: React.CSSProperties = { ...labelStyle, textAlign: 'right', padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap', fontWeight: 500 };
  const td: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
      <thead>
        <tr>
          <th style={{ ...th, textAlign: 'left' }}>{firstColumn}</th>
          {TABLE_COLUMNS.map(c => <th key={c.label} style={th}>{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.label}>
            <td style={{ ...td, textAlign: 'left', fontFamily: 'var(--font-sans)', color: 'var(--text-primary)' }}>{r.label}</td>
            {TABLE_COLUMNS.map(c => <td key={c.label} style={{ ...td, color: 'var(--text-secondary)' }}>{c.value(r.totals)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
};
