import fs from 'fs';
import path from 'path';
import axios from 'axios';
import logger from '../config/logger';

const AVATAR_DIR = path.join(process.cwd(), 'data', 'avatars');
const IG_APP_ID = '936619743392459';
const TTL_MS = 24 * 60 * 60 * 1000;
// After a failed lookup, wait before hitting Instagram again for the same account
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Caches each account's Instagram profile picture on disk and serves it from there.
 * Instagram CDN URLs expire and refuse cross-origin embedding, so the dashboard
 * never links to them directly.
 */
export class AvatarStore {
    private static instance: AvatarStore;
    private inflight = new Map<string, Promise<Buffer | null>>();
    private failedAt = new Map<string, number>();

    public static getInstance(): AvatarStore {
        if (!AvatarStore.instance) AvatarStore.instance = new AvatarStore();
        return AvatarStore.instance;
    }

    private filePath(accountId: string): string {
        return path.join(AVATAR_DIR, `${accountId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`);
    }

    /** Returns the cached JPEG, refreshing it from Instagram when stale. Null if unavailable. */
    public async get(accountId: string, username: string, proxy?: string): Promise<Buffer | null> {
        const file = this.filePath(accountId);
        if (this.isFresh(accountId)) return fs.readFileSync(file);

        const lastFail = this.failedAt.get(accountId);
        const backingOff = lastFail !== undefined && Date.now() - lastFail < FAILURE_BACKOFF_MS;
        if (!backingOff) {
            let job = this.inflight.get(accountId);
            if (!job) {
                job = this.download(accountId, username, proxy).finally(() => this.inflight.delete(accountId));
                this.inflight.set(accountId, job);
            }
            const data = await job;
            if (data) return data;
        }
        // Serve a stale copy rather than nothing
        return fs.existsSync(file) ? fs.readFileSync(file) : null;
    }

    /** True when a cached picture exists and is younger than the TTL. */
    public isFresh(accountId: string): boolean {
        const file = this.filePath(accountId);
        return fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < TTL_MS;
    }

    /** Downloads a known profile picture URL into the cache (used by logged-in bot sessions). */
    public async saveFromUrl(accountId: string, picUrl: string, proxy?: string): Promise<Buffer> {
        const img = await axios.get(picUrl, { ...this.requestBase(proxy), responseType: 'arraybuffer', headers: { 'User-Agent': UA } });
        const data = Buffer.from(img.data);
        fs.mkdirSync(AVATAR_DIR, { recursive: true });
        fs.writeFileSync(this.filePath(accountId), data);
        this.failedAt.delete(accountId);
        return data;
    }

    private requestBase(proxy?: string) {
        const httpsAgent = proxy ? new (require('https-proxy-agent').HttpsProxyAgent)(proxy) : undefined;
        return { timeout: 15000, httpsAgent, proxy: false as const };
    }

    // Logged-out fallback for accounts whose bot hasn't run yet; Instagram rate-limits this quickly
    private async download(accountId: string, username: string, proxy?: string): Promise<Buffer | null> {
        try {
            const info = await axios.get(
                `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
                { ...this.requestBase(proxy), headers: { 'x-ig-app-id': IG_APP_ID, 'User-Agent': UA, Accept: '*/*' } },
            );
            const user = info.data?.data?.user;
            const picUrl: string | undefined = user?.profile_pic_url_hd || user?.profile_pic_url;
            if (!picUrl) throw new Error('profile has no picture URL');
            return await this.saveFromUrl(accountId, picUrl, proxy);
        } catch (err: any) {
            this.failedAt.set(accountId, Date.now());
            logger.warn(`[AvatarStore] Could not fetch profile picture for @${username}: ${err.message}`);
            return null;
        }
    }
}
