import mongoose from 'mongoose';
import { ActivityStat, StatMetric } from '../models/ActivityStat';

const HOUR_MS = 60 * 60 * 1000;

export function hourBucket(ts: number = Date.now()): Date {
    return new Date(Math.floor(ts / HOUR_MS) * HOUR_MS);
}

/**
 * Increment a statistics counter for an account in the current hour bucket.
 * Fire-and-forget: never throws and never blocks the bot loop.
 */
export function recordStat(accountId: string, metric: StatMetric, n: number = 1, ts: number = Date.now()): void {
    if (!accountId || !n) return;
    if (mongoose.connection.readyState !== 1) return; // Not connected; skip silently

    ActivityStat.updateOne(
        { accountId, bucket: hourBucket(ts) },
        { $inc: { [metric]: n } },
        { upsert: true }
    ).catch(err => {
        console.error(`[StatsRecorder] Failed to record ${metric} for ${accountId}:`, err?.message || err);
    });
}
