import fs from 'fs';
import path from 'path';
import logger from '../config/logger';

export interface AccountSettings {
    languages?: string[];
    defaultLanguage?: string;
    hashtags?: string[];
    hashtagMix?: number;
    behavior?: {
        enableLikes?: boolean;
        enableComments?: boolean;
        enableCommentLikes?: boolean;
        enableAutoDMs?: boolean;
    };
    limits?: {
        likesPerHour?: number;
        likesPerSession?: string | number;
        commentsPerHour?: number;
        dmsPerHour?: number;
    };
    schedule?: {
        sleepStartHour?: number;
        sleepEndHour?: number;
        minRestMinutes?: number;
        maxRestMinutes?: number;
        dmCheckIntervalMinutes?: number;
    };
    headless?: boolean;
}

export interface AccountConfig {
    id: string;
    username: string;
    password?: string;
    proxy?: string;
    character?: string;
    settings?: AccountSettings;
    userDataDir?: string;
    enabled: boolean;
}

export interface SanitizedAccountConfig extends Omit<AccountConfig, 'password'> {
    hasPassword: boolean;
}

export interface JobBotConfig {
    id: string;
    enabled: boolean;
    preferences?: {
        platforms?: string[];
    };
    proxy?: string;
}

export interface JobAccountsFile {
    jobBots: JobBotConfig[];
}

export class ConfigStore {
    private static instance: ConfigStore;
    private accountsFilePath: string;
    private jobAccountsFilePath: string;

    private constructor() {
        this.accountsFilePath = path.resolve(process.cwd(), 'src', 'config', 'accounts.json');
        this.jobAccountsFilePath = path.resolve(process.cwd(), 'src', 'config', 'job_accounts.json');
    }

    public static getInstance(): ConfigStore {
        if (!ConfigStore.instance) {
            ConfigStore.instance = new ConfigStore();
        }
        return ConfigStore.instance;
    }

    // --- ACCOUNTS LOGIC ---

    public getAccounts(): AccountConfig[] {
        try {
            if (!fs.existsSync(this.accountsFilePath)) {
                return [];
            }
            const raw = fs.readFileSync(this.accountsFilePath, 'utf-8');
            return JSON.parse(raw);
        } catch (error) {
            logger.error(`[ConfigStore] Error reading accounts from ${this.accountsFilePath}:`, error);
            return [];
        }
    }

    public getSanitizedAccounts(): SanitizedAccountConfig[] {
        return this.getAccounts().map(acc => this.sanitize(acc));
    }

    public getAccount(id: string): AccountConfig | undefined {
        return this.getAccounts().find(a => a.id === id);
    }

    public getSanitizedAccount(id: string): SanitizedAccountConfig | undefined {
        const acc = this.getAccount(id);
        return acc ? this.sanitize(acc) : undefined;
    }

    public upsertAccount(newAccountData: Partial<AccountConfig> & { id: string }): { success: boolean; account?: SanitizedAccountConfig; error?: string } {
        // Validate ID format
        if (!/^[a-zA-Z0-9_-]+$/.test(newAccountData.id)) {
            return { success: false, error: 'Account ID must contain only alphanumeric characters, underscores, or dashes.' };
        }

        const accounts = this.getAccounts();
        const existingIndex = accounts.findIndex(a => a.id === newAccountData.id);

        let finalAccount: AccountConfig;

        if (existingIndex >= 0) {
            const existing = accounts[existingIndex];
            finalAccount = {
                ...existing,
                ...newAccountData,
                // If password is not provided or empty string, preserve existing password
                password: (newAccountData.password && newAccountData.password.trim() !== '')
                    ? newAccountData.password
                    : existing.password,
                settings: {
                    ...existing.settings,
                    ...newAccountData.settings,
                    behavior: {
                        ...(existing.settings?.behavior || {}),
                        ...(newAccountData.settings?.behavior || {})
                    },
                    limits: {
                        ...(existing.settings?.limits || {}),
                        ...(newAccountData.settings?.limits || {})
                    },
                    schedule: {
                        ...(existing.settings?.schedule || {}),
                        ...(newAccountData.settings?.schedule || {})
                    }
                }
            };
            accounts[existingIndex] = finalAccount;
        } else {
            if (!newAccountData.username) {
                return { success: false, error: 'Username is required for new accounts.' };
            }
            finalAccount = {
                id: newAccountData.id,
                username: newAccountData.username,
                password: newAccountData.password || '',
                proxy: newAccountData.proxy || '',
                character: newAccountData.character || 'Ascotech.Agent.json',
                settings: newAccountData.settings || {
                    languages: ['English'],
                    defaultLanguage: 'English',
                    hashtags: [],
                    hashtagMix: 0.5,
                    behavior: {
                        enableLikes: true,
                        enableComments: false,
                        enableCommentLikes: false,
                        enableAutoDMs: false
                    },
                    limits: {
                        likesPerHour: 10,
                        likesPerSession: '3-6'
                    },
                    schedule: {
                        sleepStartHour: 23,
                        sleepEndHour: 7,
                        minRestMinutes: 60,
                        maxRestMinutes: 120,
                        dmCheckIntervalMinutes: 15
                    }
                },
                userDataDir: newAccountData.userDataDir || `./profiles/${newAccountData.id}`,
                enabled: newAccountData.enabled !== undefined ? newAccountData.enabled : false
            };
            accounts.push(finalAccount);
        }

        const saved = this.saveAccountsToFile(accounts);
        if (!saved) {
            return { success: false, error: 'Failed to write updated accounts to disk.' };
        }

        return { success: true, account: this.sanitize(finalAccount) };
    }

    public deleteAccount(id: string): { success: boolean; error?: string } {
        const accounts = this.getAccounts();
        const filtered = accounts.filter(a => a.id !== id);
        if (filtered.length === accounts.length) {
            return { success: false, error: 'Account not found.' };
        }

        const saved = this.saveAccountsToFile(filtered);
        if (!saved) {
            return { success: false, error: 'Failed to write updated accounts to disk.' };
        }
        return { success: true };
    }

    public sanitize(account: AccountConfig): SanitizedAccountConfig {
        const { password, ...rest } = account;
        return {
            ...rest,
            hasPassword: !!(password && password.trim() !== '')
        };
    }

    private saveAccountsToFile(accounts: AccountConfig[]): boolean {
        try {
            const content = JSON.stringify(accounts, null, 4);

            // 1. Write backup if file exists
            if (fs.existsSync(this.accountsFilePath)) {
                fs.copyFileSync(this.accountsFilePath, `${this.accountsFilePath}.bak`);
            }

            // 2. Atomic write to src/config/accounts.json
            const tmpFile = `${this.accountsFilePath}.tmp`;
            fs.writeFileSync(tmpFile, content, 'utf-8');
            fs.renameSync(tmpFile, this.accountsFilePath);

            // 3. Mirror write to build/config/accounts.json if it exists
            const buildPath = path.resolve(process.cwd(), 'build', 'config', 'accounts.json');
            if (fs.existsSync(path.dirname(buildPath))) {
                fs.writeFileSync(buildPath, content, 'utf-8');
            }

            return true;
        } catch (error) {
            logger.error('[ConfigStore] Failed to save accounts:', error);
            return false;
        }
    }

    // --- JOB ACCOUNTS LOGIC ---

    public getJobAccounts(): JobAccountsFile {
        try {
            if (!fs.existsSync(this.jobAccountsFilePath)) {
                return { jobBots: [] };
            }
            const raw = fs.readFileSync(this.jobAccountsFilePath, 'utf-8');
            return JSON.parse(raw);
        } catch (error) {
            logger.error(`[ConfigStore] Error reading job accounts from ${this.jobAccountsFilePath}:`, error);
            return { jobBots: [] };
        }
    }

    public updateJobBot(botId: string, updates: Partial<JobBotConfig>): { success: boolean; jobBot?: JobBotConfig; error?: string } {
        const data = this.getJobAccounts();
        const index = data.jobBots.findIndex(b => b.id === botId);
        if (index < 0) {
            return { success: false, error: 'Job Bot ID not found.' };
        }

        data.jobBots[index] = {
            ...data.jobBots[index],
            ...updates
        };

        const saved = this.saveJobAccountsToFile(data);
        if (!saved) {
            return { success: false, error: 'Failed to write updated job config to disk.' };
        }

        return { success: true, jobBot: data.jobBots[index] };
    }

    private saveJobAccountsToFile(data: JobAccountsFile): boolean {
        try {
            const content = JSON.stringify(data, null, 4);
            if (fs.existsSync(this.jobAccountsFilePath)) {
                fs.copyFileSync(this.jobAccountsFilePath, `${this.jobAccountsFilePath}.bak`);
            }
            const tmpFile = `${this.jobAccountsFilePath}.tmp`;
            fs.writeFileSync(tmpFile, content, 'utf-8');
            fs.renameSync(tmpFile, this.jobAccountsFilePath);

            const buildPath = path.resolve(process.cwd(), 'build', 'config', 'job_accounts.json');
            if (fs.existsSync(path.dirname(buildPath))) {
                fs.writeFileSync(buildPath, content, 'utf-8');
            }
            return true;
        } catch (error) {
            logger.error('[ConfigStore] Failed to save job accounts:', error);
            return false;
        }
    }
}
