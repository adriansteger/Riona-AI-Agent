import puppeteer from 'puppeteer-extra';
import { HTTPRequest } from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import logger from '../../config/logger';
import { EmailService } from '../../services/EmailService';
import { JobAnalyzer } from '../../services/JobAnalyzer';
import { JobHistory } from '../../services/JobHistory';
import UserAgent from 'user-agents';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

puppeteer.use(StealthPlugin());
puppeteer.use(
    AdblockerPlugin({
        blockTrackers: true,
    })
);

interface JobConfig {
    keywords: string[];
    location: string | string[];
    platforms: string[];
    pensum?: string; // Added for User Preferences
    email?: string; // Added for specific email alerts
}

interface JobData {
    title: string;
    company: string;
    url: string;
    description?: string;
}

export class JobClient {
    private browser: any;
    private page: any;
    private emailService: EmailService;
    private analyzer: JobAnalyzer;
    private history: JobHistory;
    private config: JobConfig;
    private currentTargetUserId: string | null = null;
    private originalConfig: JobConfig;

    constructor(emailService: EmailService, config: JobConfig) {
        this.emailService = emailService;
        this.config = config;
        this.originalConfig = { ...config }; // Backup original config
        this.analyzer = new JobAnalyzer();
        this.history = new JobHistory();


    }



    async init() {
        if (this.browser && this.browser.isConnected()) return;

        // Detect Linux/Raspberry Pi System Browser (Fix for ELF errors/ARM mismatch)
        let executablePath: string | undefined;
        if (process.platform === 'linux') {
            try {
                const fs = require('fs');
                const commonPaths = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome-stable'];
                for (const p of commonPaths) {
                    if (fs.existsSync(p)) {
                        logger.info(`Found system browser at ${p}. Using it instead of bundled Chrome.`);
                        executablePath = p;
                        break;
                    }
                }

                // Proactive Cleanup: Kill orphan Chromium processes to prevent "Too many windows"
                // on execution start, especially if previous run crashed.
                try {
                    logger.info("Performing proactive process cleanup...");
                    const { execSync } = require('child_process');
                    // Kill chromium processes owned by this user
                    execSync('pkill -u $(whoami) -f chromium', { stdio: 'ignore' });
                    // Also kill chrome
                    execSync('pkill -u $(whoami) -f chrome', { stdio: 'ignore' });
                    logger.info("Cleanup complete.");
                    // eslint-disable-next-line no-empty
                } catch (e) { }
            } catch (e) {
                logger.warn(`Failed to detect system browser: ${e}`);
            }
        }

        logger.info("Initializing Browser for Job Search...");
        this.browser = await puppeteer.launch({
            executablePath,
            headless: false,
            timeout: 90000, // Increased to 90s for Raspberry Pi (Slow I/O)
            dumpio: true,   // Log browser errors to stdout for debugging
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                // '--start-maximized', // DISABLED: User wants foreground but not full screen
                `--window-size=1280,800`,
                `--window-position=${Math.floor(Math.random() * 500)},${Math.floor(Math.random() * 300)}`, // Random position to prevent stacking
                '--disable-blink-features=AutomationControlled',
                // Keep browser alive and active even when minimized/backgrounded
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                // Essential for Windows to prevent "Occluded" status
                '--disable-features=CalculateNativeWinOcclusion',
            ],
            ignoreHTTPSErrors: true
        } as any);

        const apiKey = process.env.RESUMATE_API_TOKEN || "MISSING";
        logger.info(`Loaded ResuMate API Key: ${apiKey.substring(0, 5)}...`);

        this.browser.on('disconnected', () => {
            logger.warn("Browser disconnected/closed unexpectedly.");
            this.browser = null;
            this.page = null;
            this.detailsPage = null; // Reset details page
        });

        this.page = await this.browser.newPage();

        // SPOOF VISIBILITY: Trick the page into thinking it's always in the foreground
        await this.page.evaluateOnNewDocument(() => {
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        });

        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await this.page.setViewport({ width: 1920, height: 1080 });
    }

    async ensureBrowser() {
        try {
            if (!this.browser || !this.browser.isConnected()) {
                await this.init();
            }
            if (!this.page || this.page.isClosed()) {
                this.page = await this.browser.newPage();

                // SPOOF VISIBILITY: Trick the page into thinking it's always in the foreground
                await this.page.evaluateOnNewDocument(() => {
                    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
                    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
                });

                await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            }
        } catch (e) {
            logger.error(`Failed to ensure browser: ${e} `);
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null; // Ensure nullified
            this.page = null;
            this.detailsPage = null;
        }
    }

    async runSearch() {
        // --- Central Service / Admin Mode ---
        logger.info(">>> STARTING CENTRAL SERVICE LOOP <<<");
        const proUsers = await this.fetchProUsers(); // Fetch queue

        if (!proUsers || proUsers.length === 0) {
            logger.warn(">>> NO USERS IN QUEUE. Skipping search cycle. <<<");
            return;
        }

        logger.info(`>>> Processing ${proUsers.length} Users... << <`);

        for (const user of proUsers) {
            logger.info(`\n === Processing User: ${user.name} (${user.id}) === `);
            this.currentTargetUserId = user.id;

            // Map user preferences to config
            // Priority: User Prefs > Default Config
            const title = user.preferences?.title;

            if (!title) {
                logger.warn(`   Skipping user ${user.name} - No Job Title defined.`);
                continue;
            }

            const keywords = [title];
            // Append pensum to keywords if defined (e.g. "80-100%")
            if (user.preferences?.pensum) {
                keywords.push(user.preferences.pensum);
            }

            const location = user.preferences?.location;
            if (!location) {
                logger.warn(`   Skipping user ${user.name} - No Job Location defined.`);
                continue;
            }

            this.config = {
                keywords: keywords,
                location: location,
                platforms: this.originalConfig.platforms,
                pensum: user.preferences?.pensum, // Store pensum preference
                email: user.email // Store user email
            };

            logger.info(`   Target: ${this.config.keywords[0]} in ${this.config.location} (Pensum: ${this.config.pensum || 'Any'})`);

            await this.executeSearchLoop();
        }

        // Reset
        this.currentTargetUserId = null;
        this.config = this.originalConfig;
        logger.info(">>> CENTRAL SERVICE LOOP COMPLETED <<<");
    }

    private async fetchProUsers(): Promise<any[]> {
        const apiUrl = process.env.RESUMATE_API_URL;
        const apiKey = process.env.RESUMATE_API_TOKEN;

        if (!apiUrl || !apiKey) return [];

        try {
            // Endpoint: [API_URL]/../admin/pro-users
            const adminUrl = apiUrl.replace('/jobs', '/admin/pro-users');

            logger.info(`Fetching User Queue from: ${adminUrl} `);
            const response = await axios.get(adminUrl, {
                headers: { 'x-api-key': apiKey }
            });

            if (response.data?.success && Array.isArray(response.data.users)) {
                return response.data.users;
            }
        } catch (error: any) {
            logger.error(`Failed to fetch User Queue: ${error.message} `);
        }
        return [];
    }

    private async executeSearchLoop() {
        const locations = Array.isArray(this.config.location) ? this.config.location : [this.config.location];

        for (const location of locations) {
            logger.info(`-- - Searching jobs in: ${location} --- `);

            for (const platform of this.config.platforms) {
                try {
                    await this.ensureBrowser();

                    let jobs: JobData[] = [];

                    const normalizedPlatform = platform.toLowerCase();

                    if (normalizedPlatform.includes('indeed')) {
                        jobs = await this.searchIndeed(location);
                    } else if (normalizedPlatform.includes('ziprecruiter')) {
                        jobs = await this.searchZipRecruiter(location);
                    } else if (normalizedPlatform.includes('weworkremotely')) {
                        jobs = await this.searchWeWorkRemotely(location);
                    } else {
                        logger.warn(`Unknown or unsupported platform: ${platform} `);
                    }

                    await this.processJobs(jobs, platform);

                } catch (error) {
                    logger.error(`Error running search for ${platform} in ${location}: ${error} `);
                    await this.close();
                }
            }
        }
    }

    private async filterExistingJobs(jobs: JobData[]): Promise<JobData[]> {
        const apiUrl = process.env.RESUMATE_API_URL; // e.g., .../api/jobs
        const apiKey = process.env.RESUMATE_API_TOKEN;

        if (!apiUrl || !apiKey || !this.currentTargetUserId) {
            return jobs; // Without ID or API, we cannot check.
        }

        const urlsToCheck = jobs.map(j => j.url);
        if (urlsToCheck.length === 0) return [];

        try {
            const checkUrl = apiUrl + '/check'; // .../api/jobs/check
            logger.info(`Checking ${urlsToCheck.length} jobs against API...`);

            const response = await axios.post(checkUrl, {
                urls: urlsToCheck,
                targetUserId: this.currentTargetUserId
            }, {
                headers: { 'x-api-key': apiKey }
            });

            if (response.data && Array.isArray(response.data.existing)) {
                const existing = new Set(response.data.existing);
                const filtered = jobs.filter(j => {
                    const cleanUrl = j.url.split('&')[0].split('?')[0]; // Simple clean for API check context if needed, but better to rely on exact match?
                    // Actually, let's trust the API to handle the logic or matching.
                    // But here we are filtering based on what the API returned as "existing"
                    return !existing.has(j.url);
                });

                // Also locally filter out if we have processed this "clean" version before?
                // No, sticking to exact URL from API resp for now.

                const skippedCount = jobs.length - filtered.length;

                if (skippedCount > 0) {
                    logger.info(`Skipping ${skippedCount} jobs(already exist in DB for this user).`);
                }
                return filtered;
            }
            return jobs; // If API response is not successful or not an array, return all jobs
        } catch (error: any) {
            logger.warn(`Failed to check existing jobs API: ${error.message}. Proceeding with all.`);
        }
        return jobs;
    }

    // Helper to get stable ID from URL
    private extractJobId(url: string): string {
        try {
            const urlObj = new URL(url);

            // Indeed: Use 'jk' parameter
            if (url.includes('indeed')) {
                const jk = urlObj.searchParams.get('jk');
                if (jk) return `indeed:${jk} `;
            }

            // ZipRecruiter: Use last path segment or specific ID
            if (url.includes('ziprecruiter')) {
                // e.g. .../jobs/123-title-text
                const parts = urlObj.pathname.split('/');
                const id = parts[parts.length - 1];
                if (id) return `ziprecruiter:${id} `;
            }

            // Fallback: Use URL without query params
            return url.split('?')[0];
        } catch (e) {
            return url; // Return original if parsing fails
        }
    }

    private async processJobs(allJobs: JobData[], platform: string) {
        // 0. Deduplicate input list (Self-Dedup)
        const uniqueJobsMap = new Map<string, JobData>();
        for (const j of allJobs) {
            const stableId = this.extractJobId(j.url);
            if (!uniqueJobsMap.has(stableId)) {
                uniqueJobsMap.set(stableId, j);
            }
        }
        const uniqueJobs = Array.from(uniqueJobsMap.values());

        // 1. Filter out locally processed (cache) using Stable IDs
        let jobs = uniqueJobs.filter(j => {
            const stableId = this.extractJobId(j.url);
            if (this.history.isProcessed(stableId)) {
                return false;
            }
            // Also check raw URL for backward compatibility
            if (this.history.isProcessed(j.url)) {
                return false;
            }
            return true;
        });

        // 2. Filter out backend existing (API)
        jobs = await this.filterExistingJobs(jobs);

        logger.info(`Processing ${jobs.length} new jobs for ${platform}...`);

        for (const job of jobs) {
            try {
                const currentStableId = this.extractJobId(job.url);
                if (this.history.isProcessed(currentStableId)) { // Double check with Stable ID
                    logger.info(`Skipping duplicate job: ${job.title} `);
                    continue;
                }

                // Deep Scrape: Visit the job page to get the description
                logger.info(`Visiting job page for details: ${job.title}...`);
                const details = await this.scrapeJobDetails(job.url, platform);

                // AI Analysis with FULL description
                logger.info(`Analyzing job with AI... (Target: "${this.config.keywords[0]}", Pensum: "${this.config.pensum}")`);
                const analysis = await this.analyzer.analyzeJob(
                    job.title,
                    job.company,
                    details.description,
                    this.config.keywords[0], // targetTitle (e.g. "Verkäufer")
                    this.config.pensum       // targetPensum (e.g. "40%")
                );

                if (analysis.isRelevant) {
                    logger.info(`Job Match! Score: ${analysis.score}. Sending email.`);
                    await this.emailService.sendJobAlert(
                        job.title,
                        job.company,
                        job.url,
                        platform,
                        this.config.email || process.env.EMAIL_USER || "" // Fallback to sender if no email
                    );

                    // --- ResuMate Integration ---
                    await this.postToResuMate(job, details, platform, analysis.score);

                    const stableId = this.extractJobId(job.url);
                    this.history.addProcessed(stableId);
                    this.history.addProcessed(job.url);
                } else {
                    logger.info(`Job ignored by AI(Score ${analysis.score}): ${job.title} `);
                    const stableId = this.extractJobId(job.url);
                    this.history.addProcessed(stableId);
                    this.history.addProcessed(job.url);
                }
            } catch (error) {
                logger.error(`Error processing job ${job.title}: ${error} `);
            }
        }
    }

    private detailsPage: any;

    private async scrapeJobDetails(url: string, platform: string): Promise<{ description: string, salary?: string, location?: string, pensum?: string }> {
        try {
            await this.ensureBrowser(); // Ensure browser is alive

            // Reuse details page or create if missing
            if (!this.detailsPage || this.detailsPage.isClosed()) {
                this.detailsPage = await this.browser.newPage();
                // Random reliable UA
                await this.detailsPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            }

            const page = this.detailsPage;
            // Clear cookies/data? Maybe not needed if we want persistence.
            // Navigate
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

            await new Promise(r => setTimeout(r, 2000)); // Human pause reading

            const data = await page.evaluate((platform: string) => {
                let descSelector = '';
                let salarySelector = '';
                let locSelector = '';
                let pensumSelector = '';

                const normPlatform = platform.toLowerCase();

                if (normPlatform.includes('indeed')) {
                    descSelector = '#jobDescriptionText';
                    salarySelector = '#salaryInfoAndJobType, .salary-snippet-container';
                    locSelector = '[data-testid="inlineHeader-companyLocation"], .jobsearch-JobInfoHeader-subtitle > div:last-child';
                    pensumSelector = '#salaryInfoAndJobType > span:nth-child(2), [data-testid="job-type"]'; // heuristic
                }
                else if (normPlatform.includes('ziprecruiter')) {
                    descSelector = '.job_description, .job_content';
                    salarySelector = '.salary_text';
                    pensumSelector = '.job_details .employment_type';
                }
                else if (normPlatform.includes('weworkremotely')) {
                    descSelector = '.listing-container';
                    pensumSelector = '.listing-header-container .listing-tag'; // often contains "Full-Time"
                }

                const descEl = document.querySelector(descSelector);
                const salaryEl = salarySelector ? document.querySelector(salarySelector) : null;
                const locEl = locSelector ? document.querySelector(locSelector) : null;
                const pensumEl = pensumSelector ? document.querySelector(pensumSelector) : null;

                // Cleanup pensum text (remove dashes etc)
                let pensumRaw = pensumEl ? pensumEl.textContent?.trim() : undefined;
                if (pensumRaw && pensumRaw.startsWith('-')) pensumRaw = pensumRaw.substring(1).trim();

                return {
                    description: descEl ? descEl.textContent?.trim().substring(0, 5000) || '' : '',
                    salary: salaryEl ? salaryEl.textContent?.trim() : undefined,
                    location: locEl ? locEl.textContent?.trim() : undefined,
                    pensum: pensumRaw
                };
            }, platform);

            // Do NOT close page, we reuse it.
            return {
                description: data.description || "No description found.",
                salary: data.salary,
                location: data.location,
                pensum: data.pensum
            };

        } catch (error) {
            logger.warn(`Failed to scrape details for ${url}: ${error} `);
            // If error, maybe page is dead? Check.
            if (this.detailsPage && this.detailsPage.isClosed()) this.detailsPage = null; // Reset if closed
            return { description: "Failed to scrape description." };
        }
    }

    private async takeScreenshot(name: string) {
        try {
            const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
            if (!fs.existsSync(screenshotsDir)) {
                fs.mkdirSync(screenshotsDir, { recursive: true });
            }
            const filepath = path.join(screenshotsDir, `${name} -${Date.now()}.png`);
            if (this.page && !this.page.isClosed()) {
                await this.page.screenshot({ path: filepath, fullPage: false });
                logger.info(`Saved debug screenshot: ${filepath} `);
            }
        } catch (error) {
            logger.error(`Failed to take screenshot: ${error} `);
        }
    }

    private async searchIndeed(location: string) {
        logger.info(`Starting Indeed Job Search for ${location}...`);
        const query = this.config.keywords.join(' ');

        let allJobs: JobData[] = [];
        const MAX_PAGES = 5;

        for (let page = 0; page < MAX_PAGES; page++) {
            const startParam = page * 10;
            const url = `https://ch.indeed.com/jobs?q=${encodeURIComponent(query)}&l=${encodeURIComponent(location)}&start=${startParam}`;

            logger.info(`Scanning Indeed page ${page + 1}...`);

            try {
                await this.page.goto(url, { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000)); // Variable wait

                try {
                    await this.page.waitForSelector('#mosaic-provider-jobcards', { timeout: 10000 });
                } catch (e) {
                    logger.warn(`Indeed: Job list container not found on page ${page + 1}. Stopping pagination.`);
                    break;
                }

                const pageJobs = await this.page.evaluate(() => {
                    const results: any[] = [];
                    const cards = document.querySelectorAll('#mosaic-provider-jobcards ul > li');

                    cards.forEach(card => {
                        if (card.querySelector('.mosaic-zone')) return;

                        const titleEl = card.querySelector('h2.jobTitle') || card.querySelector('h2');

                        let companyEl = card.querySelector('[data-testid="company-name"]');
                        if (!companyEl) companyEl = card.querySelector('.companyName');
                        if (!companyEl) companyEl = card.querySelector('.company_location [class*="companyName"]');

                        let linkEl = card.querySelector('a.jcs-JobTitle');
                        if (!linkEl && titleEl) linkEl = titleEl.closest('a') || titleEl.querySelector('a');
                        if (!linkEl) linkEl = card.querySelector('a[id^="job_"]');

                        if (titleEl && linkEl) {
                            results.push({
                                title: titleEl.textContent?.trim(),
                                company: companyEl ? companyEl.textContent?.trim() : "Unknown Company (Indeed)",
                                url: (linkEl as HTMLAnchorElement).href
                            });
                        }
                    });
                    return results;
                });

                if (pageJobs.length === 0) {
                    logger.info("No jobs found on this page. Stopping pagination.");
                    break;
                }

                logger.info(`Found ${pageJobs.length} jobs on page ${page + 1}.`);
                allJobs = allJobs.concat(pageJobs);

                // Stop if we see duplicates relative to what we just found? 
                // No, rely on global de-dupe later. But if page yields 0 new jobs compared to prev, maybe stop?
                // For now, simple page count is safe.

            } catch (error) {
                logger.error(`Error scraping Indeed page ${page + 1}: ${error}`);
                break;
            }
        }

        return allJobs;
    }

    private async searchZipRecruiter(location: string) {
        logger.info(`Starting ZipRecruiter Search for ${location}...`);
        const query = this.config.keywords.join(' ');
        const url = `https://www.ziprecruiter.com/candidate/search?search=${encodeURIComponent(query)}&location=${encodeURIComponent(location)}`;

        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));

        try {
            await this.page.waitForSelector('.jobList-introWrap, article, .job_result', { timeout: 10000 });
        } catch (e) {
            logger.warn("ZipRecruiter: No results container found.");
            await this.takeScreenshot('ziprecruiter-blocked');
            return [];
        }

        return await this.page.evaluate(() => {
            const results: any[] = [];
            const cards = document.querySelectorAll('.jobList-introWrap, article, li.job-listing'); // UPDATED selector

            cards.forEach(card => {
                const titleEl = card.querySelector('.jobList-title') || card.querySelector('h2');

                // NEW: Updated ZipRecruiter structure (usually in metadata list)
                let companyEl = card.querySelector('.jobList-introMeta li');
                // Fallback
                if (!companyEl) companyEl = card.querySelector('.jobList-company') || card.querySelector('.t_org') || card.querySelector('.job_org');

                let linkEl = card.querySelector('a.jobList-title') || card.querySelector('a.job_link');

                if (titleEl && linkEl) {
                    results.push({
                        title: titleEl.textContent?.trim(),
                        company: companyEl ? companyEl.textContent?.trim() : "Unknown Company (Zip)",
                        url: (linkEl as HTMLAnchorElement).href
                    });
                }
            });
            return results;
        });
    }

    private async searchWeWorkRemotely(location: string) {
        logger.info(`Starting WWR Search for ${location}...`);
        const query = `${this.config.keywords.join(' ')} ${location}`;
        const url = `https://weworkremotely.com/remote-jobs/search?term=${encodeURIComponent(query)}`;

        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 2000));

        try {
            await this.page.waitForSelector('section.jobs, #job_list', { timeout: 10000 });
        } catch (e) {
            logger.warn("WeWorkRemotely: No jobs section found.");
            await this.takeScreenshot('wwr-blocked');
            return [];
        }

        return await this.page.evaluate(() => {
            const results: any[] = [];
            const cards = document.querySelectorAll('section.jobs li:not(.view-all)');

            cards.forEach(card => {
                const titleEl = card.querySelector('span.title');
                const companyEl = card.querySelector('span.company');

                const anchors = Array.from(card.querySelectorAll('a'));
                const linkEl = anchors.find(a => a.href.includes('/remote-jobs/')) || anchors[0];

                if (titleEl && linkEl) {
                    results.push({
                        title: titleEl.textContent?.trim(),
                        company: companyEl ? companyEl.textContent?.trim() : "We Work Remotely",
                        url: (linkEl as HTMLAnchorElement).href
                    });
                }
            });
            return results;
        });
    }
    private async postToResuMate(job: JobData, details: { description: string, salary?: string, location?: string, pensum?: string }, platform: string, score: number) {
        try {
            const apiUrl = process.env.RESUMATE_API_URL;
            const apiToken = process.env.RESUMATE_API_TOKEN;

            if (!apiUrl || !apiToken) {
                logger.warn("ResuMate API credentials missing. Skipping CRM upload.");
                return;
            }

            // Extraction Logic
            const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
            const phoneRegex = /(?:\+?\d{1,3}[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/g;
            const salaryRegex = /(\$[\d,]+(?:\s*-\s*\$[\d,]+)?\s*(?:yr|year|hr|hour|mo|month)?)|(\d+k\s*-\s*\d+k)/i;

            const emails = details.description.match(emailRegex) || [];
            const phones = details.description.match(phoneRegex) || [];

            // Prefer explicitly scraped salary, fallback to regex
            let salary = details.salary;
            if (!salary) {
                const salaryMatch = details.description.match(salaryRegex);
                salary = salaryMatch ? salaryMatch[0] : undefined;
            }

            // Prefer explicitly scraped location, fallback to search config
            const location = details.location || (Array.isArray(this.config.location) ? this.config.location.join(', ') : this.config.location);

            const payload: any = {
                title: job.title,
                company: job.company,
                url: job.url,
                location: location,
                description: details.description,
                salary: salary,
                pensum: details.pensum, // Added field
                source: platform,
                emails: [...new Set(emails)], // Deduplicate
                phones: [...new Set(phones)],
                aiScore: score,
            };

            if (this.currentTargetUserId) {
                payload.targetUserId = this.currentTargetUserId;
                logger.info(`   [Proxy Mode] Submitting for User ID: ${this.currentTargetUserId}`);
            }

            // Add Pensum if found
            if (details.pensum) {
                payload.pensum = details.pensum;
            } else if (this.config.pensum) {
                // Fallback to user preference pensum if extraction failed? 
                // Or maybe just leave it empty. Let's send extracted only for accuracy.
            }

            const logMsg = this.currentTargetUserId
                ? `Sending job to ResuMate CRM (Target: ${this.currentTargetUserId}): ${job.title}`
                : `Sending job to ResuMate CRM: ${job.title}`;

            logger.info(logMsg);

            await axios.post(apiUrl, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiToken
                }
            });

            logger.info("Job saved successfully to ResuMate.");

        } catch (error: any) {
            if (error.response) {
                if (error.response.status === 401) {
                    logger.error("ResuMate API Unauthorized: Check your token.");
                } else {
                    logger.error(`ResuMate API Error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
                }
            } else {
                logger.error(`Failed to post to ResuMate: ${error.message}`);
            }
        }
    }


}
