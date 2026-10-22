import mongoose, { Schema, Document } from 'mongoose';

// Counters recorded per account per UTC hour. All dashboard statistics roll up from these.
export const STAT_METRICS = [
    'likes',
    'comments',
    'dms',
    'posts',
    'commentLikes',
    'dmRequestsAccepted',
    'spamRequestsDeleted',
    'actionBlocks',
    'rateLimits',
    'challenges',
    'errors',
    'sessions',
    'emptySessions',
    'activeMinutes',
] as const;

export type StatMetric = typeof STAT_METRICS[number];

export type IActivityStat = Document & {
    accountId: string;
    bucket: Date; // Start of the UTC hour
} & Record<StatMetric, number>;

const metricFields = Object.fromEntries(STAT_METRICS.map(m => [m, { type: Number, default: 0 }]));

const ActivityStatSchema: Schema = new Schema({
    accountId: { type: String, required: true },
    bucket: { type: Date, required: true },
    ...metricFields,
}, {
    versionKey: false,
    // 'errors' is a Document property; only lean/aggregate/update queries touch this model, so the clash is harmless
    suppressReservedKeysWarning: true,
});

ActivityStatSchema.index({ accountId: 1, bucket: 1 }, { unique: true });
ActivityStatSchema.index({ bucket: 1 });

export const ActivityStat = mongoose.model<IActivityStat>('ActivityStat', ActivityStatSchema);
