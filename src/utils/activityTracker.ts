import fs from 'fs';
import path from 'path';

interface ActivityLog {
    [accountId: string]: {
        likes: number[];    // Array of timestamps
        comments: number[]; // Array of timestamps
        dms: number[];      // Array of timestamps
    }
}

const LOG_FILE = path.join(process.cwd(), 'logs', 'activity_history.json');

export class ActivityTracker {
    private accountId: string;
    private data: ActivityLog;

    constructor(accountId: string) {
        this.accountId = accountId;
        this.data = this.loadData();
    }

    private loadData(): ActivityLog {
        try {
            if (!fs.existsSync(LOG_FILE)) {
                return {};
            }
            return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
        } catch (error) {
            console.error("Error loading activity log:", error);
            return {};
        }
    }

    private saveData() {
        try {
            const dir = path.dirname(LOG_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(LOG_FILE, JSON.stringify(this.data, null, 2));
        } catch (error) {
            console.error("Error saving activity log:", error);
        }
    }

    private getHistory(action: 'likes' | 'comments' | 'dms'): number[] {
        if (!this.data[this.accountId]) {
            this.data[this.accountId] = { likes: [], comments: [], dms: [] };
        }
        return this.data[this.accountId][action] || [];
    }

    private cleanOldEntries() {
        // Keep logs for 24 hours
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        if (this.data[this.accountId]) {
            this.data[this.accountId].likes = (this.data[this.accountId].likes || []).filter(t => t > cutoff);
            this.data[this.accountId].comments = (this.data[this.accountId].comments || []).filter(t => t > cutoff);
            this.data[this.accountId].dms = (this.data[this.accountId].dms || []).filter(t => t > cutoff);
        }
    }

    public canPerformAction(action: 'likes' | 'comments' | 'dms', limitPerHour: number): boolean {
        this.data = this.loadData(); // Reload to get latest from other processes
        this.cleanOldEntries();

        const history = this.getHistory(action);
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        const recentActions = history.filter(t => t > oneHourAgo);

        return recentActions.length < limitPerHour;
    }

    public trackAction(action: 'likes' | 'comments' | 'dms') {
        this.data = this.loadData();
        if (!this.data[this.accountId]) {
            this.data[this.accountId] = { likes: [], comments: [], dms: [] };
        }
        if (!this.data[this.accountId][action]) this.data[this.accountId][action] = [];
        this.data[this.accountId][action].push(Date.now());
        this.saveData();
    }

    public getRecentCount(action: 'likes' | 'comments' | 'dms'): number {
        this.data = this.loadData();
        const history = this.getHistory(action);
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        return history.filter(t => t > oneHourAgo).length;
    }
    public getTimeUntilAvailable(action: 'likes' | 'comments' | 'dms', limitPerHour: number): number {
        this.data = this.loadData();
        const history = this.getHistory(action);
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        const recentActions = history.filter(t => t > oneHourAgo);

        if (recentActions.length < limitPerHour) {
            return 0; // Available now
        }

        // Sort timestamps to be sure we get the oldest of the recent ones
        recentActions.sort((a, b) => a - b);

        // The slot will free up when the oldest action in the window falls out of the 1-hour window.
        // That happens at (oldest_timestamp + 1 hour).
        const oldestRelevantAction = recentActions[0];
        const nextSlotTime = oldestRelevantAction + 60 * 60 * 1000;
        const waitTime = nextSlotTime - Date.now();

        return waitTime > 0 ? waitTime : 0;
    }
}
