import path from 'path';
import mongoose from 'mongoose';
import logger, { createAccountLogger } from '../config/logger';
import { ScheduledPost, IScheduledPost } from '../models/ScheduledPost';
import { IgClient, PostMaybePublishedError } from '../client/IG-bot/IgClient';
import { BotManager, TaskEntry } from './BotManager';
import { ConfigStore } from './ConfigStore';

const TICK_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 15 * 60 * 1000;

export const MEDIA_ROOT = path.resolve(process.cwd(), 'data', 'media');

export function mediaDirFor(accountId: string): string {
    return path.join(MEDIA_ROOT, accountId);
}

/** Publishes scheduled posts when they are due, and backs the dashboard's "Post now". */
export class PostScheduler {
    private static instance: PostScheduler;
    private timer?: NodeJS.Timeout;
    private ticking = false;

    public static getInstance(): PostScheduler {
        if (!PostScheduler.instance) {
            PostScheduler.instance = new PostScheduler();
        }
        return PostScheduler.instance;
    }

    public start(): void {
        if (this.timer) return;
        logger.info('[PostScheduler] Started (checking for due posts every minute).');
        this.timer = setInterval(() => this.tick(), TICK_MS);
        this.recoverInterrupted().finally(() => this.tick());
    }

    /** Anything still "publishing" at startup belonged to a process that died mid-upload. */
    private async recoverInterrupted(): Promise<void> {
        if (!await this.waitForDb()) return;
        const res = await ScheduledPost.updateMany(
            { status: 'publishing' },
            { $set: { status: 'failed', lastError: 'Interrupted by a server restart while publishing. Check Instagram before retrying.' } }
        ).catch(() => null);
        if (res?.modifiedCount) logger.warn(`[PostScheduler] Marked ${res.modifiedCount} interrupted post(s) as failed.`);
    }

    private async waitForDb(timeoutMs = 60000): Promise<boolean> {
        const start = Date.now();
        while (mongoose.connection.readyState !== 1) {
            if (Date.now() - start > timeoutMs) return false;
            await new Promise(r => setTimeout(r, 1000));
        }
        return true;
    }

    private async tick(): Promise<void> {
        if (this.ticking || mongoose.connection.readyState !== 1) return;
        this.ticking = true;
        try {
            for (;;) {
                const now = new Date();
                // Atomic claim so a post can never be picked up twice
                const post = await ScheduledPost.findOneAndUpdate(
                    {
                        status: 'scheduled',
                        scheduledAt: { $lte: now },
                        $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }]
                    },
                    { $set: { status: 'publishing', publishingStartedAt: now } },
                    { sort: { scheduledAt: 1 }, new: true }
                );
                if (!post) break;

                // Not awaited: each account's browser lock serializes its own posts, while accounts run in parallel
                BotManager.getInstance()
                    .runWithClient(post.accountId, client => this.execute(client, post))
                    .catch(err => this.markFailed(post, err, true));
            }
        } catch (err) {
            logger.error(`[PostScheduler] Tick failed: ${err}`);
        } finally {
            this.ticking = false;
        }
    }

    /** Claims the post and publishes it right away as a dashboard task. Returns null if it can't be published now. */
    public async publishNow(postId: string): Promise<TaskEntry | null> {
        const post = await ScheduledPost.findOneAndUpdate(
            { _id: postId, status: { $in: ['draft', 'scheduled', 'failed'] } },
            { $set: { status: 'publishing', publishingStartedAt: new Date() } },
            { new: true }
        );
        if (!post) return null;
        return BotManager.getInstance().enqueueTask(
            post.accountId,
            'post-publish',
            client => this.execute(client, post),
            err => this.markFailed(post, err, false)
        );
    }

    private async execute(client: IgClient, post: IScheduledPost): Promise<{ permalink?: string }> {
        const dir = mediaDirFor(post.accountId);
        const result = await client.createPost({
            type: post.type,
            mediaPaths: post.media.map(m => path.join(dir, m.file)),
            caption: post.caption
        });
        await ScheduledPost.updateOne(
            { _id: post._id },
            {
                $set: { status: 'published', publishedAt: new Date(), permalink: result.permalink },
                $unset: { lastError: 1, nextAttemptAt: 1 }
            }
        );
        createAccountLogger(post.accountId).info(`[PostScheduler] Published ${post.type} ${post._id}${result.permalink ? ` -> ${result.permalink}` : ''}`);
        return result;
    }

    private async markFailed(post: IScheduledPost, err: any, allowRetry: boolean): Promise<void> {
        const message = err?.message || String(err);
        const attempts = (post.attempts || 0) + 1;
        const accountLogger = createAccountLogger(post.accountId);
        const retry = allowRetry && attempts < MAX_ATTEMPTS && !(err instanceof PostMaybePublishedError);

        if (retry) {
            await ScheduledPost.updateOne(
                { _id: post._id },
                { $set: { status: 'scheduled', attempts, lastError: message, nextAttemptAt: new Date(Date.now() + RETRY_BACKOFF_MS) } }
            ).catch(() => {});
            accountLogger.warn(`[PostScheduler] Post ${post._id} failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${message}. Retrying in 15 minutes.`);
            return;
        }

        await ScheduledPost.updateOne(
            { _id: post._id },
            { $set: { status: 'failed', attempts, lastError: message }, $unset: { nextAttemptAt: 1 } }
        ).catch(() => {});
        accountLogger.error(`[PostScheduler] Post ${post._id} failed: ${message}`);

        // Manual "Post now" failures are shown in the dashboard right away; only unattended ones send an email
        if (allowRetry) {
            const username = ConfigStore.getInstance().getAccount(post.accountId)?.username || post.accountId;
            BotManager.getInstance().getAlertEmailService()
                ?.sendErrorAlert(username, message, `Scheduled ${post.type} could not be published`)
                .catch(() => {});
        }
    }
}
