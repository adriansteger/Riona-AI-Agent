/**
 * One-time import of logs/activity_history.json (last 7 days of likes/comments/DMs) into ActivityStat.
 * Usage: npm run stats:backfill
 *
 * Safe to re-run: a marker document blocks a second import, and only timestamps older than
 * the first live-recorded bucket are imported, so nothing is counted twice.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { ActivityStat } from '../models/ActivityStat';
import { hourBucket } from '../services/StatsRecorder';

dotenv.config();

const MARKER_ID = 'backfill_v1';
const HISTORY_FILE = path.join(process.cwd(), 'logs', 'activity_history.json');
const TYPES = ['likes', 'comments', 'dms'] as const;

async function main() {
    await mongoose.connect(process.env.MONGODB_URI || '', { serverSelectionTimeoutMS: 15000 });
    const meta = mongoose.connection.collection<{ _id: string; [key: string]: any }>('stats_meta');

    if (await meta.findOne({ _id: MARKER_ID })) {
        console.log('Backfill already done — nothing to import.');
        return;
    }
    if (!fs.existsSync(HISTORY_FILE)) {
        console.log(`No ${HISTORY_FILE} found — nothing to import.`);
        return;
    }

    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')) as Record<string, Partial<Record<typeof TYPES[number], number[]>>>;
    let imported = 0;

    for (const [accountId, entry] of Object.entries(history)) {
        // Live recording may have started already; only import what happened before its first bucket
        const firstLive = await ActivityStat.findOne({ accountId }).sort({ bucket: 1 }).select('bucket').lean();
        const cutoff = firstLive ? new Date(firstLive.bucket).getTime() : Infinity;

        const perBucket = new Map<number, Record<string, number>>();
        for (const type of TYPES) {
            for (const ts of entry[type] || []) {
                if (ts >= cutoff) continue;
                const key = hourBucket(ts).getTime();
                const counts = perBucket.get(key) || {};
                counts[type] = (counts[type] || 0) + 1;
                perBucket.set(key, counts);
                imported++;
            }
        }

        const ops = [...perBucket.entries()].map(([bucket, counts]) => ({
            updateOne: { filter: { accountId, bucket: new Date(bucket) }, update: { $inc: counts }, upsert: true },
        }));
        if (ops.length) await ActivityStat.bulkWrite(ops);
        console.log(`${accountId}: imported ${ops.length} hourly buckets`);
    }

    await meta.insertOne({ _id: MARKER_ID, ranAt: new Date(), imported });
    console.log(`Done. Imported ${imported} actions.`);
}

main()
    .catch(err => {
        console.error('Backfill failed:', err);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
