import path from 'path';
import logger, { createAccountLogger } from '../config/logger';
import { pLimit, ScheduleTracker, ActivityTracker } from '../utils';
import { IgClient } from '../client/IG-bot/IgClient';
import { EmailService } from './EmailService';
import { JobClient } from '../client/JobBot/JobClient';
import { ConfigStore, SanitizedAccountConfig, JobBotConfig } from './ConfigStore';
import { processAccount } from './accountRunner';

export type BotLifecycleState = 'running' | 'resting' | 'sleeping' | 'paused' | 'stopped' | 'disabled' | 'idle';

export interface AccountOverview {
    account: SanitizedAccountConfig;
    state: BotLifecycleState;
    nextActiveTime: number;
    lastDMCheckTime: number;
    isSleeping: boolean;
    activeSession: boolean;
    activity: {
        likes1h: number;
        comments1h: number;
        dms1h: number;
    };
    lastError?: string;
    lastRunAt?: number;
}

interface RuntimeEntry {
    state: 'idle' | 'paused' | 'stopped';
    stopRequested: boolean;
    loopPromise?: Promise<void>;
    lastError?: string;
    lastRunAt?: number;
}

export class BotManager {
    private static instance: BotManager;

    private configStore: ConfigStore;
    private activeSessions = new Map<string, IgClient>();
    private runtimes = new Map<string, RuntimeEntry>();

    private sessionLimit: any;
    private interactionLimit: any;

    private globalAlertEmailService?: EmailService;

    // Job Bot runtime
    private jobBotRunning: boolean = false;
    private jobBotStopRequested: boolean = false;
    private jobBotPromise?: Promise<void>;
    private globalJobEmailService: EmailService | null = null;
    private globalJobClient: JobClient | null = null;
    private jobBotLastError?: string;
    private jobBotLastRunAt?: number;

    private constructor() {
        this.configStore = ConfigStore.getInstance();

        const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '5', 10);
        this.sessionLimit = pLimit(maxConcurrent);

        const maxConcurrentInteractions = process.env.MAX_CONCURRENT_INTERACTIONS
            ? parseInt(process.env.MAX_CONCURRENT_INTERACTIONS, 10)
            : Math.min(maxConcurrent, 5);
        this.interactionLimit = pLimit(maxConcurrentInteractions);

        this.initAlertEmailService();
    }

    public static getInstance(): BotManager {
        if (!BotManager.instance) {
            BotManager.instance = new BotManager();
        }
        return BotManager.instance;
    }

    private initAlertEmailService(): void {
        const mailUser = process.env.IG_ALERT_EMAIL_USER || process.env.EMAIL_USER;
        const mailPass = process.env.IG_ALERT_EMAIL_PASS || process.env.EMAIL_PASS;
        const mailHost = process.env.IG_ALERT_EMAIL_HOST || process.env.EMAIL_HOST;
        const mailPort = process.env.IG_ALERT_EMAIL_PORT || process.env.EMAIL_PORT || '465';
        const mailSecure = process.env.IG_ALERT_EMAIL_SECURE || process.env.EMAIL_SECURE || 'true';
        const mailFrom = process.env.IG_ALERT_EMAIL_FROM || process.env.EMAIL_FROM;
        const mailService = process.env.IG_ALERT_EMAIL_SERVICE || process.env.EMAIL_SERVICE;
        const mailTo = process.env.IG_ALERT_EMAIL_TO || process.env.EMAIL_ALERTS_TO || mailUser;

        if (mailUser && mailPass) {
            this.globalAlertEmailService = new EmailService({
                host: mailHost,
                port: parseInt(mailPort, 10),
                secure: mailSecure === 'true',
                user: mailUser,
                pass: mailPass,
                to: mailTo!,
                from: mailFrom,
                service: mailService
            });
            logger.info(`[BotManager] Global Email Alert System initialized (Sender: ${mailFrom || mailUser})`);
        } else {
            logger.warn("[BotManager] Email alert system skipped (Missing Credentials).");
        }
    }

    private async interruptibleSleep(ms: number, shouldStop: () => boolean): Promise<void> {
        const interval = 500;
        let elapsed = 0;
        while (elapsed < ms && !shouldStop()) {
            await new Promise(r => setTimeout(r, Math.min(interval, ms - elapsed)));
            elapsed += interval;
        }
    }

    // --- INSTAGRAM BOT CONTROLS ---

    public start(accountId: string): { success: boolean; message?: string } {
        const account = this.configStore.getAccount(accountId);
        if (!account) {
            return { success: false, message: 'Account not found in config.' };
        }

        let rt = this.runtimes.get(accountId);
        if (rt && !rt.stopRequested && rt.state !== 'stopped') {
            return { success: true, message: 'Account loop is already running.' };
        }

        // Initialize or reset runtime
        rt = {
            state: 'idle',
            stopRequested: false,
            lastRunAt: Date.now()
        };
        this.runtimes.set(accountId, rt);

        const accountLogger = createAccountLogger(accountId);
        accountLogger.info(`[BotManager] Starting independent loop for account: ${accountId} (${account.username})`);

        rt.loopPromise = (async () => {
            const currentRt = this.runtimes.get(accountId);
            while (currentRt && !currentRt.stopRequested) {
                try {
                    const freshAccount = this.configStore.getAccount(accountId);
                    if (!freshAccount || !freshAccount.enabled) {
                        accountLogger.info(`[BotManager] Account ${accountId} is disabled or deleted. Exiting loop.`);
                        break;
                    }

                    if (currentRt.state !== 'paused') {
                        currentRt.lastRunAt = Date.now();
                        await processAccount(freshAccount, {
                            activeSessions: this.activeSessions,
                            sessionLimit: this.sessionLimit,
                            interactionLimit: this.interactionLimit,
                            emailService: this.globalAlertEmailService
                        });
                    }
                } catch (err: any) {
                    currentRt.lastError = err.message || String(err);
                    accountLogger.error(`[BotManager] Error in loop for ${accountId}: ${err}`);
                }

                await this.interruptibleSleep(30000, () => !currentRt || currentRt.stopRequested);
            }

            if (currentRt) {
                currentRt.state = 'stopped';
            }
            accountLogger.info(`[BotManager] Independent loop ended for account: ${accountId}`);
        })();

        return { success: true, message: `Started bot for ${accountId}` };
    }

    public async stop(accountId: string): Promise<{ success: boolean; message?: string }> {
        const rt = this.runtimes.get(accountId);
        const accountLogger = createAccountLogger(accountId);

        if (!rt || rt.state === 'stopped') {
            // Also ensure any lingering session is closed
            const session = this.activeSessions.get(accountId);
            if (session) {
                await session.close().catch(() => {});
                this.activeSessions.delete(accountId);
            }
            return { success: true, message: 'Bot was not running.' };
        }

        rt.stopRequested = true;
        rt.state = 'stopped';

        // Close any active browser session immediately
        const session = this.activeSessions.get(accountId);
        if (session) {
            accountLogger.info(`[BotManager] Closing active browser session for stop request: ${accountId}`);
            try {
                await session.close();
            } catch (err) {
                accountLogger.warn(`[BotManager] Error closing session on stop: ${err}`);
            }
            this.activeSessions.delete(accountId);
        }

        return { success: true, message: `Stop signal sent for ${accountId}` };
    }

    public pause(accountId: string): { success: boolean; message?: string } {
        const rt = this.runtimes.get(accountId);
        if (!rt || rt.state === 'stopped') {
            return { success: false, message: 'Bot is not running.' };
        }
        rt.state = 'paused';
        const accountLogger = createAccountLogger(accountId);
        accountLogger.info(`[BotManager] Bot paused for: ${accountId}`);
        return { success: true, message: `Paused bot for ${accountId}` };
    }

    public resume(accountId: string): { success: boolean; message?: string } {
        const rt = this.runtimes.get(accountId);
        if (!rt || rt.state === 'stopped') {
            return this.start(accountId);
        }
        rt.state = 'idle';
        const accountLogger = createAccountLogger(accountId);
        accountLogger.info(`[BotManager] Bot resumed for: ${accountId}`);
        return { success: true, message: `Resumed bot for ${accountId}` };
    }

    public async restart(accountId: string): Promise<{ success: boolean; message?: string }> {
        await this.stop(accountId);
        // Short pause to ensure socket release
        await new Promise(r => setTimeout(r, 1000));
        return this.start(accountId);
    }

    public async stopAll(): Promise<void> {
        logger.info("[BotManager] Stopping all running bots...");
        const accountIds = Array.from(this.runtimes.keys());
        await Promise.all(accountIds.map(id => this.stop(id)));

        if (this.jobBotRunning) {
            await this.stopJobBot();
        }
        logger.info("[BotManager] All bots stopped.");
    }

    public getOverview(): AccountOverview[] {
        const accounts = this.configStore.getSanitizedAccounts();
        const overviews: AccountOverview[] = [];

        for (const account of accounts) {
            const rt = this.runtimes.get(account.id);
            const trackerId = account.userDataDir ? path.basename(account.userDataDir) : account.username;

            const scheduleTracker = new ScheduleTracker(trackerId);
            const activityTracker = new ActivityTracker(trackerId);

            const scheduleSettings = account.settings?.schedule || {
                sleepStartHour: 23,
                sleepEndHour: 7
            };

            const isSleeping = ScheduleTracker.isSleepTime(
                scheduleSettings.sleepStartHour ?? 23,
                scheduleSettings.sleepEndHour ?? 7
            );

            const nextActiveTime = scheduleTracker.getNextActiveTime();
            const lastDMCheckTime = scheduleTracker.getLastDMCheckTime();
            const hasActiveSession = this.activeSessions.has(account.id);

            // Derive state
            let state: BotLifecycleState = 'idle';
            if (!account.enabled) {
                state = 'disabled';
            } else if (!rt || rt.stopRequested || rt.state === 'stopped') {
                state = 'stopped';
            } else if (rt.state === 'paused') {
                state = 'paused';
            } else if (hasActiveSession) {
                state = 'running';
            } else if (isSleeping) {
                state = 'sleeping';
            } else if (Date.now() < nextActiveTime) {
                state = 'resting';
            } else {
                state = 'idle';
            }

            overviews.push({
                account,
                state,
                nextActiveTime,
                lastDMCheckTime,
                isSleeping,
                activeSession: hasActiveSession,
                activity: {
                    likes1h: activityTracker.getRecentCount('likes'),
                    comments1h: activityTracker.getRecentCount('comments'),
                    dms1h: activityTracker.getRecentCount('dms')
                },
                lastError: rt?.lastError,
                lastRunAt: rt?.lastRunAt
            });
        }

        return overviews;
    }

    // --- JOB BOT CONTROLS ---

    public getJobBotStatus(): {
        running: boolean;
        config: JobBotConfig | null;
        lastRunAt?: number;
        lastError?: string;
    } {
        const jobAccounts = this.configStore.getJobAccounts();
        const mainBot = jobAccounts.jobBots?.[0] || null;
        return {
            running: this.jobBotRunning,
            config: mainBot,
            lastRunAt: this.jobBotLastRunAt,
            lastError: this.jobBotLastError
        };
    }

    public startJobBot(): { success: boolean; message?: string } {
        if (this.jobBotRunning) {
            return { success: true, message: 'Job Bot is already running.' };
        }

        this.jobBotRunning = true;
        this.jobBotStopRequested = false;

        this.jobBotPromise = (async () => {
            logger.info("[BotManager] Job Bot loop started.");
            while (this.jobBotRunning && !this.jobBotStopRequested) {
                try {
                    await this.runJobBotCycle();
                } catch (err: any) {
                    this.jobBotLastError = err.message || String(err);
                    logger.error(`[BotManager] Error in Job Bot cycle: ${err}`);
                }
                await this.interruptibleSleep(30000, () => !this.jobBotRunning || this.jobBotStopRequested);
            }
            this.jobBotRunning = false;
            logger.info("[BotManager] Job Bot loop finished.");
        })();

        return { success: true, message: 'Job Bot started.' };
    }

    public async stopJobBot(): Promise<{ success: boolean; message?: string }> {
        if (!this.jobBotRunning) {
            return { success: true, message: 'Job Bot was not running.' };
        }
        this.jobBotStopRequested = true;
        this.jobBotRunning = false;

        if (this.globalJobClient) {
            try {
                await this.globalJobClient.close();
            } catch (err) {
                logger.warn(`[BotManager] Error closing Job Bot client: ${err}`);
            }
            this.globalJobClient = null;
        }

        return { success: true, message: 'Job Bot stopped.' };
    }

    private async runJobBotCycle(): Promise<void> {
        const jobConfig = this.configStore.getJobAccounts();
        const isEnabled = jobConfig.jobBots?.some(bot => bot.enabled);

        if (!isEnabled) {
            logger.info("[BotManager] Job Bot is disabled in job_accounts.json. Skipping cycle.");
            return;
        }

        logger.info("[BotManager] Starting Job Search Bot (Env/API Config)...");

        const emailConfig = {
            host: process.env.EMAIL_HOST || '',
            port: parseInt(process.env.EMAIL_PORT || '465', 10),
            secure: process.env.EMAIL_SECURE === 'true',
            user: process.env.EMAIL_USER || '',
            pass: process.env.EMAIL_PASS || '',
            to: '',
            from: process.env.EMAIL_FROM,
            service: process.env.EMAIL_SERVICE
        };

        if (!emailConfig.user || !emailConfig.pass) {
            logger.warn("[BotManager] Missing EMAIL_USER or EMAIL_PASS in .env. Skipping Job Bot.");
            return;
        }

        this.jobBotLastRunAt = Date.now();

        if (!this.globalJobClient) {
            if (!this.globalJobEmailService) {
                this.globalJobEmailService = new EmailService(emailConfig);
            }

            const botConfig = jobConfig.jobBots?.[0];
            const platforms = botConfig?.preferences?.platforms || ['indeed', 'ziprecruiter', 'weworkremotely'];
            const proxy = botConfig?.proxy;

            const defaultJobConfig = {
                keywords: [],
                location: 'Remote',
                platforms: platforms,
                proxy: proxy
            };

            this.globalJobClient = new JobClient(this.globalJobEmailService, defaultJobConfig);
            await this.globalJobClient.init();
        }

        await this.globalJobClient.runSearch();
    }

    // --- BOOTSTRAP ---

    public bootstrap(): void {
        logger.info("[BotManager] Bootstrapping bots from config...");
        const accounts = this.configStore.getAccounts();
        const enabledAccounts = accounts.filter(a => a.enabled);

        logger.info(`[BotManager] Found ${enabledAccounts.length} enabled Instagram account(s): ${enabledAccounts.map(a => a.id).join(', ')}`);

        for (const account of enabledAccounts) {
            this.start(account.id);
        }

        const jobAccounts = this.configStore.getJobAccounts();
        const jobEnabled = jobAccounts.jobBots?.some(b => b.enabled);
        if (jobEnabled) {
            logger.info("[BotManager] Job Bot is enabled in config. Starting Job Bot loop...");
            this.startJobBot();
        } else {
            logger.info("[BotManager] Job Bot is disabled in config.");
        }
    }
}
