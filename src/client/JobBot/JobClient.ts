import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
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

interface JobConfig {
    keywords: string[];
    location: string | string[];
    platforms: string[];
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

    constructor(emailService: EmailService, config: JobConfig) {
        this.emailService = emailService;
        this.config = config;
        this.analyzer = new JobAnalyzer();
        this.history = new JobHistory();

        // Check ResuMate connection eagerly (don't await in constructor)
        this.checkUserPreferences().catch(err => logger.warn(`ResuMate Check Failed: ${err.message}`));
    }

    private async checkUserPreferences() {
        const apiUrl = process.env.RESUMATE_API_URL;
        const apiKey = process.env.RESUMATE_API_TOKEN; // Using existing env var name for now

        if (!apiUrl || !apiKey) return;

        try {
            // Construct user-preferences URL: [API_URL]/../user-preferences
            // Assuming API_URL ends in /api/jobs, we want /api/user-preferences
            const prefsUrl = apiUrl.replace('/jobs', '/user-preferences');

            logger.info("Checking ResuMate User Preferences...");
            const response = await axios.get(prefsUrl, {
                headers: { 'x-api-key': apiKey }
            });

            if (response.data?.success) {
                const { firstName, tier } = response.data.data;
                logger.info(`ResuMate Connected: Hello ${firstName} (${tier} tier)`);
            }
        } catch (error: any) {
            logger.warn(`Failed to fetch ResuMate preferences: ${error.message}`);
        }
    }

    async init() {
        if (this.browser && this.browser.isConnected()) return;

        logger.info("Initializing Browser for Job Search...");
        this.browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                // Keep browser alive and active even when minimized/backgrounded
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ],
            ignoreHTTPSErrors: true
        } as any);

        this.browser.on('disconnected', () => {
            logger.warn("Browser disconnected/closed unexpectedly.");
        });

        this.page = await this.browser.newPage();
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
                await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            }
        } catch (e) {
            logger.error(`Failed to ensure browser: ${e}`);
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }

    async runSearch() {
        const locations = Array.isArray(this.config.location) ? this.config.location : [this.config.location];

        for (const location of locations) {
            logger.info(`--- Searching jobs in: ${location} ---`);

            for (const platform of this.config.platforms) {
                try {
                    await this.ensureBrowser();

                    let jobs: JobData[] = [];

                    switch (platform) {
                        case 'indeed':
                            jobs = await this.searchIndeed(location);
                            break;
                        case 'ziprecruiter':
                            jobs = await this.searchZipRecruiter(location);
                            break;
                        case 'weworkremotely':
                            jobs = await this.searchWeWorkRemotely(location);
                            break;
                        default:
                            logger.warn(`Unknown or unsupported platform: ${platform}`);
                    }

                    await this.processJobs(jobs, platform);

                } catch (error) {
                    logger.error(`Error running search for ${platform} in ${location}: ${error}`);
                    await this.close();
                }
            }
        }
    }

    private async processJobs(jobs: JobData[], platform: string) {
        logger.info(`Processing ${jobs.length} found jobs for ${platform}...`);

        for (const job of jobs) {
            if (this.history.isProcessed(job.url)) {
                logger.info(`Skipping duplicate job: ${job.title}`);
                continue;
            }

            // Deep Scrape: Visit the job page to get the description
            logger.info(`Visiting job page for details: ${job.title}...`);
            const description = await this.scrapeJobDetails(job.url, platform);

            // AI Analysis with FULL description
            logger.info(`Analyzing job with AI...`);
            const analysis = await this.analyzer.analyzeJob(job.title, job.company, description);

            if (analysis.isRelevant) {
                logger.info(`Job Match! Score: ${analysis.score}. Sending email.`);
                await this.emailService.sendJobAlert(
                    `${job.title} [AI Score: ${analysis.score}]`,
                    job.company,
                    job.url,
                    `${platform} (Summary: ${analysis.summary})`
                );

                // --- ResuMate Integration ---
                await this.postToResuMate(job, description, platform, analysis.score);

                this.history.addProcessed(job.url);
            } else {
                logger.info(`Job ignored by AI (Score ${analysis.score}): ${job.title}`);
                this.history.addProcessed(job.url);
            }
        }
    }

    private async scrapeJobDetails(url: string, platform: string): Promise<string> {
        let detailsPage: any;
        try {
            detailsPage = await this.browser.newPage();
            // Random reliable UA
            await detailsPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await detailsPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

            await new Promise(r => setTimeout(r, 2000)); // Human pause reading

            const description = await detailsPage.evaluate((platform: string) => {
                let selector = '';
                if (platform === 'indeed') selector = '#jobDescriptionText';
                else if (platform === 'ziprecruiter') selector = '.job_description, .job_content';
                else if (platform === 'weworkremotely') selector = '.listing-container';

                const el = document.querySelector(selector);
                return el ? el.textContent?.trim().substring(0, 3000) : ''; // Limit length for token saving
            }, platform);

            await detailsPage.close();
            return description || "No description found.";

        } catch (error) {
            logger.warn(`Failed to scrape details for ${url}: ${error}`);
            if (detailsPage && !detailsPage.isClosed()) await detailsPage.close();
            return "Failed to scrape description.";
        }
    }

    private async takeScreenshot(name: string) {
        try {
            const screenshotsDir = path.resolve(process.cwd(), 'screenshots');
            if (!fs.existsSync(screenshotsDir)) {
                fs.mkdirSync(screenshotsDir, { recursive: true });
            }
            const filepath = path.join(screenshotsDir, `${name}-${Date.now()}.png`);
            if (this.page && !this.page.isClosed()) {
                await this.page.screenshot({ path: filepath, fullPage: false });
                logger.info(`Saved debug screenshot: ${filepath}`);
            }
        } catch (error) {
            logger.error(`Failed to take screenshot: ${error}`);
        }
    }

    private async searchIndeed(location: string) {
        logger.info(`Starting Indeed Job Search for ${location}...`);
        const query = this.config.keywords.join(' ');
        const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(query)}&l=${encodeURIComponent(location)}`;

        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));

        try {
            await this.page.waitForSelector('#mosaic-provider-jobcards', { timeout: 10000 });
        } catch (e) {
            logger.warn("Indeed: Main job container not found.");
            await this.takeScreenshot('indeed-blocked');
            return [];
        }

        return await this.page.evaluate(() => {
            const results: any[] = [];
            const cards = document.querySelectorAll('#mosaic-provider-jobcards ul > li');

            cards.forEach(card => {
                if (card.querySelector('.mosaic-zone')) return;

                const titleEl = card.querySelector('h2.jobTitle') || card.querySelector('h2');

                // NEW: Use data-testid which is more stable
                let companyEl = card.querySelector('[data-testid="company-name"]');
                // Fallback to old selectors just in case
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
    private async postToResuMate(job: JobData, description: string, platform: string, score: number) {
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

            const emails = description.match(emailRegex) || [];
            const phones = description.match(phoneRegex) || [];
            const salaryMatch = description.match(salaryRegex);
            const salary = salaryMatch ? salaryMatch[0] : null;

            // Simple location extraction fallback
            const defaultLocation = Array.isArray(this.config.location) ? this.config.location.join(', ') : this.config.location;

            const payload = {
                title: job.title,
                company: job.company,
                url: job.url,
                location: defaultLocation,
                description: description,
                salary: salary,
                source: platform,
                emails: [...new Set(emails)], // Deduplicate
                phones: [...new Set(phones)],
                aiScore: score
            };

            logger.info(`Sending job to ResuMate CRM: ${job.title} at ${job.company}`);

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
