import * as puppeteer from 'puppeteer';
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import UserAgent from "user-agents";
import { Server } from "proxy-chain";
import { IGpassword, IGusername } from "../../secret";
import logger from "../../config/logger";
import { Instagram_cookiesExist, loadCookies, saveCookies, ActivityTracker } from "../../utils";
import { runAgent } from "../../Agent";
import path from "path";
import { getInstagramCommentSchema } from "../../Agent/schema";
import readline from "readline";
import fs from "fs/promises";
import { getShouldExitInteractions } from '../../api/agent';

// Add stealth plugin to puppeteer
puppeteerExtra.use(StealthPlugin());
// puppeteerExtra.use(
//     AdblockerPlugin({
//         // Optionally enable Cooperative Mode for several request interceptors
//         interceptResolutionPriority: puppeteer.DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
//     })
// );

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class IgClient {
    private browser: puppeteer.Browser | null = null;
    private page: puppeteer.Page | null = null;
    private username: string;
    private password: string;
    private userDataDir?: string;
    private proxy?: string;
    private logger: any; // Using any or specific Logger type if available

    constructor(
        config: { username?: string; password?: string; userDataDir?: string; proxy?: string },
        loggerInstance?: any
    ) {
        this.username = config.username || '';
        this.password = config.password || '';
        this.userDataDir = config.userDataDir;
        this.proxy = config.proxy;
        this.logger = loggerInstance || logger;
    }

    async init() {
        // Center the window on a 1920x1080 screen
        const width = 1280;
        const height = 800;
        const screenWidth = 1920;
        const screenHeight = 1080;
        const left = Math.floor((screenWidth - width) / 2);
        const top = Math.floor((screenHeight - height) / 2);

        const launchArgs = [
            `--window-size=${width},${height}`,
            `--window-position=${left},${top}`,
            // Stability flags (Optimized for Windows)
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            // Removed Linux-specific/aggressive flags that might cause startup failure
            '--mute-audio' // Good practice
        ];

        if (this.proxy) {
            launchArgs.push(`--proxy-server=${this.proxy}`);
        }

        const launchOptions: any = {
            headless: false,
            args: launchArgs,
            defaultViewport: null, // Ensure viewport matches window
        };

        if (this.userDataDir) {
            // Resolve to absolute path to avoid Puppeteer issues
            const absoluteUserDataDir = path.resolve(process.cwd(), this.userDataDir);
            launchOptions.userDataDir = absoluteUserDataDir;
            // Ensure directory exists
            await fs.mkdir(absoluteUserDataDir, { recursive: true }).catch(() => { });
        }

        this.logger.info(`Launching browser with options: ${JSON.stringify({ ...launchOptions, args: launchOptions.args.map((a: string) => a.startsWith('--proxy-server') ? '--proxy-server=REDACTED' : a) }, null, 2)}`);

        let attempt = 0;
        const maxAttempts = 3;
        while (attempt < maxAttempts) {
            try {
                this.browser = await puppeteerExtra.launch(launchOptions);
                // Move newPage inside the try block to catch "Requesting main frame too early" errors
                this.page = await this.browser.newPage();
                break; // Success
            } catch (err) {
                attempt++;
                this.logger.error(`Failed to launch browser or open page (attempt ${attempt}/${maxAttempts}): ${err}`);

                // Ensure browser is closed if it opened but page failed
                if (this.browser) {
                    await this.browser.close().catch(() => { });
                    this.browser = null;
                }

                if (attempt >= maxAttempts) throw err;

                this.logger.info("Waiting 5 seconds before retrying...");

                // FORCE CLEANUP: Try to remove "SingletonLock" if it exists
                if (this.userDataDir) {
                    try {
                        const lockPath = path.join(path.resolve(process.cwd(), this.userDataDir), 'SingletonLock');
                        await fs.unlink(lockPath);
                        this.logger.warn(`Deleted stale lock file during retry: ${lockPath}`);
                    } catch (e) {
                        // Include ignoring of error where file is missing
                    }
                }

                await delay(5000); // Pasue before retry
            }
        }

        if (!this.browser || !this.page) throw new Error("Browser/Page failed to initialize after multiple attempts.");

        // Authenticate proxy if credentials are in the URL
        if (this.proxy) {
            try {
                const proxyUrl = new URL(this.proxy);
                if (proxyUrl.username && proxyUrl.password) {
                    await this.page.authenticate({
                        username: proxyUrl.username,
                        password: proxyUrl.password,
                    });
                }
            } catch (e) {
                this.logger.warn(`Failed to parse/authenticate proxy URL: ${this.proxy}`);
            }
        }

        const userAgent = new UserAgent({ deviceCategory: "desktop" });
        await this.page.setUserAgent(userAgent.toString());
        await this.page.setViewport({ width, height });

        if (await Instagram_cookiesExist() && !this.userDataDir) {
            // If manual cookies and no strict profile isolation
            await this.loginWithCookies();
        } else if (this.userDataDir) {
            // With persistent profile, cookies are auto-loaded. Just check login state.
            try {
                await this.page.goto("https://www.instagram.com/", { waitUntil: "networkidle2" });
            } catch (navErr) {
                this.logger.warn(`Initial navigation failed (${navErr}), Retrying...`);
                try {
                    if (this.page.isClosed()) this.page = await this.browser.newPage();
                    await this.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
                } catch (retryErr) {
                    throw new Error(`Critical: Failed to navigate to Instagram: ${retryErr}`);
                }
            }
            await delay(2000); // Give it a moment to render
            const currentUrl = this.page.url();
            this.logger.info(`Current URL after navigation: ${currentUrl}`);

            // Check if login fields are present
            const isLoginFieldPresent = await this.page.$('input[name="username"]') !== null;

            // Check for "Log In" button or link if inputs are missing (e.g. landing page)
            const isLoginLinkPresent = await this.page.$('a[href*="/accounts/login"]') !== null;
            const isLoginButtonPresent = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.some(b => b.innerText?.toLowerCase().includes('log in') || b.innerText?.toLowerCase().includes('log on'));
            });

            // "Positive" check: Do we see the Feed or Nav?
            const isNavPresent = await this.page.$('svg[aria-label="Home"], svg[aria-label="Instagram"]') !== null;

            this.logger.info(`Session Check: URL=${currentUrl}, Inputs=${isLoginFieldPresent}, Link=${isLoginLinkPresent}, Button=${isLoginButtonPresent}, Nav=${isNavPresent}`);

            if (currentUrl.includes("/login/") || isLoginFieldPresent || isLoginLinkPresent || isLoginButtonPresent || !isNavPresent) {
                this.logger.info("Session expired or new profile. Logging in with credentials...");
                await this.loginWithCredentials();
            } else {
                this.logger.info("Restored session from profile (Login fields not found). Checking for interruptions...");

                // Handle Cookie Wall / "Save Info" / "Notifications" even if we think we are logged in
                // Wrap in try-catch to avoid "Execution context destroyed" if page reloads
                try {
                    await this.handleCookieConsent();
                    await this.handleNotificationPopup();
                } catch (e) { this.logger.warn(`Ignored error during popup check: ${e}`); }

                try {
                    await this.handleAutomatedBehaviorWarning(); // Check for "Automated Behavior" warning
                } catch (e) { this.logger.warn(`Ignored error during warning check: ${e}`); }

                // Check for "Not Now" button (e.g. Save Info, Try New Look, etc.)
                try {
                    const notNowButton = await this.page.evaluateHandle(() => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        return buttons.find(b => b.textContent === 'Not Now') || null;
                    });
                    const notNowButtonHandle = notNowButton.asElement();
                    if (notNowButtonHandle) {
                        this.logger.info("Found 'Not Now' button on restored session. Clicking...");
                        await notNowButtonHandle.evaluate((b: any) => b.click());
                        await delay(2000);
                    }
                } catch (e) {
                    this.logger.warn(`Ignored error during 'Not Now' check (possible frame detach): ${e}`);
                }

                await this.page.screenshot({ path: 'logs/debug_session_restored.png' });
            }
        } else {
            await this.loginWithCredentials();
        }
    }

    private async loginWithCookies() {
        if (!this.page) throw new Error("Page not initialized");
        const cookies = await loadCookies("./cookies/Instagramcookies.json");
        if (cookies.length > 0) {
            await this.page.setCookie(...cookies);
        }

        logger.info("Loaded cookies. Navigating to Instagram home page.");
        await this.page.goto("https://www.instagram.com/", {
            waitUntil: "networkidle2",
        });
        const url = this.page.url();
        if (url.includes("/login/")) {
            logger.warn("Cookies are invalid or expired. Falling back to credentials login.");
            await this.loginWithCredentials();
        } else {
            logger.info("Successfully logged in with cookies.");
        }
    }

    private async loginWithCredentials(skipNavigation: boolean = false) {
        if (!this.page || !this.browser) throw new Error("Browser/Page not initialized");
        logger.info("Logging in with credentials...");

        if (!skipNavigation) {
            await this.page.goto("https://www.instagram.com/accounts/login/", {
                waitUntil: "networkidle2",
            });
        } else {
            logger.info("Skipping navigation as inputs are already present.");
        }

        await this.handleCookieConsent(); // New handler
        await this.handleAutomatedBehaviorWarning();

        // ROBUST INPUT FINDING STRATEGY
        try {
            // Strategy 1: Standard Name
            await this.page.waitForSelector('input[name="username"]', { timeout: 10000 });
        } catch (e) {
            logger.warn("Standard input[name='username'] not found. Trying alternatives...");

            // Strategy 2: Focus Search
            const inputFound = await this.page.evaluate(() => {
                const inputs = Array.from(document.querySelectorAll('input'));
                const textLikeInputs = inputs.filter(i => i.type === 'text' || i.type === 'email' || i.type === 'tel');

                // Try to match 'user', 'email', 'phone' in name or aria-label
                const likelyUsername = textLikeInputs.find(i =>
                    i.name.includes('user') ||
                    i.name.includes('email') ||
                    (i.getAttribute('aria-label') || '').toLowerCase().includes('user') ||
                    (i.getAttribute('aria-label') || '').toLowerCase().includes('email')
                );

                if (likelyUsername) {
                    likelyUsername.focus();
                    return true;
                }
                if (textLikeInputs[0]) {
                    textLikeInputs[0].focus();
                    return true;
                }
                return false;
            });

            if (!inputFound) throw new Error("Could not find any suitable login input field via Strategy 2.");
        }

        // At this point, focus should be on the field, or the standard selector worked.
        const usernameSelector = await this.page.$('input[name="username"]');
        if (usernameSelector) {
            await this.page.type('input[name="username"]', this.username);
            await this.page.type('input[name="password"]', this.password);
        } else {
            // Fallback: Type blindly into focused element
            logger.info("Typing username into active element focus...");
            await delay(1000); // Wait for focus to settle
            try {
                await this.page.keyboard.type(this.username, { delay: 50 }); // Add typing delay
                await this.page.keyboard.press('Tab'); // Move to password
                await delay(1000);
                await this.page.keyboard.type(this.password, { delay: 50 });
            } catch (e: any) {
                // If typing fails (TargetClosed), it often means page reloaded. 
                // We should stop here, but let's log specifically.
                throw new Error(`Typing crashed (TargetCloseError?): ${e.message}`);
            }
        }

        await delay(1000);

        try {
            logger.info("Attempting to submit login...");
            await Promise.all([
                this.page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => logger.warn("Navigation timeout ignored")),
                this.page.evaluate(() => {
                    // Try to finding submit button and click it
                    const submitBtn = document.querySelector('button[type="submit"]');
                    if (submitBtn) (submitBtn as HTMLElement).click();
                    else {
                        // Fallback: Press Enter on the password field
                        // We can't easily dispatch key events from inside analyze, but high-level keyboard press works outside
                    }
                }),
                this.page.keyboard.press('Enter')
            ]);
        } catch (error) {
            console.warn("Navigation warning: " + error);
        }

        // --- Verification & Popup Handling ---

        // --- Verification & Popup Handling ---

        await this.handleNotificationPopup();
        await this.handleAutomatedBehaviorWarning();

        // Handle "Save Info" page
        // Sometimes it's a "Not Now" button on the main page, not a dialog
        const notNowButton = await this.page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(b => b.textContent === 'Not Now') || null;
        });
        const notNowButtonHandle = notNowButton.asElement();
        if (notNowButtonHandle) {
            logger.info("Clicking 'Not Now' for Save Info...");
            await notNowButtonHandle.evaluate((b: any) => b.click());
            await delay(3000);
        }

        // --- STRICT SUCCESS CHECK ---
        const currentUrl = this.page.url();
        const isLogin = currentUrl.includes("/accounts/login");
        const isOneTap = currentUrl.includes("/accounts/onetap"); // "Save login info" page
        const isFeed = !isLogin && !isOneTap;

        if (isLogin) {
            // Still on login page? Maybe failed. Check for error message?
            const errorMsg = await this.page.$eval('p#slfErrorAlert', el => el.textContent).catch(() => null);
            if (errorMsg) {
                throw new Error(`Login Failed: ${errorMsg}`);
            }
            logger.warn("Still on login URL after attempt. Cookies valid?");
        } else {
            logger.info(`Login appears successful. URL: ${currentUrl}`);
        }

    }

    private async handleCookieConsent() {
        if (!this.page) return;
        this.logger.info("Checking for Cookie Consent...");
        try {
            const cookieButton = await this.page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.find(b => b.textContent?.includes('Allow all cookies') || b.textContent?.includes('Only allow essential cookies') || b.textContent?.includes('Decline optional cookies')) || null;
            });

            const cookieButtonHandle = cookieButton.asElement();
            if (cookieButtonHandle) {
                this.logger.info("Found Cookie Consent Button. Clicking...");
                await cookieButtonHandle.evaluate((b: any) => b.click());
                await delay(2000);
            } else {
                this.logger.info("No common Cookie Consent button found (or already accepted).");
            }
        } catch (e) {
            this.logger.warn("Error handling cookie consent: " + e);
        }
    }

    private async handleAutomatedBehaviorWarning() {
        if (!this.page) return;
        try {
            // Check for the specific warning text
            const warningDetected = await this.page.evaluate(() => {
                return document.body.innerText.includes('We suspect automated behavior') ||
                    document.body.innerText.includes('prevent your account from being temporarily restricted');
            });

            if (warningDetected) {
                this.logger.warn("DETECTED: 'Suspected Automated Behavior' Warning!");
                this.logger.info("Handling humanely: Simulating reading time...");

                // 1. Simulate "Reading" the warning (User stops to read)
                await delay(3000 + Math.random() * 4000);

                // 2. Find and Click Dismiss
                const dismissButton = await this.page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    return buttons.find(b => b.textContent?.includes('Dismiss')) || null;
                });

                const dismissElement = dismissButton.asElement();
                if (dismissElement) {
                    this.logger.info("Found 'Dismiss' button. Clicking...");
                    await (dismissElement as puppeteer.ElementHandle<Element>).click();

                    // 3. Post-Click "Hesitation"
                    this.logger.info("Dismissed. Pausing for safety/hesitation...");
                    await delay(2000 + Math.random() * 3000);
                } else {
                    this.logger.error("Warning detected but 'Dismiss' button NOT found.");
                }
            }
        } catch (e) {
            this.logger.warn("Error checking for automated behavior warning: " + e);
        }
    }

    async handleNotificationPopup() {
        if (!this.page) throw new Error("Page not initialized");
        console.log("Checking for notification popup...");

        try {
            // Wait for the dialog to appear, with a timeout
            const dialogSelector = 'div[role="dialog"]';
            await this.page.waitForSelector(dialogSelector, { timeout: 5000 });
            const dialog = await this.page.$(dialogSelector);

            if (dialog) {
                console.log("Notification dialog found. Searching for 'Not Now' button.");
                const notNowButtonSelectors = ["button", `div[role="button"]`];
                let notNowButton: puppeteer.ElementHandle<Element> | null = null;

                for (const selector of notNowButtonSelectors) {
                    // Search within the dialog context
                    const elements = await dialog.$$(selector);
                    for (const element of elements) {
                        try {
                            const text = await element.evaluate((el) => el.textContent);
                            if (text && text.trim().toLowerCase() === "not now") {
                                notNowButton = element as puppeteer.ElementHandle<Element>; // Cast to ElementHandle<Element>
                                console.log(`Found 'Not Now' button with selector: ${selector}`);
                                break;
                            }
                        } catch (e) {
                            // Ignore errors from stale elements
                        }
                    }
                    if (notNowButton) break;
                }

                if (notNowButton) {
                    try {
                        console.log("Dismissing 'Not Now' notification popup...");
                        // Using evaluate to click because it can be more reliable
                        const btn = notNowButton as puppeteer.ElementHandle<Element>;
                        await btn.evaluate((b) => (b as HTMLElement).click());
                        await delay(1500); // Wait for popup to close
                        console.log("'Not Now' notification popup dismissed.");
                    } catch (e) {
                        console.warn("Failed to click 'Not Now' button. It might be gone or covered.", e);
                    }
                } else {
                    console.log("'Not Now' button not found within the dialog.");
                }
            }
        } catch (error) {
            console.log("No notification popup appeared within the timeout period.");
            // If it times out, it means no popup, which is fine.
        }
    }

    async sendDirectMessage(username: string, message: string) {
        if (!this.page) throw new Error("Page not initialized");
        try {
            await this.sendDirectMessageWithMedia(username, message);
        } catch (error) {
            logger.error("Failed to send direct message", error);
            throw error;
        }
    }

    async sendDirectMessageWithMedia(username: string, message: string, mediaPath?: string) {
        if (!this.page) throw new Error("Page not initialized");
        try {
            await this.page.goto(`https://www.instagram.com/${username}/`, {
                waitUntil: "networkidle2",
            });
            console.log("Navigated to user profile");
            await delay(3000);

            const messageButtonSelectors = ['div[role="button"]', "button", 'a[href*="/direct/t/"]', 'div[role="button"] span', 'div[role="button"] div'];
            let messageButton: puppeteer.ElementHandle<Element> | null = null;
            for (const selector of messageButtonSelectors) {
                const elements = await this.page.$$(selector);
                for (const element of elements) {
                    const text = await element.evaluate((el: Element) => el.textContent);
                    if (text && text.trim() === "Message") {
                        messageButton = element;
                        break;
                    }
                }
                if (messageButton) break;
            }
            if (!messageButton) throw new Error("Message button not found.");
            await messageButton.click();
            await delay(2000); // Wait for message modal to open
            await this.handleNotificationPopup();

            if (mediaPath) {
                const fileInput = await this.page.$('input[type="file"]');
                if (fileInput) {
                    await fileInput.uploadFile(mediaPath);
                    await this.handleNotificationPopup();
                    await delay(2000); // wait for upload
                } else {
                    logger.warn("File input for media not found.");
                }
            }

            const messageInputSelectors = ['textarea[placeholder="Message..."]', 'div[role="textbox"]', 'div[contenteditable="true"]', 'textarea[aria-label="Message"]'];
            let messageInput: puppeteer.ElementHandle<Element> | null = null;
            for (const selector of messageInputSelectors) {
                messageInput = await this.page.$(selector);
                if (messageInput) break;
            }
            if (!messageInput) throw new Error("Message input not found.");
            await messageInput.type(message);
            await this.handleNotificationPopup();
            await delay(2000);

            const sendButtonSelectors = ['div[role="button"]', "button"];
            let sendButton: puppeteer.ElementHandle<Element> | null = null;
            for (const selector of sendButtonSelectors) {
                const elements = await this.page.$$(selector);
                for (const element of elements) {
                    const text = await element.evaluate((el: Element) => el.textContent);
                    if (text && text.trim() === "Send") {
                        sendButton = element;
                        break;
                    }
                }
                if (sendButton) break;
            }
            if (!sendButton) throw new Error("Send button not found.");
            await sendButton.click();
            await this.handleNotificationPopup();
            console.log("Message sent successfully");
        } catch (error) {
            logger.error(`Failed to send DM to ${username}`, error);
            throw error;
        }
    }

    async sendDirectMessagesFromFile(file: Buffer | string, message: string, mediaPath?: string) {
        if (!this.page) throw new Error("Page not initialized");
        logger.info(`Sending DMs from provided file content`);
        let fileContent: string;
        if (Buffer.isBuffer(file)) {
            fileContent = file.toString('utf-8');
        } else {
            fileContent = file;
        }
        const usernames = fileContent.split("\n");
        for (const username of usernames) {
            if (username.trim()) {
                await this.handleNotificationPopup();
                await this.sendDirectMessageWithMedia(username.trim(), message, mediaPath);
                await this.handleNotificationPopup();
                // add delay to avoid being flagged
                await delay(30000);
            }
        }
    }

    async interactWithPosts(options: {
        behavior?: { enableLikes?: boolean; enableComments?: boolean; },
        limits?: { likesPerHour?: number; commentsPerHour?: number; }
    } = {}) {
        if (!this.page) throw new Error("Page not initialized");
        const { behavior = { enableLikes: true, enableComments: true }, limits } = options;

        // Define limits (default to safe values if not provided)
        const maxLikesPerHour = limits?.likesPerHour || 10;
        const maxCommentsPerHour = limits?.commentsPerHour || 5;

        // Initialize Activity Tracker
        const accountId = this.userDataDir ? path.basename(this.userDataDir) : this.username;
        const activityTracker = new ActivityTracker(accountId);

        this.logger.info(`Starting interaction session. Hourly Limits: Likes=${maxLikesPerHour}, Comments=${maxCommentsPerHour}`);

        const page = this.page;

        // Wait for the feed to load
        try {
            console.log("Waiting for feed to load...");
            await page.waitForSelector('article', { timeout: 15000 });
            console.log("Feed loaded.");
        } catch (e) {
            console.error("Feed did not load within timeout. Taking debug screenshot.");
            await page.screenshot({ path: 'logs/debug_feed_error.png' });

            // --- DEBUG: Dump Page Content to identify what screen we are on ---
            try {
                const title = await page.title();
                const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500).replace(/\n/g, ' '));
                this.logger.error(`[DEBUG] Page Title: "${title}"`);
                this.logger.error(`[DEBUG] Page Text (First 500 chars): "${bodyText}"`);

                // Check common blockers
                const h2 = await page.$eval('h2', el => el.textContent).catch(() => null);
                if (h2) this.logger.error(`[DEBUG] Found H2 Header: "${h2}"`);

                const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => i.name));
                this.logger.error(`[DEBUG] Found Inputs: ${inputs.join(', ')}`);

            } catch (debugErr) {
                console.error("Failed to collect debug info:", debugErr);
            }
            // ----------------------------------------------------------------

            return;
        }

        // Optimization: Check limits BEFORE entering the loop to save time (skip feed wait if already blocked)
        const initialCanLike = behavior.enableLikes !== false && activityTracker.canPerformAction('likes', maxLikesPerHour);
        const initialCanComment = behavior.enableComments !== false && activityTracker.canPerformAction('comments', maxCommentsPerHour);

        if (!initialCanLike && !initialCanComment) {
            this.logger.warn("Hourly limits already reached or features disabled for BOTH actions. Skipping post interaction loop entirely.");
            return;
        }

        let postIndex = 1; // Start with the first post
        const maxPosts = 20; // Limit to prevent infinite scrolling

        while (postIndex <= maxPosts) {
            // Check for exit flag
            if (typeof getShouldExitInteractions === 'function' && getShouldExitInteractions()) {
                console.log('Exit from interactions requested. Stopping loop.');
                break;
            }

            // CHECK SAFETY LIMITS (Global check with feature toggles)
            const canLike = behavior.enableLikes !== false && activityTracker.canPerformAction('likes', maxLikesPerHour);
            const canComment = behavior.enableComments !== false && activityTracker.canPerformAction('comments', maxCommentsPerHour);

            if (!canLike && !canComment) {
                this.logger.warn("Hourly limits reached or features disabled for BOTH actions. Ending session early.");
                break;
            }

            try {
                const postSelector = `article:nth-of-type(${postIndex})`;
                // Check if the post exists
                if (!(await page.$(postSelector))) {
                    console.log("No more posts found. Ending iteration...");
                    return;
                }
                const likeButtonSelector = `${postSelector} svg[aria-label="Like"]`;
                const likeButton = await page.$(likeButtonSelector);
                let ariaLabel = null;
                if (likeButton) {
                    ariaLabel = await likeButton.evaluate((el: Element) => el.getAttribute("aria-label"));
                }

                // --- LIKING LOGIC ---
                if (behavior.enableLikes !== false) {
                    if (!activityTracker.canPerformAction('likes', maxLikesPerHour)) {
                        console.log(`Skipping like: Hourly limit reached (${activityTracker.getRecentCount('likes')}/${maxLikesPerHour}).`);
                    } else if (ariaLabel === "Like" && likeButton) {
                        console.log(`Liking post ${postIndex}...`);
                        try {
                            const isConnected = await likeButton.evaluate(el => el.isConnected).catch(() => false);
                            if (isConnected) {
                                await likeButton.click().catch(err => console.warn(`Failed to click like button: ${err}`));
                                await delay(500 + Math.random() * 500); // Small random delay
                                console.log(`Post ${postIndex} liked.`);
                                activityTracker.trackAction('likes');
                            } else {
                                console.warn(`Like button for post ${postIndex} is detached (skipping).`);
                            }
                        } catch (e) {
                            console.warn(`Error interacting with like button for post ${postIndex}:`, e);
                        }
                    } else if (ariaLabel === "Unlike") {
                        console.log(`Post ${postIndex} is already liked.`);
                    } else {
                        console.log(`Like button not found for post ${postIndex}.`);
                    }
                } else {
                    console.log(`Skipping liking for post ${postIndex} (feature disabled).`);
                }

                // Extract and log the post caption
                const captionSelector = `${postSelector} div.x9f619 span._ap3a div span._ap3a`;
                const captionElement = await page.$(captionSelector);
                let caption = "";
                if (captionElement) {
                    caption = await captionElement.evaluate((el) => (el as HTMLElement).innerText);
                    console.log(`Caption for post ${postIndex}: ${caption}`);
                } else {
                    console.log(`No caption found for post ${postIndex}.`);
                }
                // Check if there is a '...more' link to expand the caption
                const moreLinkSelector = `${postSelector} div.x9f619 span._ap3a span div span.x1lliihq`;
                // Use safe evaluation to check connectivity
                const moreLink = await page.$(moreLinkSelector);

                if (moreLink && captionElement) {
                    try {
                        const isConnected = await moreLink.evaluate(el => el.isConnected);
                        if (isConnected) {
                            console.log(`Expanding caption for post ${postIndex}...`);
                            await moreLink.click().catch(e => console.warn("Failed to click 'more' link (ignored):", e));
                            await delay(500); // Wait for expansion
                            const expandedCaption = await captionElement.evaluate((el) => (el as HTMLElement).innerText).catch(() => caption); // Fallback to original
                            console.log(
                                `Expanded Caption for post ${postIndex}: ${expandedCaption.substring(0, 50)}...`
                            );
                            caption = expandedCaption;
                        }
                    } catch (e) {
                        console.warn(`Error expanding caption for post ${postIndex}:`, e);
                    }
                }

                // --- COMMENT LOGIC ---
                if (behavior.enableComments !== false) {
                    if (!activityTracker.canPerformAction('comments', maxCommentsPerHour)) {
                        console.log(`Skipping comment: Hourly limit reached (${activityTracker.getRecentCount('comments')}/${maxCommentsPerHour}).`);
                    } else {
                        const commentBoxSelector = `${postSelector} textarea`;
                        const commentBox = await page.$(commentBoxSelector);
                        if (commentBox) {
                            console.log(`Commenting on post ${postIndex}...`);
                            const prompt = `human-like Instagram comment based on to the following post: "${caption}". make sure the reply\n            Matchs the tone of the caption (casual, funny, serious, or sarcastic).\n            Sound organic—avoid robotic phrasing, overly perfect grammar, or anything that feels AI-generated.\n            Use relatable language, including light slang, emojis (if appropriate), and subtle imperfections like minor typos or abbreviations (e.g., 'lol' or 'omg').\n            If the caption is humorous or sarcastic, play along without overexplaining the joke.\n            If the post is serious (e.g., personal struggles, activism), respond with empathy and depth.\n            Avoid generic praise ('Great post!'); instead, react specifically to the content (e.g., 'The way you called out pineapple pizza haters 😂👏').\n            *Keep it concise (1-2 sentences max) and compliant with Instagram's guidelines (no spam, harassment, etc.).*`;
                            const schema = getInstagramCommentSchema();
                            const result = await runAgent(schema, prompt);
                            const comment = (result[0]?.comment ?? "") as string;
                            await commentBox.type(comment);

                            // New selector approach for the post button
                            const postButton = await page.evaluateHandle(() => {
                                const buttons = Array.from(
                                    document.querySelectorAll('div[role="button"]')
                                );
                                return buttons.find(
                                    (button) =>
                                        button.textContent === "Post" && !button.hasAttribute("disabled")
                                );
                            });
                            // Only click if postButton is an ElementHandle and not null
                            const postButtonElement = postButton && postButton.asElement ? postButton.asElement() : null;
                            if (postButtonElement) {
                                console.log(`Posting comment on post ${postIndex}...`);
                                // Click logic...
                                await (postButtonElement as puppeteer.ElementHandle<Element>).click();
                                console.log(`Comment posted on post ${postIndex}.`);
                                activityTracker.trackAction('comments');
                                // Wait for comment to be posted and UI to update
                                await delay(2000);
                            } else {
                                console.log("Post button not found.");
                            }
                        } else {
                            console.log("Comment box not found.");
                        }
                    }
                } else {
                    console.log(`Skipping commenting for post ${postIndex} (feature disabled).`);
                }

                // Wait before moving to the next post
                const waitTime = Math.floor(Math.random() * 5000) + 5000;
                console.log(
                    `Waiting ${waitTime / 1000} seconds before moving to the next post...`
                );
                await delay(waitTime);
                // Extra wait to ensure all actions are complete before scrolling
                await delay(1000);
                // Scroll to the next post
                await page.evaluate(() => {
                    window.scrollBy(0, window.innerHeight);
                });
                postIndex++;
            } catch (error: any) {
                if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
                    this.logger.error("Browser window closed unexpectedly (Crash or User Action). Ending session.");
                } else {
                    this.logger.error(`Error interacting with post ${postIndex}: ${error.message}`);
                }
                break;
            }
        }
    }

    async scrapeFollowers(targetAccount: string, maxFollowers: number) {
        if (!this.page) throw new Error("Page not initialized");
        const page = this.page;
        try {
            // Navigate to the target account's followers page
            await page.goto(`https://www.instagram.com/${targetAccount}/followers/`, {
                waitUntil: "networkidle2",
            });
            console.log(`Navigated to ${targetAccount}'s followers page`);

            // Wait for the followers modal to load (try robustly)
            try {
                await page.waitForSelector('div a[role="link"] span[title]');
            } catch {
                // fallback: wait for dialog
                await page.waitForSelector('div[role="dialog"]');
            }
            console.log("Followers modal loaded");

            const followers: string[] = [];
            let previousHeight = 0;
            let currentHeight = 0;
            maxFollowers = maxFollowers + 4;
            // Scroll and collect followers until we reach the desired amount or can't scroll anymore
            console.log(maxFollowers);
            while (followers.length < maxFollowers) {
                // Get all follower links in the current view
                const newFollowers = await page.evaluate(() => {
                    const followerElements =
                        document.querySelectorAll('div a[role="link"]');
                    return Array.from(followerElements)
                        .map((element) => element.getAttribute("href"))
                        .filter(
                            (href): href is string => href !== null && href.startsWith("/")
                        )
                        .map((href) => href.substring(1)); // Remove leading slash
                });

                // Add new unique followers to our list
                for (const follower of newFollowers) {
                    if (!followers.includes(follower) && followers.length < maxFollowers) {
                        followers.push(follower);
                        console.log(`Found follower: ${follower}`);
                    }
                }

                // Scroll the followers modal
                await page.evaluate(() => {
                    const dialog = document.querySelector('div[role="dialog"]');
                    if (dialog) {
                        dialog.scrollTop = dialog.scrollHeight;
                    }
                });

                // Wait for potential new content to load
                await delay(1000);

                // Check if we've reached the bottom
                currentHeight = await page.evaluate(() => {
                    const dialog = document.querySelector('div[role="dialog"]');
                    return dialog ? dialog.scrollHeight : 0;
                });

                if (currentHeight === previousHeight) {
                    console.log("Reached the end of followers list");
                    break;
                }

                previousHeight = currentHeight;
            }

            console.log(`Successfully scraped ${followers.length - 4} followers`);
            return followers.slice(4, maxFollowers);
        } catch (error) {
            console.error(`Error scraping followers for ${targetAccount}:`, error);
            throw error;
        }
    }

    public async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }
}

export async function scrapeFollowersHandler(targetAccount: string, maxFollowers: number) {
    // Legacy handler - providing default empty config or maybe we should remove it? 
    // For now, just pass empty credentials which will fail if login needed, but keeps syntax valid.
    const client = new IgClient({});
    await client.init();
    const followers = await client.scrapeFollowers(targetAccount, maxFollowers);
    await client.close();
    return followers;
}