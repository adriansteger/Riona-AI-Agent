import express, { Application } from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import helmet from "helmet"; // For securing HTTP headers
import cors from "cors";
import session from 'express-session';

import logger, { setupErrorHandlers } from "./config/logger";
import { setup_HandleError, ActivityTracker } from "./utils";
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

// Define runInstagram
const runInstagram = async () => {
  logger.info("Starting Multi-Account Instagram Bot...");

  // Force cast accountConfig to any to avoid strict type checking issues with JSON import if not enabled
  // Force cast accountConfig to any to avoid strict type checking issues with JSON import if not enabled
  const accounts: any[] = accountConfig;
  const enabledAccounts = accounts.filter(a => a.enabled);

  if (enabledAccounts.length === 0) {
    logger.info("No enabled Instagram accounts found. Skipping Instagram Bot.");
    return;
  }

  logger.info(`Found ${enabledAccounts.length} enabled Instagram accounts: ${enabledAccounts.map(a => a.id).join(', ')}`);

  for (const account of enabledAccounts) {

    const accountLogger = createAccountLogger(account.id);
    accountLogger.info(`>>> Starting session for account: ${account.id} (${account.username}) <<<`);

    try {
      // Load specific character for this account
      const character = chooseCharacter(account.character);
      accountLogger.info(`Loaded character: ${character?.aiPersona?.name || "Default/Unknown"}`);

      // --- SETTINGS MERGE (Moved up for pre-check) ---
      // 1. Get defaults from Character (or hard defaults)
      const characterBehavior = character?.settings?.behavior || character?.behavior || { enableLikes: true, enableComments: true };
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

      // If a feature is disabled, we consider it "ready" (time=0) effectively, but we need to check if *enabled* features are blocked.
      // Logic: If I want to like, and I can't... wait. If I want to comment, and I can't... wait.
      // If ALL enabled features are blocked, we skip.

      let isBlocked = false;
      let maxWaitTime = 0;

      if (behavior.enableLikes !== false && msToNextLike > 0) {
        if (behavior.enableComments === false || msToNextComment > 0) {
          // Likes blocked, and comments either disabled or blocked -> BLOCKED
          isBlocked = true;
          maxWaitTime = Math.max(msToNextLike, msToNextComment);
        }
      } else if (behavior.enableComments !== false && msToNextComment > 0) {
        if (behavior.enableLikes === false || msToNextLike > 0) {
          // Comments blocked, and likes either disabled or blocked -> BLOCKED
          isBlocked = true;
          maxWaitTime = Math.max(msToNextLike, msToNextComment);
        }
      }

      if (isBlocked) {
        const waitMinutes = Math.ceil(maxWaitTime / 60000);
        accountLogger.warn(`Limits reached. Next action possible in ~${waitMinutes} minutes. Skipping this session.`);
        continue;
      }

      // Initialize Client with account config and isolated logger
      const igClient = new IgClient({
        username: account.username,
        password: account.password,
        userDataDir: account.userDataDir,
        proxy: account.proxy
      }, accountLogger);

      await igClient.init();

      accountLogger.info(`Interacting with behavior: Like=${behavior.enableLikes}, Comment=${behavior.enableComments}`);
      accountLogger.info(`Safety Limits applied: MaxLikes=${limits.likesPerHour}, MaxComments=${limits.commentsPerHour}`);

      const hashtags = account.settings?.hashtags || [];
      const hashtagMix = account.settings?.hashtagMix !== undefined ? account.settings.hashtagMix : 0.5; // Default 50/50

      // Logic: If hashtags exist, use 'hashtagMix' probability to choose Hashtags.
      const useHashtags = hashtags.length > 0 && Math.random() < hashtagMix;

      if (useHashtags) {
        accountLogger.info(`Chosen Strategy: HASHTAG interaction (Probability: ${hashtagMix}, Tags: ${hashtags.length})`);
        await igClient.interactWithHashtags(hashtags, { behavior, limits });
      } else {
        accountLogger.info(`Chosen Strategy: FEED interaction (Probability: ${1 - (hashtags.length > 0 ? hashtagMix : 0)})`);
        await igClient.interactWithPosts({ behavior, limits });
      }

      await igClient.close();
      accountLogger.info(`<<< Session finished for account: ${account.id} >>>`);

    } catch (error) {
      accountLogger.error(`Error processing account ${account.id}: ${error}`);
    }

    // Delay between accounts
    const switchDelay = 10000;
    logger.info(`Waiting ${switchDelay / 1000}s before next account...`);
    await new Promise(r => setTimeout(r, switchDelay));
  }
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
  logger.info("Starting Job Search Bot (Env/API Config)...");

  // Email Config from Env
  const emailConfig = {
    host: process.env.EMAIL_HOST || '',
    port: parseInt(process.env.EMAIL_PORT || '465'),
    secure: process.env.EMAIL_SECURE === 'true',
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    to: '', // Will be set dynamically by JobClient -> checkUserPreferences
  };

  if (!emailConfig.user || !emailConfig.pass) {
    logger.warn("Missing EMAIL_USER or EMAIL_PASS in .env. Skipping Job Bot.");
    return;
  }

  try {
    const emailService = new EmailService(emailConfig);

    // Default config (will be overridden by ResuMate API)
    const defaultJobConfig = {
      keywords: [],
      location: 'Remote',
      platforms: ['indeed', 'ziprecruiter', 'weworkremotely']
    };

    const client = new JobClient(emailService, defaultJobConfig);

    await client.init();
    await client.runSearch();
    await client.close();

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
