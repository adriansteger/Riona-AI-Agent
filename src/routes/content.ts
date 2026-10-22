import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ConfigStore } from '../services/ConfigStore';
import { ScheduledPost, PostType } from '../models/ScheduledPost';
import { PostScheduler, mediaDirFor } from '../services/PostScheduler';
import { generateCaption } from '../services/ContentAI';
import { chooseCharacter } from '../Agent';
import logger from '../config/logger';

// Mounted inside the dashboard router, after its auth middleware
const router = express.Router();
const configStore = ConfigStore.getInstance();
const scheduler = PostScheduler.getInstance();

const MAX_CAPTION_LENGTH = 2200;
const MAX_FILES = 10;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
};
const MEDIA_FILE_RE = /^[a-f0-9-]{36}\.(jpg|png|mp4|mov)$/;

const isVideo = (mime: string) => mime.startsWith('video/');

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, _file, cb) => {
            const dir = mediaDirFor(req.params.id);
            fs.mkdir(dir, { recursive: true }, err => cb(err, dir));
        },
        filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}.${EXT_BY_MIME[file.mimetype]}`),
    }),
    limits: { fileSize: MAX_VIDEO_BYTES, files: MAX_FILES },
    fileFilter: (_req, file, cb) => {
        if (EXT_BY_MIME[file.mimetype]) return cb(null, true);
        cb(new Error(`Unsupported file type ${file.mimetype}. Use JPEG, PNG, MP4 or MOV.`));
    },
});

function requireAccount(req: Request, res: Response, next: NextFunction) {
    if (!configStore.getAccount(req.params.id)) {
        return res.status(404).json({ error: 'Account not found' });
    }
    next();
}

function removeFiles(accountId: string, files: string[]) {
    const dir = mediaDirFor(accountId);
    for (const file of files) {
        fs.unlink(path.join(dir, file), () => {});
    }
}

function derivePostType(mimes: string[]): PostType {
    if (mimes.length > 1) return 'carousel';
    return isVideo(mimes[0]) ? 'reel' : 'photo';
}

function parseDate(value: unknown): Date | null | undefined {
    if (value === null || value === '') return null;
    if (value === undefined) return undefined;
    const d = new Date(String(value));
    return isNaN(d.getTime()) ? undefined : d;
}

router.get('/accounts/:id/posts', requireAccount, async (req: Request, res: Response) => {
    try {
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);
        const range: any = {};
        if (from) range.$gte = from;
        if (to) range.$lt = to;

        const filter: any = { accountId: req.params.id };
        if (from || to) {
            // Drafts without a date always show up so they can be planned
            filter.$or = [{ scheduledAt: range }, { publishedAt: range }, { scheduledAt: { $exists: false } }, { scheduledAt: null }];
        }
        const posts = await ScheduledPost.find(filter).sort({ scheduledAt: 1, createdAt: 1 }).limit(500).lean();
        return res.json({ posts });
    } catch (err: any) {
        logger.error('[DashboardAPI] Error listing posts:', err);
        return res.status(500).json({ error: err.message });
    }
});

router.post('/accounts/:id/posts', requireAccount, (req: Request, res: Response) => {
    upload.array('files', MAX_FILES)(req, res, async (uploadErr: any) => {
        const files = (req.files as Express.Multer.File[] | undefined) || [];
        const fail = (status: number, error: string) => {
            removeFiles(req.params.id, files.map(f => f.filename));
            return res.status(status).json({ error });
        };

        if (uploadErr) {
            const msg = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'A file is larger than 300 MB.'
                : uploadErr.code === 'LIMIT_FILE_COUNT' ? `At most ${MAX_FILES} files per post.`
                : uploadErr.message;
            return fail(400, msg);
        }
        if (files.length === 0) return fail(400, 'Add at least one photo or video.');
        const oversizedImage = files.find(f => !isVideo(f.mimetype) && f.size > MAX_IMAGE_BYTES);
        if (oversizedImage) return fail(400, `${oversizedImage.originalname} is larger than 30 MB.`);

        const caption = typeof req.body.caption === 'string' ? req.body.caption : '';
        if (caption.length > MAX_CAPTION_LENGTH) return fail(400, `Caption is longer than ${MAX_CAPTION_LENGTH} characters.`);

        const status = req.body.status === 'scheduled' ? 'scheduled' : 'draft';
        const scheduledAt = parseDate(req.body.scheduledAt);
        if (status === 'scheduled' && !scheduledAt) return fail(400, 'Pick a date and time to schedule the post.');

        try {
            const post = await ScheduledPost.create({
                accountId: req.params.id,
                type: derivePostType(files.map(f => f.mimetype)),
                media: files.map(f => ({ file: f.filename, mime: f.mimetype, size: f.size })),
                caption,
                scheduledAt: scheduledAt || undefined,
                status,
            });
            return res.status(201).json({ success: true, post });
        } catch (err: any) {
            return fail(500, err.message);
        }
    });
});

router.put('/posts/:postId', async (req: Request, res: Response) => {
    try {
        const post = await ScheduledPost.findById(req.params.postId);
        if (!post) return res.status(404).json({ error: 'Post not found' });
        if (post.status === 'publishing' || post.status === 'published') {
            return res.status(409).json({ error: `A ${post.status} post can't be edited.` });
        }

        const { caption, status, mediaOrder } = req.body;
        if (caption !== undefined) {
            if (typeof caption !== 'string' || caption.length > MAX_CAPTION_LENGTH) {
                return res.status(400).json({ error: `Caption must be text of at most ${MAX_CAPTION_LENGTH} characters.` });
            }
            post.caption = caption;
        }
        if (req.body.scheduledAt !== undefined) {
            const scheduledAt = parseDate(req.body.scheduledAt);
            if (scheduledAt === undefined) return res.status(400).json({ error: 'Invalid date.' });
            post.scheduledAt = scheduledAt || undefined;
        }
        if (Array.isArray(mediaOrder)) {
            const current = post.media.map(m => m.file);
            const isPermutation = mediaOrder.length === current.length && current.every(f => mediaOrder.includes(f));
            if (!isPermutation) return res.status(400).json({ error: 'mediaOrder must list the post\'s files.' });
            post.media = mediaOrder.map((f: string) => post.media.find(m => m.file === f)!) as any;
        }
        if (status === 'draft' || status === 'scheduled') {
            post.status = status;
            // A manual reschedule starts the retry budget over
            post.attempts = 0;
            post.lastError = undefined;
            post.nextAttemptAt = undefined;
        }
        if (post.status === 'scheduled' && !post.scheduledAt) {
            return res.status(400).json({ error: 'Pick a date and time to schedule the post.' });
        }

        await post.save();
        return res.json({ success: true, post });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

router.delete('/posts/:postId', async (req: Request, res: Response) => {
    try {
        const post = await ScheduledPost.findById(req.params.postId);
        if (!post) return res.status(404).json({ error: 'Post not found' });
        if (post.status === 'publishing') return res.status(409).json({ error: 'The post is being published right now.' });
        await post.deleteOne();
        removeFiles(post.accountId, post.media.map(m => m.file));
        return res.json({ success: true });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/posts/:postId/publish-now', async (req: Request, res: Response) => {
    try {
        const task = await scheduler.publishNow(req.params.postId);
        if (!task) return res.status(409).json({ error: 'This post is already published or being published.' });
        return res.status(202).json({ taskId: task.id });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/accounts/:id/caption', requireAccount, async (req: Request, res: Response) => {
    const brief = typeof req.body?.brief === 'string' ? req.body.brief.trim() : '';
    const type: PostType = ['photo', 'carousel', 'reel'].includes(req.body?.type) ? req.body.type : 'photo';
    if (!brief) return res.status(400).json({ error: 'Describe what the post is about.' });
    try {
        const account = configStore.getAccount(req.params.id)!;
        const result = await generateCaption(chooseCharacter(account.character), {
            brief: brief.slice(0, 2000),
            type,
            languages: account.settings?.languages,
            defaultLanguage: account.settings?.defaultLanguage,
            hashtags: account.settings?.hashtags,
        });
        return res.json(result);
    } catch (err: any) {
        logger.error('[DashboardAPI] Error generating caption:', err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/media/:id/:file', requireAccount, (req: Request, res: Response) => {
    const { id, file } = req.params;
    if (!MEDIA_FILE_RE.test(file)) return res.status(400).json({ error: 'Invalid file name' });
    return res.sendFile(path.join(mediaDirFor(id), file), err => {
        if (err && !res.headersSent) res.status(404).json({ error: 'File not found' });
    });
});

export default router;
