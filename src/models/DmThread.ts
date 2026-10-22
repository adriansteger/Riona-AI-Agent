import mongoose, { Schema, Document } from 'mongoose';

export interface IDmParticipant {
    username: string;
    fullName?: string;
    profilePicUrl?: string;
}

export interface IDmThread extends Document {
    accountId: string;
    threadId: string;
    title: string;
    participants: IDmParticipant[];
    isGroup: boolean;
    lastMessageAt?: Date;
    lastMessagePreview?: string;
    lastMessageFromMe?: boolean;
    unread: boolean;
    aiEnabled: boolean; // Per-thread switch for the auto-responder; the account's enableAutoDMs is still the master switch
    syncedAt?: Date;
}

const DmThreadSchema: Schema = new Schema({
    accountId: { type: String, required: true },
    threadId: { type: String, required: true },
    title: { type: String, default: '' },
    participants: {
        type: [{ username: String, fullName: String, profilePicUrl: String, _id: false }],
        default: []
    },
    isGroup: { type: Boolean, default: false },
    lastMessageAt: { type: Date },
    lastMessagePreview: { type: String },
    lastMessageFromMe: { type: Boolean },
    unread: { type: Boolean, default: false },
    aiEnabled: { type: Boolean, default: true },
    syncedAt: { type: Date }
}, { versionKey: false });

DmThreadSchema.index({ accountId: 1, threadId: 1 }, { unique: true });
DmThreadSchema.index({ accountId: 1, lastMessageAt: -1 });

export const DmThread = mongoose.model<IDmThread>('DmThread', DmThreadSchema);
