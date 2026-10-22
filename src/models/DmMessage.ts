import mongoose, { Schema, Document } from 'mongoose';

export type DmMessageKind = 'text' | 'media' | 'link' | 'other';

export interface IDmMessage extends Document {
    accountId: string;
    threadId: string;
    itemId: string;
    fromMe: boolean;
    senderUsername?: string;
    text: string;
    kind: DmMessageKind;
    timestamp: Date;
}

const DmMessageSchema: Schema = new Schema({
    accountId: { type: String, required: true },
    threadId: { type: String, required: true },
    itemId: { type: String, required: true },
    fromMe: { type: Boolean, default: false },
    senderUsername: { type: String },
    text: { type: String, default: '' },
    kind: { type: String, enum: ['text', 'media', 'link', 'other'], default: 'text' },
    timestamp: { type: Date, required: true }
}, { versionKey: false });

DmMessageSchema.index({ accountId: 1, itemId: 1 }, { unique: true });
DmMessageSchema.index({ accountId: 1, threadId: 1, timestamp: 1 });

export const DmMessage = mongoose.model<IDmMessage>('DmMessage', DmMessageSchema);
