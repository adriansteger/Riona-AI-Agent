import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { BotManager } from '../services/BotManager';
import { ConfigStore } from '../services/ConfigStore';
import { CharacterStore } from '../services/CharacterStore';
import { LogBus, LogEntry } from '../services/LogBus';
import logger from '../config/logger';

const router = express.Router();
const botManager = BotManager.getInstance();
const configStore = ConfigStore.getInstance();
const characterStore = CharacterStore.getInstance();
const logBus = LogBus.getInstance();

const DASHBOARD_SECRET = process.env.DASHBOARD_JWT_SECRET || process.env.JWT_SECRET || 'fallbackDashSecret987!';
const DASHBOARD_COOKIE_NAME = 'dash_token';

// Simple in-memory rate limiter for login
const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();
function checkLoginRateLimit(ip: string): boolean {
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute
    const maxAttempts = 10;

    const record = loginAttempts.get(ip);
    if (!record) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
        return true;
    }

    if (now - record.firstAttempt > windowMs) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
        return true;
    }

    record.count++;
    return record.count <= maxAttempts;
}

// Token helper
function getDashboardToken(req: Request): string | null {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    const cookie = req.cookies ? req.cookies[DASHBOARD_COOKIE_NAME] : null;
    if (cookie) return cookie;

    // Fallback manual cookie parse
    const rawCookie = req.headers['cookie'];
    if (rawCookie) {
        const match = rawCookie.match(new RegExp(`(?:^|; )${DASHBOARD_COOKIE_NAME}=([^;]*)`));
        if (match) return decodeURIComponent(match[1]);
    }
    return null;
}

// Auth Middleware
export function requireDashboardAuth(req: Request, res: Response, next: NextFunction) {
    // Also allow SSE query param token if browser EventSource doesn't support custom headers
    let token = getDashboardToken(req);
    if (!token && req.query.token && typeof req.query.token === 'string') {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    try {
        const decoded = jwt.verify(token, DASHBOARD_SECRET) as any;
        if (decoded?.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
        }
        (req as any).adminUser = decoded;
        next();
    } catch {
        return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    }
}

// ================= AUTH ROUTES =================

router.post('/auth/login', (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
    if (!checkLoginRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many login attempts. Please wait a minute.' });
    }

    const { password } = req.body;
    const configuredPassword = process.env.DASHBOARD_PASSWORD;

    if (!configuredPassword) {
        logger.warn('[DashboardAuth] Login rejected: DASHBOARD_PASSWORD not set in environment.');
        return res.status(503).json({ error: 'Dashboard login is disabled. Please set DASHBOARD_PASSWORD in .env' });
    }

    if (!password) {
        return res.status(400).json({ error: 'Password is required' });
    }

    // Timing-safe comparison
    const inputBuf = Buffer.from(password);
    const passBuf = Buffer.from(configuredPassword);

    let match = false;
    if (inputBuf.length === passBuf.length) {
        match = crypto.timingSafeEqual(inputBuf, passBuf);
    }

    if (!match) {
        return res.status(401).json({ error: 'Invalid password' });
    }

    const token = jwt.sign({ role: 'admin', loggedInAt: Date.now() }, DASHBOARD_SECRET, { expiresIn: '7d' });

    res.cookie(DASHBOARD_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        secure: process.env.NODE_ENV === 'production'
    });

    return res.json({ success: true, message: 'Logged in successfully', token });
});

router.post('/auth/logout', (_req: Request, res: Response) => {
    res.clearCookie(DASHBOARD_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    });
    return res.json({ success: true, message: 'Logged out successfully' });
});

router.get('/auth/me', requireDashboardAuth, (_req: Request, res: Response) => {
    return res.json({ authenticated: true, role: 'admin' });
});

// Protect all following routes
router.use(requireDashboardAuth);

// ================= OVERVIEW =================

router.get('/overview', (_req: Request, res: Response) => {
    try {
        const overviews = botManager.getOverview();
        const jobBot = botManager.getJobBotStatus();
        return res.json({
            accounts: overviews,
            jobBot
        });
    } catch (err: any) {
        logger.error('[DashboardAPI] Error fetching overview:', err);
        return res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// ================= ACCOUNTS CRUD =================

router.get('/accounts', (_req: Request, res: Response) => {
    try {
        const accounts = configStore.getSanitizedAccounts();
        return res.json({ accounts });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/accounts/:id', (req: Request, res: Response) => {
    const account = configStore.getSanitizedAccount(req.params.id);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    return res.json({ account });
});

router.post('/accounts', (req: Request, res: Response) => {
    try {
        const result = configStore.upsertAccount(req.body);
        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }
        // If account created and marked enabled, automatically start it
        if (req.body.enabled) {
            botManager.start(result.account!.id);
        }
        return res.status(201).json({ success: true, account: result.account });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

router.put('/accounts/:id', async (req: Request, res: Response) => {
    try {
        const id = req.params.id;
        const result = configStore.upsertAccount({ ...req.body, id });
        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        // If enabled status changed, trigger botManager action
        if (req.body.enabled === false) {
            await botManager.stop(id);
        } else if (req.body.enabled === true) {
            botManager.start(id);
        }

        return res.json({ success: true, account: result.account });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

router.delete('/accounts/:id', async (req: Request, res: Response) => {
    try {
        const id = req.params.id;
        await botManager.stop(id);
        const result = configStore.deleteAccount(id);
        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }
        return res.json({ success: true, message: `Account ${id} deleted.` });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

// ================= BOT RUNTIME CONTROLS =================

router.post('/accounts/:id/start', (req: Request, res: Response) => {
    const result = botManager.start(req.params.id);
    return res.json(result);
});

router.post('/accounts/:id/stop', async (req: Request, res: Response) => {
    const result = await botManager.stop(req.params.id);
    return res.json(result);
});

router.post('/accounts/:id/pause', (req: Request, res: Response) => {
    const result = botManager.pause(req.params.id);
    return res.json(result);
});

router.post('/accounts/:id/resume', (req: Request, res: Response) => {
    const result = botManager.resume(req.params.id);
    return res.json(result);
});

router.post('/accounts/:id/restart', async (req: Request, res: Response) => {
    const result = await botManager.restart(req.params.id);
    return res.json(result);
});

// ================= LOGS =================

router.get('/logs/:id', (req: Request, res: Response) => {
    const accountId = req.params.id;
    const dateStr = req.query.date as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

    const logs = logBus.getHistoricalLogs(accountId, dateStr, limit);
    return res.json({ logs });
});

// SSE Live Log Stream
router.get('/logs/:id/stream', (req: Request, res: Response) => {
    const accountId = req.params.id;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    res.flushHeaders?.();

    // 1. Send recent buffered logs first
    const initialLogs = logBus.getRecentLogs(accountId, 50);
    for (const log of initialLogs) {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    }

    // 2. Subscribe to incoming logs
    const eventName = accountId === 'all' ? 'log:*' : `log:${accountId}`;
    const onLog = (entry: LogEntry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    logBus.on(eventName, onLog);

    // Keepalive heartbeat every 15s
    const keepalive = setInterval(() => {
        res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
        clearInterval(keepalive);
        logBus.off(eventName, onLog);
    });
});

// ================= JOB BOT =================

router.get('/jobbot', (_req: Request, res: Response) => {
    const status = botManager.getJobBotStatus();
    return res.json(status);
});

router.put('/jobbot', (req: Request, res: Response) => {
    const { enabled, platforms, proxy } = req.body;
    const jobAccounts = configStore.getJobAccounts();
    const mainBotId = jobAccounts.jobBots?.[0]?.id || 'job_bot_main';

    const updates: any = {};
    if (enabled !== undefined) updates.enabled = !!enabled;
    if (proxy !== undefined) updates.proxy = proxy;
    if (platforms !== undefined && Array.isArray(platforms)) {
        updates.preferences = { platforms };
    }

    const result = configStore.updateJobBot(mainBotId, updates);
    if (!result.success) {
        return res.status(400).json({ error: result.error });
    }

    // Sync botManager running state
    if (updates.enabled === true) {
        botManager.startJobBot();
    } else if (updates.enabled === false) {
        botManager.stopJobBot();
    }

    return res.json({ success: true, jobBot: botManager.getJobBotStatus() });
});

router.post('/jobbot/start', (_req: Request, res: Response) => {
    const result = botManager.startJobBot();
    return res.json(result);
});

router.post('/jobbot/stop', async (_req: Request, res: Response) => {
    const result = await botManager.stopJobBot();
    return res.json(result);
});

// ================= CHARACTERS =================

router.get('/characters', (_req: Request, res: Response) => {
    const characters = characterStore.listCharacters();
    return res.json({ characters });
});

router.get('/characters/:file', (req: Request, res: Response) => {
    const result = characterStore.getCharacter(req.params.file);
    if (!result.success) {
        return res.status(404).json({ error: result.error });
    }
    return res.json({ character: result.data });
});

router.put('/characters/:file', (req: Request, res: Response) => {
    const result = characterStore.saveCharacter(req.params.file, req.body);
    if (!result.success) {
        return res.status(400).json({ error: result.error });
    }
    return res.json({ success: true, message: `Character ${req.params.file} saved.` });
});

router.post('/characters', (req: Request, res: Response) => {
    const { filename, data } = req.body;
    if (!filename || !data) {
        return res.status(400).json({ error: 'Filename and data are required.' });
    }
    const result = characterStore.saveCharacter(filename, data);
    if (!result.success) {
        return res.status(400).json({ error: result.error });
    }
    return res.status(201).json({ success: true, message: `Character ${filename} created.` });
});

router.delete('/characters/:file', (req: Request, res: Response) => {
    const result = characterStore.deleteCharacter(req.params.file);
    if (!result.success) {
        return res.status(400).json({ error: result.error });
    }
    return res.json({ success: true, message: `Character ${req.params.file} deleted.` });
});

export default router;
