import mongoose, { Schema, Document } from 'mongoose';

export type PostType = 'photo' | 'carousel' | 'reel';
export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

export interface IPostMedia {
    file: string; // File name inside data/media/<accountId>/
    mime: string;
    size: number;
}

export interface IScheduledPost extends Document {
    accountId: string;
    type: PostType;
    media: IPostMedia[];
    caption: string;
    scheduledAt?: Date;
    status: PostStatus;
    attempts: number;
    nextAttemptAt?: Date;
    publishingStartedAt?: Date;
    lastError?: string;
    publishedAt?: Date;
    permalink?: string;
    createdAt: Date;
    updatedAt: Date;
}

const ScheduledPostSchema: Schema = new Schema({
    accountId: { type: String, required: true },
    type: { type: String, enum: ['photo', 'carousel', 'reel'], required: true },
    media: { type: [{ file: String, mime: String, size: Number, _id: false }], default: [] },
    caption: { type: String, default: '' },
    scheduledAt: { type: Date },
    status: { type: String, enum: ['draft', 'scheduled', 'publishing', 'published', 'failed'], default: 'draft' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date }, // Retry backoff; the scheduler ignores the post until then
    publishingStartedAt: { type: Date },
    lastError: { type: String },
    publishedAt: { type: Date },
    permalink: { type: String }
}, { versionKey: false, timestamps: true });

ScheduledPostSchema.index({ status: 1, scheduledAt: 1 });
ScheduledPostSchema.index({ accountId: 1, scheduledAt: 1 });

export const ScheduledPost = mongoose.model<IScheduledPost>('ScheduledPost', ScheduledPostSchema);
