import * as puppeteer from 'puppeteer';
import { ElementHandle } from 'puppeteer';
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import UserAgent from "user-agents";
import { Server } from "proxy-chain";
import { IGpassword, IGusername } from "../../secret";
import logger from "../../config/logger";
import { Instagram_cookiesExist, loadCookies, saveCookies, ActivityTracker, killChromeProcessByProfile } from "../../utils";
import { runAgent } from "../../Agent";
import path from "path";
import { getInstagramCommentSchema, getInstagramDMResponseSchema } from "../../Agent/schema";
import readline from "readline";
import fs from "fs/promises";
import { getShouldExitInteractions } from '../../api/agent';
import { Contact } from '../../models/Contact';

// Add stealth plugin to puppeteer
puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(
    AdblockerPlugin({
        // Optionally enable Cooperative Mode for several request interceptors
        interceptResolutionPriority: puppeteer.DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
    })
);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class IgClient {
    private browser: puppeteer.Browser | null = null;
    private page: puppeteer.Page | null = null;
    private username: string;
    private password: string;
    private userDataDir?: string;
    private proxy?: string;
    private logger: any; // Using any or specific Logger type if available
    private character: any;

    private languages: string[] = ['English'];
    private defaultLanguage: string = 'English';

    constructor(
        config: { username?: string; password?: string; userDataDir?: string; proxy?: string, languages?: string[], defaultLanguage?: string },
        loggerInstance?: any,
        character?: any
    ) {
        this.username = config.username || '';
        this.password = config.password || '';
        this.userDataDir = config.userDataDir;
        this.proxy = config.proxy;
        this.logger = loggerInstance || logger;
        this.character = character || {};
        this.languages = config.languages || ['English'];
        this.defaultLanguage = config.defaultLanguage || 'English';
    }

    public isConnected(): boolean {
        return !!(this.browser && this.browser.isConnected());
    }

    async init() {
        if (this.isConnected()) {
            this.logger.info("Browser already active and connected. Skipping launch.");
            return;
        }

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
            // User requested background/minimized launch
            '--start-minimized',
            // Stability flags (Optimized for Windows)
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--mute-audio', // Good practice
            // Critical stability flags for avoiding TargetCloseError with Stealth Plugin
            '--disable-ipc-flooding-protection',
            '--disable-features=IsolateOrigins,site-per-process,CalculateNativeWinOcclusion', // Optimized for background
            '--disable-renderer-backgrounding',
            // Prevent Chrome from pausing when minimized/backgrounded
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--enable-features=NetworkService,NetworkServiceInProcess'
        ];

        if (this.proxy) {
            launchArgs.push(`--proxy-server=${this.proxy}`);
        }

        // Check for Linux/ARM (Raspberry Pi) compatibility to avoid "ELF not found" (Architecture Mismatch)
        let executablePath: string | undefined;
        if (process.platform === 'linux') {
            try {
                // Common paths for Chromium on Raspberry Pi / Linux
                const commonPaths = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome-stable'];
                for (const p of commonPaths) {
                    try {
                        // We use fs.stat (async) to check existence to avoid blocking or sync import issues
                        await fs.access(p); // properties of fs depends on import
                        executablePath = p;
                        this.logger.info(`Detected Linux system browser, using: ${p}`);
                        break;
                    } catch (e) { /* ignore */ }
                }
            } catch (e) {
                // Fallback to default
            }
        }

        const launchOptions: any = {
            headless: false,
            executablePath: executablePath || undefined, // Use system browser on Linux if found
            args: launchArgs,
            defaultViewport: null, // Ensure viewport matches window
            protocolTimeout: 180000, // Increase timeout to 3 minutes to prevent Runtime.callFunctionOn timeouts
            timeout: 60000, // Explicit 60s timeout for browser launch to prevent infinite hangs
        };

        if (this.userDataDir) {
            // Resolve to absolute path to avoid Puppeteer issues
            const absoluteUserDataDir = path.resolve(process.cwd(), this.userDataDir);
            launchOptions.userDataDir = absoluteUserDataDir;
            // Ensure directory exists
            // Ensure directory exists
            await fs.mkdir(absoluteUserDataDir, { recursive: true }).catch(() => { });

            // PROACTIVE CLEANUP: Kill any lingering Chrome processes for this profile BEFORE launching
            // Only if NOT connected (already checked above, but good for safety)
            if (!this.isConnected()) {
                try {
                    this.logger.info("Proactively cleaning up any existing Chrome processes for this profile...");
                    await killChromeProcessByProfile(this.userDataDir);
                    await delay(2000); // Give it a moment to release locks
                } catch (e: any) {
                    this.logger.warn(`Proactive cleanup failed (non-critical): ${e.message}`);
                }
            }
        }

        this.logger.info(`Launching browser with options: ${JSON.stringify({ ...launchOptions, args: launchOptions.args.map((a: string) => a.startsWith('--proxy-server') ? '--proxy-server=REDACTED' : a) }, null, 2)}`);

        let attempt = 0;
        const maxAttempts = 5;
        while (attempt < maxAttempts) {
            try {
                this.browser = await puppeteerExtra.launch(launchOptions);
                // Move newPage inside the try block to catch "Requesting main frame too early" errors
                this.page = await this.browser.newPage();

                // FORCE MINIMIZE: Use CDP to explicitly minimize the window to background
                try {
                    const session = await this.page.createCDPSession();
                    const { windowId } = await session.send("Browser.getWindowForTarget") as any;
                    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
                } catch (minErr) {
                    this.logger.warn(`Failed to minimize window (non-critical): ${minErr}`);
                }

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

                // FORCE CLEANUP: Kill zombie processes holding locks, then delete files
                if (this.userDataDir) {
                    try {
                        this.logger.info("Attempting to kill lingering Chrome processes for this profile...");
                        await killChromeProcessByProfile(this.userDataDir);
                    } catch (e: any) {
                        this.logger.warn(`Process kill failed (non-critical): ${e.message}`);
                    }

                    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
                    for (const file of lockFiles) {
                        try {
                            const lockPath = path.join(path.resolve(process.cwd(), this.userDataDir), file);
                            if (await fs.stat(lockPath).catch(() => false)) {
                                await fs.unlink(lockPath);
                                this.logger.warn(`Deleted stale lock file during retry: ${lockPath}`);
                            }
                        } catch (e) {
                            this.logger.warn(`Failed to delete lock file ${file}: ${e}`);
                        }
                    }
                }

                // Increase backoff delay slightly with each attempt
                const waitTime = 8000 + (attempt * 2000);
                this.logger.info(`Waiting ${waitTime / 1000} seconds before retrying...`);
                await delay(waitTime);
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
                this.logger.warn(`Proxy auth setup failed (non-critical): ${e}`);
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
            // "Instagram" logo is present on public pages too, so we must rely on "Home", "Direct", "Messenger" etc.
            const isNavPresent = await this.page.evaluate(() => {
                const home = document.querySelector('svg[aria-label="Home"]');
                const direct = document.querySelector('svg[aria-label="Direct"]') || document.querySelector('svg[aria-label="Messenger"]');
                const create = document.querySelector('svg[aria-label="New Post"]');
                const activity = document.querySelector('svg[aria-label="Activity Feed"]') || document.querySelector('svg[aria-label="Notifications"]');
                const profile = document.querySelector('a[href*="/' + (window as any)._sharedData?.config?.viewer?.username + '/"]'); // unreliable if _sharedData missing
                return !!(home || direct || create || activity);
            });

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
                    this.logger.info("DEBUG: Checking Automated Behavior Warning...");
                    await this.handleAutomatedBehaviorWarning();
                    this.logger.info("DEBUG: Done Automated Behavior Warning.");
                } catch (e) { this.logger.warn(`Ignored error during warning check: ${e}`); }

                // Check for "Not Now" button (e.g. Save Info, Try New Look, etc.)
                try {
                    this.logger.info("DEBUG: Checking 'Not Now' button...");
                    // Wrap in timeout to prevent hang
                    await Promise.race([
                        (async () => {
                            if (!this.page) return;
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
                        })(),
                        new Promise(resolve => setTimeout(resolve, 3000))
                    ]);
                    this.logger.info("DEBUG: Done 'Not Now' button check.");
                } catch (e) {
                    this.logger.warn(`Ignored error during 'Not Now' check (possible frame detach): ${e}`);
                }

                try {
                    this.logger.info("DEBUG: Taking debug screenshot...");
                    // Screenshot can hang on minimized windows
                    await Promise.race([
                        this.page.screenshot({ path: 'logs/debug_session_restored.png' }),
                        new Promise(resolve => setTimeout(resolve, 5000))
                    ]);
                    this.logger.info("DEBUG: Done screenshot.");
                } catch (e) {
                    this.logger.warn("Screenshot failed (likely due to minimized window), skipping.");
                }
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

        // Robust Check: verifying if we are truly logged in
        // We look for the "Home", "Search" or "Profile" icons which only appear for logged-in users.
        const isLoggedIn = await this.page.evaluate(() => {
            const homeIcon = document.querySelector('svg[aria-label="Home"]');
            const searchIcon = document.querySelector('svg[aria-label="Search"]');
            const profileLink = document.querySelector('a[href*="/' + (window as any)._sharedData?.config?.viewer?.username + '/"]');
            const navBar = document.querySelector('div[role="navigation"]');

            return !!(homeIcon || searchIcon || profileLink || navBar);
        });

        const url = this.page.url();
        if (!isLoggedIn || url.includes("/login/")) {
            logger.warn("Cookies are invalid (Login elements missing). Falling back to credentials login.");
            await this.loginWithCredentials();
        } else {
            logger.info("Successfully logged in with cookies (Session Verified).");
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
            const currentUrl = this.page.url();
            const isChallengePage = currentUrl.includes('/challenge/');

            if (isChallengePage) {
                this.logger.warn(`DETECTED: Challenge Page Redirect (${currentUrl})`);
            }

            // Check for warning text - broadened scope
            const warningDetected = await Promise.race([
                this.page.evaluate(() => {
                    // Check headers and dialogs first (standard overlay)
                    const errorHeaders = Array.from(document.querySelectorAll('h2, h3, h1, div[role="dialog"], p, span'));
                    const hasText = errorHeaders.some(el =>
                        el.textContent?.includes('We suspect automated behavior') ||
                        el.textContent?.includes('prevent your account from being temporarily restricted')
                    );

                    // Fallback: Check for the specific "Dismiss" button which implies the warning is present
                    const hasDismissBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).some(b => b.textContent?.trim() === 'Dismiss');

                    return hasText || hasDismissBtn;
                }),
                new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000)) // 3s timeout
            ]);

            if (warningDetected || isChallengePage) {
                this.logger.warn("CONFIRMED: 'Suspected Automated Behavior' Warning present.");
                this.logger.info("Handling humanely: Simulating reading time...");

                // 1. Simulate "Reading"
                await delay(3000 + Math.random() * 4000);

                // 2. Find and Click Dismiss (Robust Search)
                // We fetch specific element handles to inspect them
                const dismissAction = await this.page.evaluateHandle(() => {
                    // Collect all potential buttons
                    const candidates = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));

                    // Priority 1: Exact Text Match (Case Insensitive)
                    const exactMatch = candidates.find(b => {
                        const txt = b.textContent?.trim().toLowerCase();
                        return txt === 'dismiss' || txt === 'next' || txt === 'ok' || txt === 'continue';
                    });
                    if (exactMatch) return exactMatch;

                    // Priority 2: Contains Text
                    const partialMatch = candidates.find(b => {
                        const txt = b.textContent?.trim().toLowerCase() || '';
                        return txt.includes('dismiss');
                    });
                    if (partialMatch) return partialMatch;

                    // Priority 3: Only one button on the page? (If we are on a dedicated challenge page)
                    if (location.href.includes('/challenge/') && candidates.length > 0 && candidates.length < 3) {
                        // Likely the action button if it's one of few
                        return candidates[candidates.length - 1];
                    }

                    return null;
                });

                const dismissElement = dismissAction.asElement();

                if (dismissElement) {
                    this.logger.info("Found 'Dismiss' (or equivalent) button. Clicking...");

                    // Scroll into view just in case
                    await dismissElement.evaluate(el => (el as Element).scrollIntoView());
                    await delay(500);

                    await (dismissElement as puppeteer.ElementHandle<Element>).click();

                    // 3. Post-Click Pause
                    this.logger.info("Dismissed. Pausing for safety...");
                    await delay(3000 + Math.random() * 2000);
                } else {
                    this.logger.error("Warning detected but NO actionable button found.");

                    // Capture Debug HTML
                    const htmlSnapshot = await this.page.evaluate(() => document.body.innerHTML);
                    this.logger.error(`Debug HTML Snapshot (First 1000 chars): ${htmlSnapshot.substring(0, 1000)}`);

                    // If we are on a challenge page and can't dismiss, we might be stuck.
                    if (isChallengePage) {
                        this.logger.error("Stuck on Challenge page. Attempting force-navigation to Home...");
                        await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
                    }
                }
            }
        } catch (e) {
            this.logger.warn("Error checking for automated behavior warning: " + e);
        }
    }

    async handleNotificationPopup() {
        if (!this.page || this.page.isClosed()) return;
        // console.log("Checking for notification popup..."); // Reduce spam

        try {
            // Safety Check: If page is navigating, this might fail with "Detached Frame"
            // We can use Promise.race with a timeout to prevent hanging?
            // Or just swallow specific errors.
            await this.handleWhatHappenedPopup().catch(() => { }); // Swallow warnings here

            // Wait for the dialog to appear, with a timeout
            const dialogSelector = 'div[role="dialog"]';
            // Use a short timeout to prevent blocking
            try {
                await this.page.waitForSelector(dialogSelector, { timeout: 3000 });
            } catch (e) {
                // No dialog found, which is GOOD. standard flow.
                return;
            }
            // If found, proceed...
            const dialog = await this.page.$(dialogSelector);
            if (!dialog) return;

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

    private async handleWhatHappenedPopup() {
        if (!this.page) return;
        try {
            const whatHappenedDialog = await this.page.evaluateHandle(() => {
                const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
                return dialogs.find(d => d.textContent?.includes('What happened') || d.textContent?.includes('You can no longer request a review')) || null;
            });

            const dialogElement = whatHappenedDialog.asElement();
            if (dialogElement) {
                this.logger.warn("DETECTED: 'What Happened' Restriction Dialog.");

                // Try to find the close button (SVG X)
                const closeButton = await dialogElement.evaluateHandle((d) => {
                    const el = d as Element;
                    const svgs = Array.from(el.querySelectorAll('svg'));
                    // Look for aria-label Close or just the top-right typical position
                    const closeSvg = svgs.find(s => s.getAttribute('aria-label') === 'Close');
                    if (closeSvg) return closeSvg.closest('div[role="button"]') || closeSvg.parentElement || closeSvg;
                    return null;
                });

                const closeBtnElement = closeButton.asElement();
                if (closeBtnElement) {
                    this.logger.info("Found Close button for 'What Happened' dialog. Clicking...");
                    await closeBtnElement.evaluate((el) => (el as HTMLElement).click());
                    await delay(2000);
                    this.logger.info("Dismissed 'What Happened' dialog.");
                } else {
                    this.logger.error("Could not find Close button on 'What Happened' dialog. Taking generic click attempt on top-right...");
                    // Fallback logic if needed, or just log
                }
            }
        } catch (e) {
            this.logger.warn(`Error handling 'What Happened' popup: ${e}`);
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



    async checkAndAcceptDMRequests() {
        if (!this.page) return;
        try {
            // Enable Console Logging for this method
            this.page.on('console', msg => {
                if (msg.text().includes('[REQ DEBUG]')) console.log(`BROWSER REQ: ${msg.text()}`);
            });

            this.logger.info("Checking for DM Requests...");
            await this.page.goto("https://www.instagram.com/direct/requests/", { waitUntil: "networkidle2" });
            await delay(3000);

            // DEBUG: Dump Page Structure to identify selectors
            await this.page.evaluate(() => {
                console.log("[REQ DEBUG] Analysis Started.");
                const allDivs = Array.from(document.querySelectorAll('div, a, button'));
                let candidates = 0;
                allDivs.forEach((el, index) => {
                    const r = el.getBoundingClientRect();
                    // Basic visibility check
                    if (r.width < 10 || r.height < 10) return;

                    const role = el.getAttribute('role');
                    const label = el.getAttribute('aria-label');
                    const txt = (el as HTMLElement).innerText?.substring(0, 20).replace(/\n/g, "|") || "";

                    // Filter for interesting elements
                    if (role === 'button' || role === 'link' || role === 'listitem' || (txt.length > 3 && r.width > 200)) {
                        if (candidates < 20) {
                            console.log(`[REQ DEBUG] El #${index}: <${el.tagName.toLowerCase()}> Role=${role} Class="${el.className}" Size=${Math.round(r.width)}x${Math.round(r.height)} Text="${txt}"`);
                            candidates++;
                        }
                    }
                });
                console.log(`[REQ DEBUG] Analysis Complete. Found ${candidates} visible candidates.`);
            });

            // DEBUG: Screenshot
            try {
                const screenshotPath = path.resolve('screenshots', `requests_debug_${Date.now()}.png`);
                await fs.mkdir(path.dirname(screenshotPath), { recursive: true }).catch(() => { });
                await this.page.screenshot({ path: screenshotPath });
                this.logger.info(`Saved requests debug screenshot: ${screenshotPath}`);
            } catch (e) { /* ignore */ }

            // Strategy 1: Specific Listbox Buttons
            let requests: ElementHandle<Element>[] = await this.page.$$('div[role="listbox"] div[role="button"]');

            // Strategy 2: Broad "listitem" or "row"
            if (requests.length === 0) {
                this.logger.info("Strategy 1 (Listbox) failed. Trying Strategy 2 (Broad Rows)...");
                requests = await this.page.$$('div[role="listitem"], div[role="row"], a[href^="/direct/t/"]');
            }

            // Strategy 3: Text Search for "Request" context (Blind Attempt)
            if (requests.length === 0) {
                this.logger.info("Strategy 2 failed. Trying Strategy 3 (Any wide button)...");
                // Filter for elements that look like user rows
                requests = await this.page.evaluateHandle(() => {
                    const candidates = Array.from(document.querySelectorAll('div[role="button"], a'));
                    return candidates.filter(c => {
                        const r = c.getBoundingClientRect();
                        // Wide and short? (Row shape)
                        return r.width > 200 && r.height > 40 && r.height < 150;
                    });
                }).then(async h => {
                    const props = await h.getProperties();
                    const res: ElementHandle<Element>[] = [];
                    for (const v of props.values()) {
                        const el = v.asElement();
                        if (el) res.push(el as ElementHandle<Element>);
                    }
                    return res;
                });
            }

            if (requests.length === 0) {
                this.logger.info("No DM requests found (checked multiple strategies).");
                return;
            }

            this.logger.info(`Found ${requests.length} potential requests. Processing top 3...`);

            const maxToAccept = Math.min(requests.length, 3);
            for (let i = 0; i < maxToAccept; i++) {
                // Re-fetch using SHAPE STRATEGY (The only one that works)
                const currentRequests = await this.page.evaluateHandle(() => {
                    const candidates = Array.from(document.querySelectorAll('div[role="button"], a'));
                    return candidates.filter(c => {
                        const r = c.getBoundingClientRect();
                        const txt = (c as HTMLElement).innerText || "";
                        const isHiddenReq = txt.includes("Hidden Requests");
                        const isHeader = txt.includes("Message requests") || txt.includes("Decide who can");
                        const isPrimary = r.width > 200 && r.height > 40 && r.height < 150;
                        return isPrimary && !isHiddenReq && !isHeader;
                    });
                }).then(async h => {
                    const props = await h.getProperties();
                    const res: ElementHandle<Element>[] = [];
                    for (const v of props.values()) {
                        const el = v.asElement();
                        if (el) res.push(el as ElementHandle<Element>);
                    }
                    return res;
                });

                if (currentRequests.length === 0) {
                    this.logger.info("No more requests found (loop).");
                    break;
                }

                // Click the first one
                try {
                    const text = await currentRequests[0].evaluate(el => (el as HTMLElement).innerText.substring(0, 30));
                    this.logger.info(`Clicking request item: "${text.replace(/\n/g, ' ')}..."`);
                    await currentRequests[0].click();
                } catch (e) {
                    this.logger.warn(`Failed to click request item: ${e}`);
                    break;
                }

                await delay(3000);

                // Find "Accept" button
                const acceptBtn = await this.page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
                    return buttons.find(b => (b.textContent?.trim() === 'Accept' || (b as HTMLElement).innerText?.trim() === 'Accept')) || null;
                });

                const acceptBtnEl = acceptBtn.asElement();
                if (acceptBtnEl) {
                    await (acceptBtnEl as ElementHandle<Element>).click();
                    await delay(3000);

                    // Handle "Move to Primary" dialog if it appears
                    const primaryBtn = await this.page.evaluateHandle(() => {
                        const buttons = Array.from(document.querySelectorAll('div[role="dialog"] div[role="button"], div[role="dialog"] button'));
                        return buttons.find(b => (b.textContent?.trim() === 'Primary' || (b as HTMLElement).innerText?.trim() === 'Primary')) || null;
                    });

                    const primaryBtnEl = primaryBtn.asElement();
                    if (primaryBtnEl) {
                        await (primaryBtnEl as ElementHandle<Element>).click();
                        await delay(1000);
                    }

                    this.logger.info(`Accepted DM request ${i + 1}/${maxToAccept}`);
                } else {
                    this.logger.warn(`Could not find Accept button for request ${i + 1}.`);
                }

                await this.page.goto("https://www.instagram.com/direct/requests/", { waitUntil: "networkidle2" });
                await delay(3000);
            }
        } catch (e) {
            this.logger.error(`Error accepting DM requests: ${e}`);
        }
    }

    async checkAndRespondToDMs(limits?: { dmsPerHour?: number }) {
        if (!this.page) throw new Error("Page not initialized");

        // --- DM REQUESTS CHECK ---
        await this.checkAndAcceptDMRequests();

        const dmsPerHour = limits?.dmsPerHour || 5;
        // Check local activity tracker here too if needed, but app.ts should handle high level
        const accountId = this.userDataDir ? path.basename(this.userDataDir) : this.username;
        const activityTracker = new ActivityTracker(accountId);

        if (!activityTracker.canPerformAction('dms', dmsPerHour)) {
            this.logger.info(`Skipping DM check: Hourly limit reached (${activityTracker.getRecentCount('dms')}/${dmsPerHour}).`);
            return;
        }

        try {
            this.logger.info("Checking for unread Direct Messages...");
            // Listen for browser console logs (DEBUG)
            this.page.on('console', msg => {
                if (msg.text().includes('[DM DEBUG]')) {
                    console.log(`BROWSER CONS: ${msg.text()}`);
                }
            });

            await this.page.goto("https://www.instagram.com/direct/inbox/", { waitUntil: "networkidle2" });
            await delay(3000);
            await this.handleNotificationPopup();

            let processedCount = 0;
            const maxToProcess = Math.min(dmsPerHour, 10);

            while (processedCount < maxToProcess) {
                if (processedCount > 0) {
                    this.logger.info(`[DM BATCH] Processing next item ${processedCount + 1}/${maxToProcess}`);
                    await this.page.goto("https://www.instagram.com/direct/inbox/", { waitUntil: "networkidle2" });
                    await delay(3000);
                    await this.handleNotificationPopup();
                }

                // Debug Screenshot
                try {
                    const screenshotPath = path.resolve('screenshots', `inbox_debug_${Date.now()}.png`);
                    await fs.mkdir(path.dirname(screenshotPath), { recursive: true }).catch(() => { });
                    await this.page.screenshot({ path: screenshotPath });
                    this.logger.info(`Saved debug screenshot to: ${screenshotPath}`);
                } catch (e) { /* ignore */ }

                // Retry logic for Detached Frame errors
                let unreadThread;
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        const myUsername = this.username;
                        unreadThread = await this.page.evaluateHandle((myUser) => {
                            // Selector: Items INSIDE the Message Listbox (role="listbox")
                            // We look for buttons OR links to be safe.
                            let threads = Array.from(document.querySelectorAll('div[role="listbox"] div[role="button"], div[role="listbox"] a'));

                            // Fallback: If no listbox found (different layout), try broad search but exclude top bar
                            if (threads.length === 0) {
                                console.log("[DM DEBUG] No role='listbox' found. Using broad search...");
                                // Exclude div with role="tablist" (stories) usually
                                threads = Array.from(document.querySelectorAll('div[role="button"], a[href^="/direct/t/"]'));
                            }

                            console.log(`[DM DEBUG] Found ${threads.length} candidates.`);

                            return threads.find((t, index) => {
                                const textContent = (t as HTMLElement).innerText || '';

                                // FILTER: Ignore "Notes" / Self-reference
                                if (textContent.toLowerCase().includes(myUser.toLowerCase())) {
                                    if (index < 3) console.log(`[DM DEBUG] Item ${index} SKIPPED (Self): "${textContent.substring(0, 15)}..."`);
                                    return false;
                                }

                                // FILTER: Shape Check (CRITICAL)
                                // DM Threads are wide rectangles (Row). Notes/Stories are circles/squares (Column).
                                // We skip anything that looks like a "Bubble".
                                const rect = t.getBoundingClientRect();
                                const aspectRatio = rect.width / rect.height;
                                if (aspectRatio < 1.5) {
                                    if (index < 5) console.log(`[DM DEBUG] Item ${index} SKIPPED (Bubble/Note): Ratio=${aspectRatio.toFixed(2)} (${Math.round(rect.width)}x${Math.round(rect.height)})`);
                                    return false;
                                }


                                if (index < 3) {
                                    const cleanHtml = t.outerHTML.replace(/\s+/g, ' ').substring(0, 50);
                                    console.log(`[DM DEBUG] Item ${index} fragment: ${cleanHtml}`);
                                }

                                const label = t.getAttribute('aria-label') || '';
                                const hasBlueDot = (() => {
                                    const allChildren = t.querySelectorAll('*');
                                    for (const child of allChildren) {
                                        const style = window.getComputedStyle(child);
                                        if (style.backgroundColor.includes('0, 149, 246')) return true;
                                        if (style.height === '8px' && style.borderRadius === '50%') return true;
                                    }
                                    return false;
                                })();

                                const hasBoldText = (() => {
                                    const allChildren = t.querySelectorAll('*');
                                    for (const child of allChildren) {
                                        const w = window.getComputedStyle(child).fontWeight;
                                        if (w === '600' || w === '700' || w === 'bold') return true;
                                    }
                                    return false;
                                })();

                                if (index < 3) console.log(`[DM DEBUG] Item ${index}: Label="${label}", BlueDot=${hasBlueDot}, Bold=${hasBoldText}`);

                                if (label.toLowerCase().includes('unread')) {
                                    console.log(`[DM DEBUG] MATCH at index ${index} (Reason: Aria)`);
                                    return true;
                                }
                                if (hasBlueDot) {
                                    console.log(`[DM DEBUG] MATCH at index ${index} (Reason: BlueDot)`);
                                    return true;
                                }
                                if (hasBoldText) {
                                    console.log(`[DM DEBUG] MATCH at index ${index} (Reason: BoldText)`);
                                    return true;
                                }

                                return false;
                            }) || null;
                        }, myUsername);
                        break; // Success
                    } catch (err: any) {
                        if (err.message && err.message.includes('detached Frame') && attempt === 1) {
                            this.logger.warn("Frame detached during DM check. Retrying...");
                            await delay(2000);
                            continue;
                        }
                        throw err; // Re-throw if not detached frame or max attempts
                    }
                }

                const unreadThreadEl = unreadThread ? unreadThread.asElement() : null;
                if (unreadThreadEl) {
                    this.logger.info("Found unread DM thread! Opening...");
                    await unreadThreadEl.evaluate((el) => (el as HTMLElement).click());
                    await delay(3000);

                    // Scrape conversation
                    // Messages are in div[role="row"] usually? or generic container.
                    // We want the LAST message that is NOT from us.
                    // Improve scraping to detect sender

                    // 1. Detect conversation partner username from Header
                    // Header usually contains h1 or h2 with username
                    const partnerUsername = await this.page.evaluate(() => {
                        const headers = Array.from(document.querySelectorAll('h1, h2, h3, span[dir="auto"]'));
                        // Look for the header text that matches likely a username (simplified)
                        // Or just grab the text from the top bar ?
                        // Better: We clicked a thread earlier. The text of that thread usually contains the name. 
                        // But we lost that ref.
                        // Let's look for the main header in the conversation column (right pane).
                        // Usually specific classes.
                        // Fallback: Use "User" if not found.
                        const header = document.querySelector('div[role="main"] h2') || document.querySelector('div[role="main"] h1');
                        return header?.textContent?.trim() || "User";
                    });

                    // 2. Scrape last 10 messages for context
                    const history = await this.page.evaluate(() => {
                        const messages = Array.from(document.querySelectorAll('div[dir="auto"]'));
                        if (messages.length === 0) return [];

                        const historyData = [];
                        // Iterate backwards, up to 10 valid text bubbles
                        let count = 0;
                        for (let i = messages.length - 1; i >= 0 && count < 10; i--) {
                            const node = messages[i];
                            const text = node.textContent?.trim() || "";
                            if (!text) continue;

                            let isMine = false;
                            let el: HTMLElement | null = node as HTMLElement;
                            let depth = 0;
                            while (el && depth < 6) {
                                const style = window.getComputedStyle(el);
                                const bg = style.backgroundColor;
                                if (bg.includes('0, 149, 246') || bg.includes('55, 151, 240') || bg.includes('rgb(0, 100, 224)')) {
                                    isMine = true;
                                    break;
                                }
                                if ((style.alignSelf === 'flex-end' || style.alignItems === 'flex-end') && !isMine) {
                                    // isMine = true; // Use cautiously
                                }
                                el = el.parentElement;
                                depth++;
                            }
                            if (!isMine) {
                                const rect = node.getBoundingClientRect();
                                const viewWidth = window.innerWidth;
                                if (rect.left > viewWidth * 0.5) isMine = true;
                            }

                            historyData.unshift({ text, isMine }); // Add to front to maintain chronological order
                            count++;
                        }
                        return historyData;
                    });

                    const lastMessage = history[history.length - 1]; // Use local variable, NOT lastMessageData which is removed
                    // Check if *last* message is ours (Loop Protection)
                    if (lastMessage && lastMessage.isMine) {
                        this.logger.info(`Last message detected from ME: "${lastMessage.text.substring(0, 30)}...". Skipping reply.`);
                    } else if (lastMessage) {
                        this.logger.info(`Conversation Context (${history.length} msgs). Last from Partner: "${lastMessage.text.substring(0, 30)}..."`);

                        const lastMessageText = lastMessage.text;
                        this.logger.info(`Last message detected: "${lastMessageText.substring(0, 50)}..."`);

                        // Generate Response
                        const schema = getInstagramDMResponseSchema();


                        // 3. Retrieve Facts from DB
                        let existingFacts: string[] = [];
                        if (partnerUsername) {
                            try {
                                const contact = await Contact.findOne({ username: partnerUsername });
                                if (contact && contact.facts) existingFacts = contact.facts;
                            } catch (err) {
                                this.logger.warn(`Failed to fetch contact info: ${err}`);
                            }
                        }

                        // 4. Format History
                        const historyText = history.map(h => h.isMine ? `[Me]: ${h.text}` : `[Him]: ${h.text}`).join('\n');

                        // Construct Personalized Prompt
                        const charName = this.character?.aiPersona?.name || "User";
                        const charBio = (this.character?.bio || []).join(" ");
                        const charLore = (this.character?.lore || []).join(" ");
                        const charTopics = (this.character?.topics || []).join(", ");
                        const charAdjectives = (this.character?.adjectives || []).join(", ");
                        const charStyle = (this.character?.style?.all || []).join(" ");

                        const prompt = `You are ${charName} on Instagram.
                    
                    Your Bio: ${charBio}
                    Your Lore/Backstory: ${charLore}
                    Your Interests: ${charTopics}
                    Your Style/Tone: ${charAdjectives} ${charStyle}
                    
                    You are replying to a DM thread with user: "${partnerUsername}".

                    [KNOWN FACTS ABOUT USER]
                    ${existingFacts.length > 0 ? existingFacts.map(f => `- ${f}`).join('\n') : "(None yet)"}

                    [CONVERSATION HISTORY (Last 10 messages)]
                    ${historyText}

                    Language Configuration:
                    - You speak: [${this.languages.join(', ')}]
                    - Default Language: "${this.defaultLanguage}"
                    
                    Task: Generate a natural response as ${charName}.
                    Guidelines:
                    - Detect the language of the incoming message.
                    - If it matches one of your spoken languages above, reply in that language.
                    - Otherwise, reply in your Default Language (${this.defaultLanguage}).
                    - Keep it concise (1-2 sentences usually).
                    - Match your specific tone and style defined above.
                    - If the message is "hi" or generic, reply in character.
                    - If it's spam, ignore it (return empty string or "IGNORE").
                    - Do not be overly helpful assistant-like; be the character.
                    - IMPORTANT: Extract any NEW permanent facts about the user (e.g. name, age, city, pets, likes, relationships) from the conversation. Return them in the 'memory_updates' field.
                    `;

                        const result = await runAgent(schema, prompt);
                        // result is typically an array of objects based on schema
                        let responseText = result[0]?.response;
                        let newFacts = result[0]?.memory_updates || [];

                        // 5. Save New Facts
                        if (newFacts.length > 0 && partnerUsername) {
                            try {
                                await Contact.findOneAndUpdate(
                                    { username: partnerUsername },
                                    {
                                        $addToSet: { facts: { $each: newFacts } },
                                        $set: { lastInteraction: new Date() }
                                    },
                                    { upsert: true, new: true }
                                );
                                this.logger.info(`Saved ${newFacts.length} new facts for ${partnerUsername}: ${newFacts.join(', ')}`);
                            } catch (err) {
                                this.logger.error(`Failed to save facts: ${err}`);
                            }
                        }

                        if (responseText && responseText !== "IGNORE") {
                            this.logger.info(`Generated response: "${responseText}"`);
                            await this.page.type('div[role="textbox"][contenteditable="true"]', responseText);
                            await delay(1000);

                            // Send
                            const sendBtn = await this.page.evaluateHandle(() => {
                                const buttons = Array.from(document.querySelectorAll('button'));
                                return buttons.find(b => b.textContent === 'Send') || null;
                            });

                            const sendBtnEl = sendBtn.asElement();
                            if (sendBtnEl) {
                                await sendBtnEl.evaluate((el) => (el as HTMLElement).click());
                                this.logger.info("DM Sent.");
                                activityTracker.trackAction('dms');
                            } else {
                                // Enter key fallback
                                await this.page.keyboard.press('Enter');
                                this.logger.info("DM Sent (via Enter key).");
                                activityTracker.trackAction('dms');
                                processedCount++;
                            }
                        }
                    }
                    // Random delay between messages in batch
                    await delay(3000 + Math.random() * 5000);
                } else {
                    this.logger.info("No unread DMs found. Batch finished.");
                    break;
                }
            } // End While Loop

        } catch (e) {
            this.logger.error(`Error checking/responding to DMs: ${e}`);
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

    async interactWithHashtags(hashtags: string[], options: {
        behavior?: { enableLikes?: boolean; enableComments?: boolean; enableCommentLikes?: boolean; };
        limits?: { likesPerHour?: number; commentsPerHour?: number; }
    } = {}) {
        if (!this.page) throw new Error("Page not initialized");
        const { behavior = { enableLikes: true, enableComments: true, enableCommentLikes: false }, limits } = options;

        if (!hashtags || hashtags.length === 0) {
            this.logger.warn("No hashtags provided for interaction.");
            return;
        }

        const maxLikesPerHour = limits?.likesPerHour || 10;
        const maxCommentsPerHour = limits?.commentsPerHour || 5;

        // Initialize Activity Tracker
        const accountId = this.userDataDir ? path.basename(this.userDataDir) : this.username;
        const activityTracker = new ActivityTracker(accountId);

        this.logger.info(`Starting Hashtag Interaction session. Tags: [${hashtags.join(', ')}]`);

        // Pick a random hashtag
        const tag = hashtags[Math.floor(Math.random() * hashtags.length)];
        this.logger.info(`Selected hashtag: #${tag}`);

        try {
            this.logger.info(`Navigating to hashtag page: #${tag}`);
            await this.page.goto(`https://www.instagram.com/explore/tags/${tag}/`, { waitUntil: "domcontentloaded" });

            // Allow hydration time (essential for React)
            this.logger.info("Waiting for page hydration...");
            await delay(5000);

            // Scroll down to trigger lazy-loaded grid
            await this.page.evaluate(() => window.scrollBy(0, 300));
            await delay(2000);

            // Check if tag page loaded (posts exist)
            // Selector for the first post in the grid (Top Posts or Most Recent)
            // Typically: _aagw is the image container class. 
            // Better to select by anchor tag in the grid.
            // Start with robust selectors for the grid
            // 1. Generic links to /p/ (posts) inside Main (Best)
            // 2. Any link to /p/ (Fallback)
            const postSelectors = [
                'main a[href^="/p/"]',
                'a[href^="/p/"]',
                'div._aagw', // Legacy container
                'article a[role="link"]'
            ];

            let firstPost = null;
            for (const selector of postSelectors) {
                try {
                    await this.page.waitForSelector(selector, { timeout: 4000 });
                    firstPost = await this.page.$(selector);
                    if (firstPost) {
                        this.logger.info(`Found post using selector: ${selector}`);
                        break;
                    }
                } catch (e) { }
            }

            if (!firstPost) {
                const currentUrl = this.page.url();
                this.logger.error(`No posts found on ${currentUrl} using selectors: ${postSelectors.join(', ')}`);
                await this.page.screenshot({ path: `logs/debug_hashtag_${tag}_error.png` });
                const body = await this.page.evaluate(() => document.body.innerHTML.substring(0, 1000));
                this.logger.error(`Debug HTML: ${body}`);
                throw new Error("No posts found.");
            }

            this.logger.info(`Opened #${tag} page. Clicking first post...`);
            await firstPost.click();
            await delay(3000); // Wait for modal to open

            let postsProcessed = 0;
            const maxPosts = 10; // Limit for this session

            while (postsProcessed < maxPosts) {
                // Check exit flag
                if (typeof getShouldExitInteractions === 'function' && getShouldExitInteractions()) {
                    this.logger.info('Exit requested. Stopping hashtag loop.');
                    break;
                }

                // --- LIKING LOGIC (Modal) ---
                // In modal, the Like button selector might be different or standard
                // Often: svg[aria-label="Like"] or "Unlike"
                // Connectivity check is crucial here too

                const canLike = behavior.enableLikes !== false && activityTracker.canPerformAction('likes', maxLikesPerHour);
                if (canLike) {
                    try {
                        // Wait for like button to be visible in the modal
                        // FIX: Target only the MAIN like button in the action bar section, avoiding comments.
                        // Structure: section (actions) -> span -> button -> svg[aria-label="Like"]
                        let likeSelector = 'section svg[aria-label="Like"]';
                        let likeButton = await this.page.$(likeSelector);

                        // FALLBACK: If strict selector fails (e.g. Reels view), try finding ANY like button that isn't a comment
                        if (!likeButton) {
                            this.logger.warn(`Strict like selector (${likeSelector}) failed. Trying fallback...`);
                            const potentialButtons = await this.page.$$('svg[aria-label="Like"]');
                            for (const btn of potentialButtons) {
                                // Exclude if inside a list (ul) or small comment container
                                const isComment = await btn.evaluate(el => !!el.closest('ul') || !!el.closest('div[role="button"]')); // Comments often in divs with role=button acting as hearts
                                if (!isComment) {
                                    likeButton = btn as ElementHandle; // Found a likely candidate
                                    this.logger.info("Found fallback like button!");
                                    break;
                                }
                            }
                        }

                        if (likeButton) {
                            const isConnected = await likeButton.evaluate(el => el.isConnected).catch(() => false);
                            if (isConnected) {
                                this.logger.info(`Liking post ${postsProcessed + 1} in #${tag}...`);
                                await likeButton.click();
                                await delay(1000 + Math.random() * 1000);
                                activityTracker.trackAction('likes');
                            }
                        } else {
                            // Maybe already liked?
                            const unlikeSelector = 'svg[aria-label="Unlike"]'; // Broaden unlike check too
                            if (await this.page.$(unlikeSelector)) {
                                this.logger.info(`Post ${postsProcessed + 1} already liked.`);
                            } else {
                                this.logger.info(`Like button not found for post ${postsProcessed + 1}.`);
                            }
                        }
                    } catch (e) {
                        this.logger.warn(`Error liking post in hashtag mode: ${e}`);
                    }

                    // --- COMMENT LIKING LOGIC (New Feature) ---
                    if (behavior.enableCommentLikes) {
                        try {
                            const commentLikeSelectors = [
                                'ul svg[aria-label="Like"]', // Standard comment list
                                'div[role="button"] svg[aria-label="Like"]' // Buttons
                            ];
                            // Exclude the main post like button (found in 'section')
                            // We look for likes that are NOT in a section

                            const allLikeButtons = await this.page.$$('svg[aria-label="Like"]');
                            let likedCount = 0;

                            for (const btn of allLikeButtons) {
                                if (likedCount >= 1) break; // Like max 1 comment per post

                                // Check if this button is inside the main action bar (Section)
                                const isMainLike = await btn.evaluate(el => !!el.closest('section'));
                                if (isMainLike) continue; // Skip main post like

                                // It's likely a comment!
                                const isConnected = await btn.evaluate(el => el.isConnected).catch(() => false);
                                if (isConnected) {
                                    this.logger.info(`Liking a comment on post ${postsProcessed + 1}...`);
                                    await btn.click();
                                    await delay(1000);
                                    likedCount++;
                                }
                            }
                        } catch (e) {
                            this.logger.warn(`Error liking comment: ${e}`);
                        }
                    }
                } else {
                    if (behavior.enableLikes !== false) {
                        this.logger.info("Hourly like limit reached. Stopping hashtag session.");
                        break;
                    }
                }

                // --- NEXT POST NAVIGATION ---
                postsProcessed++;
                if (postsProcessed >= maxPosts) break;

                try {
                    // "Next" arrow in modal. Often svg[aria-label="Next"] or generic button
                    const nextArrowSelector = 'svg[aria-label="Next"]';
                    const nextButton = await this.page.$(`button ${nextArrowSelector}, a ${nextArrowSelector}, ${nextArrowSelector}`); // Flexible search
                    // Usually the SVG is inside a button or anchor
                    // More robust: search by aria-label "Next" on SVG

                    // We need to click the PARENT element usually (the button), not just the SVG
                    // --- NAVIGATION TO NEXT POST ---
                    try {
                        // Robustly find the next arrow
                        const nextElement = await this.page.evaluateHandle(() => {
                            const svgs = Array.from(document.querySelectorAll('svg[aria-label="Next"]'));
                            if (svgs.length > 0) return svgs[0].closest('button') || svgs[0].closest('a') || svgs[0];
                            return null;
                        }).catch((e: Error) => {
                            this.logger.warn(`Navigation selector failed (frame detached?): ${e.message}`);
                            return null;
                        });

                        if (nextElement && nextElement.asElement()) {
                            const nextElementHandle = nextElement.asElement();
                            if (nextElementHandle) {
                                this.logger.info("Navigating to next post...");
                                // Click and wait, catching any detachment errors during the transition
                                await Promise.all([
                                    (nextElementHandle as puppeteer.ElementHandle<Element>).click(),
                                    delay(3000 + Math.random() * 2000)
                                ]);
                            } else {
                                this.logger.warn("Next element handle is null. Stopping.");
                                break;
                            }
                        } else {
                            this.logger.warn("Next arrow not found. Reached end of available posts?");
                            break;
                        }

                    } catch (e: any) {
                        if (e.message && e.message.includes('detached')) {
                            this.logger.warn(`Frame detached during navigation (likely page reload). Stopping session safely.`);
                        } else {
                            this.logger.warn(`Error navigating to next post: ${e.message}`);
                        }
                        break;
                    }
                } catch (e) {
                    /* ignoring outer try error */
                }
            }

        } catch (e) {
            this.logger.error(`Error in interactWithHashtags: ${e}`);
        }
    }

    /**
     * Simulates a human-like click by moving the mouse to the element first,
     * hesitating, and then triggering the click via JS to avoid protocol timeouts.
     */
    private async humanLikeClick(element: puppeteer.ElementHandle<Element>) {
        try {
            // 1. Get Element Position
            const box = await element.boundingBox();
            if (box && this.page) {
                // 2. Move Mouse to target with randomization (Human behavior)
                // Add some randomness to the exact click point within the element
                const x = box.x + (box.width / 2) + ((Math.random() - 0.5) * (box.width / 4));
                const y = box.y + (box.height / 2) + ((Math.random() - 0.5) * (box.height / 4));

                // Move the mouse visually (server sees this mouse event)
                await this.page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });

                // 3. Hesitate (Simulate reaction time)
                await delay(150 + Math.random() * 300);
            }
        } catch (e) {
            // If bounding box calculation fails, we just proceed to the click as fallback
        }

        // 4. Perform the click using JS Evaluate
        // We use evaluate() instead of element.click() because the latter often causes
        // "ProtocolError: Runtime.callFunctionOn timed out" on heavy pages or with stealth plugins.
        await element.evaluate((el: Element) => (el as HTMLElement).click());
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
                                // Use human-like safe click (Move -> Delay -> JS Click)
                                await this.humanLikeClick(likeButton as puppeteer.ElementHandle<Element>)
                                    .catch(err => console.warn(`Failed to click like button: ${err}`));
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
                            await this.humanLikeClick(moreLink as puppeteer.ElementHandle<Element>).catch(e => console.warn("Failed to click 'more' link (ignored):", e));
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
            try {
                // Get process ID before closing
                const proc = this.browser.process();
                await this.browser.close();

                // Ensure double-tap kill if process still exists (optional/aggressive)
                if (proc) {
                    try {
                        proc.kill('SIGKILL');
                    } catch (e) { }
                }
            } catch (e) {
                this.logger.warn(`Error closing browser gracefully: ${e}`);
            }
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