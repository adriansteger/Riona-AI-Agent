import path from 'path';
import { IgClient } from '../client/IG-bot/IgClient';
import { chooseCharacter } from '../Agent';
import { createAccountLogger } from '../config/logger';
import { EmailService } from './EmailService';
import { ScheduleTracker, ActivityTracker, getDailyLikeCap } from '../utils';
import { recordStat } from './StatsRecorder';
import { saveInboxThreads } from './DmStore';

export interface AccountRunnerContext {
    activeSessions: Map<string, IgClient>;
    sessionLimit: (fn: () => Promise<any>) => Promise<any>;
    interactionLimit: (fn: () => Promise<any>) => Promise<any>;
    // Serializes everything that opens this account's browser profile (bot cycles and dashboard tasks)
    withAccountLock: <T>(accountId: string, fn: () => Promise<T>) => Promise<T>;
    emailService?: EmailService;
}

export const createIgClient = (
    account: any,
    options: { headless: boolean; character: any; logger: any; emailService?: EmailService }
): IgClient => {
    return new IgClient({
        accountId: account.id,
        username: account.username,
        password: account.password,
        userDataDir: account.userDataDir,
        proxy: account.proxy,
        languages: account.settings?.languages,
        defaultLanguage: account.settings?.defaultLanguage,
        headless: options.headless
    }, options.logger, options.character, options.emailService);
};

const syncInboxQuietly = async (igClient: IgClient, accountId: string, accountLogger: any): Promise<void> => {
    try {
        await saveInboxThreads(accountId, await igClient.fetchInbox(20, { allowScrape: false }));
    } catch (err) {
        accountLogger.warn(`[DM Sync] Inbox sync failed: ${err}`);
    }
};

export const processAccount = async (
    account: any,
    context: AccountRunnerContext
): Promise<void> => {
    const { activeSessions, sessionLimit, interactionLimit, withAccountLock, emailService } = context;

    // Stagger start slightly (0-5s) to avoid CPU spikes if multiple launch at once
    const stagger = Math.floor(Math.random() * 5000);
    await new Promise(r => setTimeout(r, stagger));

    const accountLogger = createAccountLogger(account.id);
    accountLogger.info(`>>> Starting session for account: ${account.id} (${account.username}) <<<`);

    try {
        // Load specific character for this account
        const character = chooseCharacter(account.character);
        accountLogger.info(`Loaded character: ${character?.aiPersona?.name || "Default/Unknown"}`);

        // --- SETTINGS MERGE ---
        // 1. Get defaults from Character (or hard defaults)
        const characterBehavior = character?.settings?.behavior || character?.behavior || { enableLikes: true, enableComments: true, enableCommentLikes: false };
        const characterLimits = character?.limits || { likesPerHour: 10, commentsPerHour: 5 };

        // 2. Get overrides from Account Config (accounts.json)
        const accountBehavior = account.settings?.behavior || {};
        const accountLimits = account.settings?.limits || {};

        // 3. Merge: Account settings take precedence
        const behavior = { ...characterBehavior, ...accountBehavior };
        const limits = { ...characterLimits, ...accountLimits };
        const scheduleSettings = account.settings?.schedule || {
            sleepStartHour: 23, // 11 PM
            sleepEndHour: 7, // 7 AM
            minRestMinutes: 45, // 45 minutes
            maxRestMinutes: 120 // 2 hours
        };

        // --- PRE-RUN AVAILABILITY CHECK ---
        const trackerId = account.userDataDir ? path.basename(account.userDataDir) : account.username;

        // Check human-like schedule cycles
        const scheduleTracker = new ScheduleTracker(trackerId);

        if (ScheduleTracker.isSleepTime(scheduleSettings.sleepStartHour, scheduleSettings.sleepEndHour)) {
            // Sleep over midnight logic or simple sleep time logic
            accountLogger.info(`Account is currently in a sleep window (${scheduleSettings.sleepStartHour}:00 - ${scheduleSettings.sleepEndHour}:00). Skipping check.`);

            // Critical: Ensure session is closed during sleep to save memory
            const existingClient = activeSessions.get(account.id);
            if (existingClient) {
                await existingClient.close();
                activeSessions.delete(account.id);
                accountLogger.info("Closed persistent session for sleep cycle.");
            }
            return;
        }

        let isDMOnlyRun = false;
        const nextActiveTime = scheduleTracker.getNextActiveTime();
        if (Date.now() < nextActiveTime) {
            if (behavior.enableAutoDMs === true) {
                const lastDMCheck = scheduleTracker.getLastDMCheckTime();
                const dmIntervalMs = (account.settings?.schedule?.dmCheckIntervalMinutes || 2) * 60 * 1000;
                if (Date.now() - lastDMCheck >= dmIntervalMs) {
                    isDMOnlyRun = true;
                    accountLogger.info(`Account is resting, but executing a quick, headless DM-only check (last checked ${Math.round((Date.now() - lastDMCheck) / 60000)}m ago).`);
                }
            }

            if (!isDMOnlyRun) {
                // Find remaining wait
                const remainingMinutes = Math.ceil((nextActiveTime - Date.now()) / 60000);
                accountLogger.info(`Account is resting. Waiting ~${remainingMinutes} minutes before next active cycle.`);

                // Critical: Ensure session is closed during rest to save memory
                const existingClient = activeSessions.get(account.id);
                if (existingClient) {
                    await existingClient.close();
                    activeSessions.delete(account.id);
                    accountLogger.info("Closed persistent session for rest cycle.");
                }
                return;
            }
        }

        // If active cycle is due, check if the heavy interaction slot is available
        if (!isDMOnlyRun && Date.now() >= nextActiveTime) {
            if ((interactionLimit as any).activeCount >= (interactionLimit as any).concurrency) {
                accountLogger.debug(`Active cycle is due, but the heavy interaction slot is busy (${(interactionLimit as any).activeCount}/${(interactionLimit as any).concurrency} active).`);
                if (behavior.enableAutoDMs === true) {
                    const lastDMCheck = scheduleTracker.getLastDMCheckTime();
                    const dmIntervalMs = (account.settings?.schedule?.dmCheckIntervalMinutes || 2) * 60 * 1000;
                    if (Date.now() - lastDMCheck >= dmIntervalMs) {
                        isDMOnlyRun = true;
                        accountLogger.info(`Executing a quick, headless DM-only check instead of full interaction cycle.`);
                    }
                }

                if (!isDMOnlyRun) {
                    accountLogger.debug(`Postponing active cycle. Retrying in next loop iteration.`);
                    return;
                }
            }
        }

        const activityTracker = new ActivityTracker(trackerId);

        // --- DAILY LIKE CAP ---
        // Once reached, likes count as unavailable. The session only continues if comments or DMs can still run.
        // limits.likesPerDay is the average; the effective cap varies per account per day.
        const likesPerDay = getDailyLikeCap(
            account.id,
            Number(limits.likesPerDay) || 110,
            limits.likesPerDayJitter !== undefined ? Number(limits.likesPerDayJitter) : 20
        );
        const likesToday = activityTracker.getTodayCount('likes');
        const likeCapReached = behavior.enableLikes !== false && likesToday >= likesPerDay;
        if (!isDMOnlyRun && likeCapReached) {
            const otherWorkEnabled = behavior.enableComments !== false || behavior.enableAutoDMs === true;
            if (!otherWorkEnabled) {
                const wakeTime = ScheduleTracker.getNextWakeTime(scheduleSettings.sleepEndHour ?? 7);
                scheduleTracker.setNextActiveTime(wakeTime);
                accountLogger.info(`Daily like cap reached (${likesToday}/${likesPerDay}). Resting until ${new Date(wakeTime).toLocaleString()}.`);
                return;
            }
            accountLogger.info(`Daily like cap reached (${likesToday}/${likesPerDay}) — continuing for comments/DMs only.`);
        }

        // --- LIKES PER SESSION RANDOMIZATION ---
        let sessionLikesTarget = 10;
        if (limits.likesPerSession) {
            if (typeof limits.likesPerSession === 'string' && limits.likesPerSession.includes('-')) {
                const [min, max] = limits.likesPerSession.split('-').map(Number);
                sessionLikesTarget = Math.floor(Math.random() * (max - min + 1)) + min;
            } else {
                sessionLikesTarget = Number(limits.likesPerSession);
            }
        }
        const sessionLimits = { ...limits, likesPerSession: sessionLikesTarget, likesPerDay };
        accountLogger.info(`Session interaction target: ${sessionLikesTarget} actions.`);

        const msToNextLike = (behavior.enableLikes !== false) ? activityTracker.getTimeUntilAvailable('likes', limits.likesPerHour) : 0;
        const msToNextComment = (behavior.enableComments !== false) ? activityTracker.getTimeUntilAvailable('comments', limits.commentsPerHour) : 0;
        const msToNextDM = (behavior.enableAutoDMs === true) ? activityTracker.getTimeUntilAvailable('dms', limits.dmsPerHour || 10) : 0; // Safe default 10/hr

        let isBlocked = true;
        let maxWaitTime = 0;

        if (isDMOnlyRun) {
            isBlocked = (behavior.enableAutoDMs === true && msToNextDM > 0);
        } else {
            // Check if at least ONE enabled action is available
            if (behavior.enableLikes !== false && msToNextLike === 0 && !likeCapReached) isBlocked = false;
            if (behavior.enableComments !== false && msToNextComment === 0) isBlocked = false;
            if (behavior.enableAutoDMs === true && msToNextDM === 0) isBlocked = false;
        }

        if (isBlocked) {
            if (isDMOnlyRun) {
                const dmWait = Math.ceil(msToNextDM / 60000);
                accountLogger.warn(`DM-only check skipped: Auto DM is on rate limit cooldown. Waiting ~${dmWait}m.`);
            } else {
                const waits = [];
                if (behavior.enableLikes !== false && !likeCapReached) waits.push(msToNextLike);
                if (behavior.enableComments !== false) waits.push(msToNextComment);
                if (behavior.enableAutoDMs === true) waits.push(msToNextDM);

                maxWaitTime = waits.length > 0 ? Math.min(...waits) : 0;

                const waitMinutes = Math.ceil(maxWaitTime / 60000);
                const dmWait = Math.ceil(msToNextDM / 60000);
                const likeWait = Math.ceil(msToNextLike / 60000);

                accountLogger.warn(`All enabled actions are on cooldown. Waiting ~${waitMinutes}m. (Likes: ${likeWait}m, DMs: ${dmWait}m)`);
            }

            // Critical: If blocked, ensure we close the session to save RAM
            const existingClient = activeSessions.get(account.id);
            if (existingClient) {
                await existingClient.close();
                activeSessions.delete(account.id);
                accountLogger.info("Closed persistent session due to rate limits.");
            }
            return;
        }

        // --- REUSE OR CREATE CLIENT AND RUN INTERACTION ---
        try {
            const runSession = async () => {
                const sessionStart = Date.now();
                let igClient = activeSessions.get(account.id);

                // If client exists but disconnected, clear it
                if (igClient && !igClient.isConnected()) {
                    activeSessions.delete(account.id);
                    igClient = undefined;
                }

                if (!igClient) {
                    const headlessMode = account.settings?.headless !== undefined
                        ? !!account.settings.headless
                        : (process.env.HEADLESS !== undefined
                            ? process.env.HEADLESS === 'true'
                            : isDMOnlyRun);

                    // Initialize New Client
                    igClient = createIgClient(account, { headless: headlessMode, character, logger: accountLogger, emailService });

                    activeSessions.set(account.id, igClient);
                } else {
                    accountLogger.info("Reusing active browser session.");
                }

                try {
                    await igClient.init(); // Idempotent now

                    accountLogger.info(`Interacting with behavior: Like=${behavior.enableLikes}, Comment=${behavior.enableComments}`);
                    accountLogger.info(`Safety Limits applied: MaxLikes=${limits.likesPerHour}, MaxComments=${limits.commentsPerHour}`);

                    const hashtags = account.settings?.hashtags || [];
                    const hashtagMix = account.settings?.hashtagMix !== undefined ? account.settings.hashtagMix : 0.5; // Default 50/50

                    // Check for Auto DMs if enabled in settings
                    if (behavior.enableAutoDMs) {
                        // Keep the dashboard inbox fresh; sync first so unread state is captured before the bot opens threads
                        await syncInboxQuietly(igClient, account.id, accountLogger);
                        accountLogger.info("Checking for DMs (enabled in settings)...");
                        await igClient.checkAndRespondToDMs({ dmsPerHour: limits.dmsPerHour });
                        if (igClient.dmsProcessedThisSession) await syncInboxQuietly(igClient, account.id, accountLogger);
                    }

                    // Logic: If hashtags exist, use 'hashtagMix' probability to choose Hashtags.
                    let actionsCompleted = 0;
                    if (!isDMOnlyRun) {
                        const useHashtags = hashtags.length > 0 && Math.random() < hashtagMix;

                        if (useHashtags) {
                            accountLogger.info(`Chosen Strategy: HASHTAG interaction (Probability: ${hashtagMix}, Tags: ${hashtags.length})`);
                            actionsCompleted = await igClient.interactWithHashtags(hashtags, { behavior, limits: sessionLimits });

                            if (actionsCompleted === 0) {
                                accountLogger.warn("Hashtag interaction completed with 0 actions. Attempting fallback FEED strategy...");
                                actionsCompleted = await igClient.interactWithPosts({ behavior, limits: sessionLimits });
                            }
                        } else {
                            accountLogger.info(`Chosen Strategy: FEED interaction (Probability: ${1 - (hashtags.length > 0 ? hashtagMix : 0)})`);
                            actionsCompleted = await igClient.interactWithPosts({ behavior, limits: sessionLimits });
                        }
                    }

                    // Store actionsCompleted on the client instance so the finally block can access it
                    (igClient as any).actionsCompletedThisSession = actionsCompleted;

                } catch (err) {
                    throw err;
                } finally {
                    // ALWAYS CLOSE after session finishes to save RAM
                    const existingClient = activeSessions.get(account.id);
                    let actionsCompleted = 0;
                    let dmsProcessed = false;
                    if (existingClient) {
                        actionsCompleted = (existingClient as any).actionsCompletedThisSession || 0;
                        dmsProcessed = (existingClient as any).dmsProcessedThisSession || false;
                        accountLogger.info(`Closing session for ${account.id} before rest period.`);
                        await existingClient.close();
                        activeSessions.delete(account.id);
                    }

                    // Statistics: DM-only checks run every few minutes, so only full sessions count as sessions
                    recordStat(trackerId, 'activeMinutes', Math.round((Date.now() - sessionStart) / 6000) / 10);
                    if (!isDMOnlyRun) {
                        recordStat(trackerId, 'sessions');
                        if (actionsCompleted === 0) recordStat(trackerId, 'emptySessions');
                    }

                    // Update the Rest/DM Cycles
                    if (isDMOnlyRun) {
                        const nextCheckMinutes = dmsProcessed ? 1 : (account.settings?.schedule?.dmCheckIntervalMinutes || 2);
                        const dmIntervalMs = (account.settings?.schedule?.dmCheckIntervalMinutes || 2) * 60 * 1000;
                        scheduleTracker.setLastDMCheckTime(Date.now() + (nextCheckMinutes * 60000) - dmIntervalMs);
                        accountLogger.info(`DM-only check completed. Next DM check available in ~${nextCheckMinutes} minutes.`);
                    } else {
                        // Update the Rest Cycle
                        let restDelayMs;
                        const emptySessions = scheduleTracker.recordSessionResult(actionsCompleted);
                        if (actionsCompleted === 0) {
                            // Escalate retries so a broken page doesn't cause constant reloads all day
                            const retryMinutes = [5, 15, 30, 60][Math.min(emptySessions, 4) - 1];
                            accountLogger.warn(`Performed 0 interactions in this session (${emptySessions} in a row). Scheduling a retry in ${retryMinutes} minutes instead of a full rest cycle.`);
                            restDelayMs = retryMinutes * 60 * 1000;
                        } else {
                            restDelayMs = ScheduleTracker.getRandomDelayMs(scheduleSettings.minRestMinutes, scheduleSettings.maxRestMinutes);
                        }
                        scheduleTracker.setNextActiveTime(Date.now() + restDelayMs);
                        accountLogger.info(`Account rests. Next active cycle set in ~${Math.round(restDelayMs / 60000)} minutes.`);
                    }

                    accountLogger.info(`<<< Session finished for account: ${account.id} >>>`);
                }
            };

            // Lock order is always account lock -> interaction slot -> session slot to avoid deadlocks
            if (isDMOnlyRun) {
                await withAccountLock(account.id, () => sessionLimit(runSession));
            } else {
                await withAccountLock(account.id, () => interactionLimit(async () => {
                    await sessionLimit(runSession);
                }));
            }
        } catch (err) {
            throw err;
        }

    } catch (error: any) {
        accountLogger.error(`Error processing account ${account.id}: ${error}`);
        const statsId = account.userDataDir ? path.basename(account.userDataDir) : account.username;
        recordStat(statsId, 'errors');
        if (emailService) {
            emailService.sendErrorAlert(account.username, error.message || String(error), "Account Processing Crash").catch(() => { });
        }
    }
};
