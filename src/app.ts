import express, { Application } from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import helmet from "helmet"; // For securing HTTP headers
import cors from "cors";
import session from 'express-session';

import logger, { setupErrorHandlers } from "./config/logger";
import { setup_HandleError, ActivityTracker, pLimit } from "./utils";
import path from 'path';
import { connectDB } from "./config/db";
import apiRoutes from "./routes/api";
import { getIgClient } from "./client/Instagram"; // Import getIgClient
import { IGusername, IGpassword } from "./secret"; // Import credentials
// import { main as twitterMain } from './client/Twitter'; //
// import { main as githubMain } from './client/GitHub'; //
import { IgClient } from "./client/IG-bot/IgClient";
import accountConfig from "./config/accounts.json";
import { createAccountLogger } from "./config/logger";
import { chooseCharacter } from "./Agent";
import jobConfig from "./config/job_accounts.json";

import { JobClient } from "./client/JobBot/JobClient";
import { EmailService } from "./services/EmailService";

// Set up process-level error handlers
setupErrorHandlers();

// Initialize environment variables
dotenv.config();

// Initialize Express app
const app: Application = express();

// Connect to the database
connectDB();

// Middleware setup
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(cors());
app.use(express.json()); // JSON body parsing
app.use(express.urlencoded({ extended: true, limit: "1kb" })); // URL-encoded data
app.use(cookieParser()); // Cookie parsing
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 2 * 60 * 60 * 1000, sameSite: 'lax' },
}));

import fs from 'fs';

// Serve static files from the 'public' directory
const frontendPath = path.join(__dirname, '../frontend/dist');
const frontendExists = fs.existsSync(frontendPath);

if (frontendExists) {
  app.use(express.static(frontendPath));
}

// API Routes
app.use('/api', apiRoutes);

app.get('*', (_req, res) => {
  if (frontendExists && fs.existsSync(path.join(frontendPath, 'index.html'))) {
    res.sendFile('index.html', { root: frontendPath });
  } else {
    res.status(200).json({ status: 'API is running', message: 'Frontend not found/built' });
  }
});

// Registry for active persistent sessions
const activeSessions = new Map<string, IgClient>();

const processAccount = async (account: any, emailService?: EmailService) => {
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

    // --- PRE-RUN AVAILABILITY CHECK ---
    const trackerId = account.userDataDir ? path.basename(account.userDataDir) : account.username;
    const activityTracker = new ActivityTracker(trackerId);

    const msToNextLike = (behavior.enableLikes !== false) ? activityTracker.getTimeUntilAvailable('likes', limits.likesPerHour) : 0;
    const msToNextComment = (behavior.enableComments !== false) ? activityTracker.getTimeUntilAvailable('comments', limits.commentsPerHour) : 0;
    const msToNextDM = (behavior.enableAutoDMs === true) ? activityTracker.getTimeUntilAvailable('dms', limits.dmsPerHour || 20) : 0; // Increased default to 20

    let isBlocked = true;
    let maxWaitTime = 0;

    // Check if at least ONE enabled action is available
    if (behavior.enableLikes !== false && msToNextLike === 0) isBlocked = false;
    if (behavior.enableComments !== false && msToNextComment === 0) isBlocked = false;
    if (behavior.enableAutoDMs === true && msToNextDM === 0) isBlocked = false;

    if (isBlocked) {
      const waits = [];
      if (behavior.enableLikes !== false) waits.push(msToNextLike);
      if (behavior.enableComments !== false) waits.push(msToNextComment);
      if (behavior.enableAutoDMs === true) waits.push(msToNextDM);

      maxWaitTime = waits.length > 0 ? Math.min(...waits) : 0;

      const waitMinutes = Math.ceil(maxWaitTime / 60000);
      const dmWait = Math.ceil(msToNextDM / 60000);
      const likeWait = Math.ceil(msToNextLike / 60000);

      accountLogger.warn(`All enabled actions are on cooldown. Waiting ~${waitMinutes}m. (Likes: ${likeWait}m, DMs: ${dmWait}m)`);

      // Critical: If blocked, ensure we close the session to save RAM
      const existingClient = activeSessions.get(account.id);
      if (existingClient) {
        await existingClient.close();
        activeSessions.delete(account.id);
        accountLogger.info("Closed persistent session due to rate limits.");
      }
      return;
    }

    // --- REUSE OR CREATE CLIENT ---
    let igClient = activeSessions.get(account.id);

    // If client exists but disconnected, clear it
    if (igClient && !igClient.isConnected()) {
      activeSessions.delete(account.id);
      igClient = undefined;
    }

    if (!igClient) {
      // Initialize New Client
      igClient = new IgClient({
        username: account.username,
        password: account.password,
        userDataDir: account.userDataDir,
        proxy: account.proxy,
        languages: account.settings?.languages,
        defaultLanguage: account.settings?.defaultLanguage
      }, accountLogger, character, emailService);

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
        accountLogger.info("Checking for DMs (enabled in settings)...");
        await igClient.checkAndRespondToDMs({ dmsPerHour: limits.dmsPerHour });
      }

      // Logic: If hashtags exist, use 'hashtagMix' probability to choose Hashtags.
      const useHashtags = hashtags.length > 0 && Math.random() < hashtagMix;

      if (useHashtags) {
        accountLogger.info(`Chosen Strategy: HASHTAG interaction (Probability: ${hashtagMix}, Tags: ${hashtags.length})`);
        await igClient.interactWithHashtags(hashtags, { behavior, limits });
      } else {
        accountLogger.info(`Chosen Strategy: FEED interaction (Probability: ${1 - (hashtags.length > 0 ? hashtagMix : 0)})`);
        await igClient.interactWithPosts({ behavior, limits });
      }
    } catch (err) {
      throw err; // Re-throw to be caught by outer catch for logging
    } finally {
      // SMART CLOSE: Only close if limits are now reached
      const nextLike = (behavior.enableLikes !== false) ? activityTracker.getTimeUntilAvailable('likes', limits.likesPerHour) : 0;
      const nextComment = (behavior.enableComments !== false) ? activityTracker.getTimeUntilAvailable('comments', limits.commentsPerHour) : 0;

      let limitsReachedNow = false;
      if (behavior.enableLikes !== false && nextLike > 0) {
        if (behavior.enableComments === false || nextComment > 0) limitsReachedNow = true;
      } else if (behavior.enableComments !== false && nextComment > 0) {
        if (behavior.enableLikes === false || nextLike > 0) limitsReachedNow = true;
      }

      const maxSessions = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '5');
      // DEBUG: Log the decision factors
      accountLogger.info(`[SESSION DEBUG] LimitsReached=${limitsReachedNow}, ActiveSessions=${activeSessions.size}, MaxSessions=${maxSessions}`);

      const shouldClose = limitsReachedNow && activeSessions.size >= maxSessions;

      if (shouldClose) {
        accountLogger.info(`[SESSION DEBUG] Decision: CLOSE. (Limits Reached & Slots Full: ${activeSessions.size} >= ${maxSessions})`);
        await igClient.close();
        activeSessions.delete(account.id);
      } else {
        if (limitsReachedNow) {
          accountLogger.info(`[SESSION DEBUG] Decision: KEEP OPEN. (Limits Reached but Slots Available: ${activeSessions.size} < ${maxSessions})`);
        } else {
          accountLogger.info("[SESSION DEBUG] Decision: KEEP OPEN. (Limits Not Reached)");
        }
      }

      accountLogger.info(`<<< Session finished for account: ${account.id} >>>`);
    }

  } catch (error: any) {
    accountLogger.error(`Error processing account ${account.id}: ${error}`);
    if (emailService) {
      // Use the passed emailService (which is the GLOBAL alert service if configured)
      emailService.sendErrorAlert(account.username, error.message || String(error), "Account Processing Crash").catch(() => { });
    }
  }
};

// Define runInstagram
const runInstagram = async () => {
  logger.info("Starting Multi-Account Instagram Bot...");

  // Force cast accountConfig to any to avoid strict type checking issues with JSON import if not enabled
  const accounts: any[] = accountConfig;
  const enabledAccounts = accounts.filter(a => a.enabled);

  if (enabledAccounts.length === 0) {
    logger.info("No enabled Instagram accounts found. Skipping Instagram Bot.");
    return;
  }

  logger.info(`Found ${enabledAccounts.length} enabled Instagram accounts: ${enabledAccounts.map(a => a.id).join(', ')}`);

  // Initialize Global Email Service for Alerts
  let alertEmailService: EmailService | undefined;

  // Check for specific IG_ALERT credentials first, then fallback to generic EMAIL credentials
  const mailUser = process.env.IG_ALERT_EMAIL_USER || process.env.EMAIL_USER;
  const mailPass = process.env.IG_ALERT_EMAIL_PASS || process.env.EMAIL_PASS;
  const mailHost = process.env.IG_ALERT_EMAIL_HOST || process.env.EMAIL_HOST;
  const mailPort = process.env.IG_ALERT_EMAIL_PORT || process.env.EMAIL_PORT || '465';
  const mailSecure = process.env.IG_ALERT_EMAIL_SECURE || process.env.EMAIL_SECURE || 'true';
  const mailFrom = process.env.IG_ALERT_EMAIL_FROM || process.env.EMAIL_FROM;
  const mailService = process.env.IG_ALERT_EMAIL_SERVICE || process.env.EMAIL_SERVICE;
  const mailTo = process.env.IG_ALERT_EMAIL_TO || process.env.EMAIL_ALERTS_TO || mailUser;

  if (mailUser && mailPass) {
    alertEmailService = new EmailService({
      host: mailHost,
      port: parseInt(mailPort),
      secure: mailSecure === 'true',
      user: mailUser,
      pass: mailPass,
      to: mailTo!,
      from: mailFrom,
      service: mailService
    });
    logger.info(`Global Email Alert System initialized (Sender: ${mailFrom || mailUser}, Config: ${mailHost || mailService})`);
  } else {
    logger.warn("Email alert system skipped (Missing Credentials). CAPTCHA alerts will not be sent.");
  }

  // Configurable Concurrency
  // Default to 5 if not set
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '5', 10);
  logger.info(`Running with MAX_CONCURRENT_SESSIONS: ${maxConcurrent}`);

  const limit = pLimit(maxConcurrent);

  // Create promises for all enabled accounts
  const promises = enabledAccounts.map(account => limit(() => processAccount(account, alertEmailService)));

  // Wait for all to finish
  await Promise.all(promises);

  logger.info("All accounts processed.");
};

const runAgents = async () => {
  while (true) {
    logger.info("Starting Instagram agent iteration...");
    await runInstagram();
    logger.info("Instagram agent iteration finished.");

    // logger.info("Starting Twitter agent...");
    // await twitterMain();
    // logger.info("Twitter agent finished.");

    // logger.info("Starting GitHub agent...");
    // await githubMain();
    // logger.info("GitHub agent finished.");

    logger.info("Starting Job Bot...");
    await runJobBot();
    logger.info("Job Bot finished.");

    // Wait for 30 seconds before next iteration
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
};

const runJobBot = async () => {
  // Check if Job Bot is enabled in config
  // We assume the first bot config controls the master switch for now, or check any enabled
  const isEnabled = (jobConfig as any).jobBots?.some((bot: any) => bot.enabled);

  if (!isEnabled) {
    logger.info("Job Bot is disabled in job_accounts.json. Skipping.");
    return;
  }

  logger.info("Starting Job Search Bot (Env/API Config)...");

  // Email Config from Env
  const emailConfig = {
    host: process.env.EMAIL_HOST || '',
    port: parseInt(process.env.EMAIL_PORT || '465'),
    secure: process.env.EMAIL_SECURE === 'true',
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    to: '', // Will be set dynamically by JobClient -> checkUserPreferences
    from: process.env.EMAIL_FROM,
    service: process.env.EMAIL_SERVICE
  };

  if (!emailConfig.user || !emailConfig.pass) {
    logger.warn("Missing EMAIL_USER or EMAIL_PASS in .env. Skipping Job Bot.");
    return;
  }

  try {
    const emailService = new EmailService(emailConfig);

    // Default config (will be overridden by ResuMate API)
    // Use platforms defined in job_accounts.json (first bot)
    const platforms = jobConfig.jobBots?.[0]?.preferences?.platforms || ['indeed', 'ziprecruiter', 'weworkremotely'];

    const defaultJobConfig = {
      keywords: [],
      location: 'Remote',
      platforms: platforms
    };

    const client = new JobClient(emailService, defaultJobConfig);

    await client.init();
    await client.runSearch();
    // await client.close(); // Keep browser open per user request for persistence

  } catch (error) {
    logger.error(`Error in Job Bot: ${error}`);
  }
};

runAgents().catch((error) => {
  setup_HandleError(error, "Error running agents:");
});

// Error handling
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
