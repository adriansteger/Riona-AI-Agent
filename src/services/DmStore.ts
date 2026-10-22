import mongoose from 'mongoose';
import { DmThread } from '../models/DmThread';
import { DmMessage } from '../models/DmMessage';
import type { InboxThread } from '../client/IG-bot/IgClient';

/** Stores a synced snapshot of threads and their messages. The per-thread aiEnabled switch is never overwritten. */
export async function saveInboxThreads(accountId: string, threads: InboxThread[]): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    const syncedAt = new Date();

    for (const t of threads) {
        await DmThread.updateOne(
            { accountId, threadId: t.threadId },
            {
                $set: {
                    title: t.title,
                    participants: t.participants,
                    isGroup: t.isGroup,
                    lastMessageAt: new Date(t.lastMessageAt),
                    lastMessagePreview: t.lastMessagePreview,
                    lastMessageFromMe: t.lastMessageFromMe,
                    unread: t.unread,
                    syncedAt
                },
                $setOnInsert: { aiEnabled: true }
            },
            { upsert: true }
        );

        if (t.source === 'dom') {
            // Scraped messages have synthetic ids, so replace the thread's stored copy instead of merging
            await DmMessage.deleteMany({ accountId, threadId: t.threadId });
        }
        if (t.messages.length === 0) continue;

        await DmMessage.bulkWrite(t.messages.map(m => ({
            updateOne: {
                filter: { accountId, itemId: m.itemId },
                update: {
                    $set: {
                        threadId: t.threadId,
                        fromMe: m.fromMe,
                        senderUsername: m.senderUsername,
                        text: m.text,
                        kind: m.kind,
                        timestamp: new Date(m.timestamp)
                    }
                },
                upsert: true
            }
        })), { ordered: false });
    }
}
