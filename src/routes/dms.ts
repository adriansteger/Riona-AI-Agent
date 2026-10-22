import express, { Request, Response } from 'express';
import { BotManager } from '../services/BotManager';
import { ConfigStore } from '../services/ConfigStore';
import { DmThread } from '../models/DmThread';
import { DmMessage } from '../models/DmMessage';
import { Contact } from '../models/Contact';
import { saveInboxThreads } from '../services/DmStore';
import { generateDmReply } from '../services/DmReplyGenerator';
import { chooseCharacter } from '../Agent';
import logger from '../config/logger';

// Mounted inside the dashboard router, after its auth middleware
const router = express.Router();
const botManager = BotManager.getInstance();
const configStore = ConfigStore.getInstance();

const MAX_MESSAGE_LENGTH = 1000;

function requireAccount(req: Request, res: Response) {
    const account = configStore.getAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: 'Account not found' });
        return null;
    }
    return account;
}

router.get('/accounts/:id/dms', async (req: Request, res: Response) => {
    if (!requireAccount(req, res)) return;
    try {
        const threads = await DmThread.find({ accountId: req.params.id }).sort({ lastMessageAt: -1 }).limit(100).lean();
        const lastSyncedAt = threads.reduce<Date | null>((max, t) => (t.syncedAt && (!max || t.syncedAt > max) ? t.syncedAt : max), null);
        return res.json({ threads, lastSyncedAt });
    } catch (err: any) {
        logger.error('[DashboardAPI] Error listing DM threads:', err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/accounts/:id/dms/:threadId', async (req: Request, res: Response) => {
    if (!requireAccount(req, res)) return;
    try {
        const { id, threadId } = req.params;
        const thread = await DmThread.findOne({ accountId: id, threadId }).lean();
        if (!thread) return res.status(404).json({ error: 'Thread not found' });
        const messages = await DmMessage.find({ accountId: id, threadId }).sort({ timestamp: 1 }).limit(200).lean();
        return res.json({ thread, messages });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/accounts/:id/dms/refresh', (req: Request, res: Response) => {
    if (!requireAccount(req, res)) return;
    const accountId = req.params.id;
    const task = botManager.enqueueTask(accountId, 'dm-refresh', async (client) => {
        const threads = await client.fetchInbox(20);
        await saveInboxThreads(accountId, threads);
        return { threads: threads.length };
    });
    return res.status(202).json({ taskId: task.id });
});

router.post('/accounts/:id/dms/:threadId/refresh', (req: Request, res: Response) => {
    if (!requireAccount(req, res)) return;
    const { id: accountId, threadId } = req.params;
    const task = botManager.enqueueTask(accountId, 'dm-thread-refresh', async (client) => {
        const thread = await client.fetchThread(threadId);
        await saveInboxThreads(accountId, [thread]);
        return { messages: thread.messages.length };
    });
    return res.status(202).json({ taskId: task.id });
});

router.post('/accounts/:id/dms/:threadId/send', (req: Request, res: Response) => {
    if (!requireAccount(req, res)) return;
    const { id: accountId, threadId } = req.params;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Message text is required.' });
    if (text.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: `Message is longer than ${MAX_MESSAGE_LENGTH} characters.` });

    const task = botManager.enqueueTask(accountId, 'dm-send', async (client) => {
        const thread = await client.sendThreadMessage(threadId, text);
        await saveInboxThreads(accountId, [thread]);
        return { sent: true };
    });
    return res.status(202).json({ taskId: task.id });
});

router.patch('/accounts/:id/dms/:threadId', async (req: Request, res: Response) => {
    if (!requireAccount(req, res)) return;
    if (typeof req.body?.aiEnabled !== 'boolean') {
        return res.status(400).json({ error: 'aiEnabled (boolean) is required.' });
    }
    try {
        const thread = await DmThread.findOneAndUpdate(
            { accountId: req.params.id, threadId: req.params.threadId },
            { $set: { aiEnabled: req.body.aiEnabled } },
            { new: true }
        ).lean();
        if (!thread) return res.status(404).json({ error: 'Thread not found' });
        return res.json({ success: true, thread });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/accounts/:id/dms/:threadId/suggest', async (req: Request, res: Response) => {
    const account = requireAccount(req, res);
    if (!account) return;
    try {
        const { id, threadId } = req.params;
        const thread = await DmThread.findOne({ accountId: id, threadId }).lean();
        if (!thread) return res.status(404).json({ error: 'Thread not found' });

        const recent = await DmMessage.find({ accountId: id, threadId }).sort({ timestamp: -1 }).limit(10).lean();
        const history = recent.reverse().map(m => ({ text: m.text, isMine: m.fromMe }));
        if (history.length === 0) return res.status(400).json({ error: 'No messages to reply to yet. Refresh the thread first.' });

        const partnerUsername = thread.participants[0]?.username || thread.title || 'User';
        const contact = await Contact.findOne({ username: partnerUsername }).lean().catch(() => null);

        const reply = await generateDmReply({
            character: chooseCharacter(account.character),
            languages: account.settings?.languages || ['English'],
            defaultLanguage: account.settings?.defaultLanguage || 'English',
            partnerUsername,
            history,
            facts: contact?.facts || []
        });
        const suggestion = reply.response === 'IGNORE' ? '' : reply.response;
        return res.json({ suggestion });
    } catch (err: any) {
        logger.error('[DashboardAPI] Error generating DM suggestion:', err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/tasks/:taskId', (req: Request, res: Response) => {
    const task = botManager.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found or expired' });
    return res.json({ task });
});

export default router;
