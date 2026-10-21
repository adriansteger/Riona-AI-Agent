import { ActivityStat, STAT_METRICS, StatMetric } from '../models/ActivityStat';

export type Granularity = 'hour' | 'day' | 'week' | 'month' | 'year';
export const GRANULARITIES: Granularity[] = ['hour', 'day', 'week', 'month', 'year'];

export type MetricTotals = Record<StatMetric, number>;

export interface StatsQuery {
    granularity: Granularity;
    accountId?: string; // 'all' or undefined = every account
    from?: Date;
    to?: Date;
    prevFrom?: Date; // Start of the comparison window (defaults to a same-length window before `from`)
    tz?: string;
}

export interface StatsResponse {
    granularity: Granularity;
    tz: string;
    from: string;
    to: string;
    buckets: Array<{ key: string } & MetricTotals>;
    totals: MetricTotals;
    previousTotals: MetricTotals | null;
    perAccount: Array<{ accountId: string } & MetricTotals>;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_BUCKETS = 2000;

// Rolling windows used when the client does not send from/to
const DEFAULT_SPAN_MS: Record<Exclude<Granularity, 'year'>, number> = {
    hour: 48 * HOUR_MS,
    day: 30 * DAY_MS,
    week: 26 * 7 * DAY_MS,
    month: 365 * DAY_MS,
};

// Mongo $dateToString formats; must match formatKey() below
const KEY_FORMAT: Record<Granularity, string> = {
    hour: '%Y-%m-%dT%H',
    day: '%Y-%m-%d',
    week: '%Y-%m-%d', // Monday of the week
    month: '%Y-%m',
    year: '%Y',
};

export function resolveTimeZone(tz?: string): string {
    if (!tz) return 'UTC';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return tz;
    } catch {
        return 'UTC';
    }
}

function emptyTotals(): MetricTotals {
    return Object.fromEntries(STAT_METRICS.map(m => [m, 0])) as MetricTotals;
}

function sumFields() {
    return Object.fromEntries(STAT_METRICS.map(m => [m, { $sum: { $ifNull: [`$${m}`, 0] } }]));
}

function pickTotals(doc: any): MetricTotals {
    const out = emptyTotals();
    if (doc) for (const m of STAT_METRICS) out[m] = Math.round((doc[m] || 0) * 10) / 10;
    return out;
}

/** Build the same bucket key in JS that Mongo produces with $dateTrunc + $dateToString. */
function makeKeyFormatter(granularity: Granularity, tz: string) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    const weekdayIndex: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

    return (ts: number): string => {
        const parts = Object.fromEntries(fmt.formatToParts(new Date(ts)).map(p => [p.type, p.value]));
        const { year, month, day, hour, weekday } = parts as Record<string, string>;
        switch (granularity) {
            case 'hour': return `${year}-${month}-${day}T${hour}`;
            case 'day': return `${year}-${month}-${day}`;
            case 'month': return `${year}-${month}`;
            case 'year': return year;
            case 'week': {
                // Calendar arithmetic on the local date (UTC used only as a neutral calendar)
                const local = Date.UTC(Number(year), Number(month) - 1, Number(day));
                const monday = new Date(local - weekdayIndex[weekday] * DAY_MS);
                return monday.toISOString().slice(0, 10);
            }
        }
    };
}

/** Every bucket key between from and to, so the chart has no gaps. */
function enumerateKeys(granularity: Granularity, tz: string, from: number, to: number): string[] {
    const toKey = makeKeyFormatter(granularity, tz);
    // Hourly steps are DST-safe for hour/day/week; daily steps are enough for month/year
    const step = granularity === 'month' || granularity === 'year' ? DAY_MS : HOUR_MS;
    const keys: string[] = [];
    let last = '';
    for (let t = from; t < to; t += step) {
        const k = toKey(t);
        if (k !== last && !keys.includes(k)) keys.push(k);
        last = k;
        if (keys.length > MAX_BUCKETS) break;
    }
    const endKey = toKey(to - 1);
    if (!keys.includes(endKey)) keys.push(endKey);
    return keys;
}

export async function getStats(q: StatsQuery): Promise<StatsResponse> {
    const tz = resolveTimeZone(q.tz);
    const { granularity } = q;
    const accountMatch = q.accountId && q.accountId !== 'all' ? { accountId: q.accountId } : {};

    const now = Date.now();
    let to = q.to ? q.to.getTime() : now;
    let from: number;
    let hasPrevious = true;
    if (q.from) {
        from = q.from.getTime();
    } else if (granularity === 'year') {
        // "All time": start at the earliest recorded bucket
        const first = await ActivityStat.findOne(accountMatch).sort({ bucket: 1 }).select('bucket').lean();
        from = first ? new Date(first.bucket).getTime() : now - 365 * DAY_MS;
        hasPrevious = false;
    } else {
        from = to - DEFAULT_SPAN_MS[granularity];
    }
    if (!(from < to)) throw new Error('Invalid time window');

    const prevFrom = q.prevFrom && q.prevFrom.getTime() < from ? q.prevFrom.getTime() : from - (to - from);
    const match = { ...accountMatch, bucket: { $gte: new Date(from), $lt: new Date(to) } };

    const keyExpr = {
        $dateToString: {
            format: KEY_FORMAT[granularity],
            timezone: tz,
            date: { $dateTrunc: { date: '$bucket', unit: granularity, timezone: tz, startOfWeek: 'monday' } },
        },
    };

    const [rows, perAccountRows, prevRows] = await Promise.all([
        ActivityStat.aggregate([{ $match: match }, { $group: { _id: keyExpr, ...sumFields() } }]),
        ActivityStat.aggregate([{ $match: match }, { $group: { _id: '$accountId', ...sumFields() } }, { $sort: { _id: 1 } }]),
        hasPrevious
            ? ActivityStat.aggregate([
                { $match: { ...accountMatch, bucket: { $gte: new Date(prevFrom), $lt: new Date(from) } } },
                { $group: { _id: null, ...sumFields() } },
            ])
            : Promise.resolve(null),
    ]);

    const byKey = new Map<string, any>(rows.map((r: any) => [r._id, r]));
    const buckets = enumerateKeys(granularity, tz, from, to).map(key => ({ key, ...pickTotals(byKey.get(key)) }));

    const totals = emptyTotals();
    for (const b of buckets) for (const m of STAT_METRICS) totals[m] += b[m];
    for (const m of STAT_METRICS) totals[m] = Math.round(totals[m] * 10) / 10;

    return {
        granularity,
        tz,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        buckets,
        totals,
        previousTotals: prevRows ? pickTotals(prevRows[0]) : null,
        perAccount: perAccountRows.map((r: any) => ({ accountId: r._id, ...pickTotals(r) })),
    };
}
