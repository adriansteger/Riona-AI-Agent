import fs from 'fs';
import path from 'path';

interface ScheduleLog {
    [accountId: string]: {
        nextActiveTime: number; // Timestamp of when the bot can become active again
    }
}

const LOG_FILE = path.join(process.cwd(), 'logs', 'schedule_history.json');

export class ScheduleTracker {
    private accountId: string;
    private data: ScheduleLog;

    constructor(accountId: string) {
        this.accountId = accountId;
        this.data = this.loadData();
    }

    private loadData(): ScheduleLog {
        try {
            if (!fs.existsSync(LOG_FILE)) {
                return {};
            }
            return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
        } catch (error) {
            console.error("Error loading schedule log:", error);
            return {};
        }
    }

    private saveData() {
        try {
            const dir = path.dirname(LOG_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(LOG_FILE, JSON.stringify(this.data, null, 2));
        } catch (error) {
            console.error("Error saving schedule log:", error);
        }
    }

    /**
       * Checks if the current local time is within the sleep window.
       * Supports sleep windows traversing midnight (e.g., 23 - 07).
       * @param sleepStartHour Hour to start sleeping (0-23)
       * @param sleepEndHour Hour to wake up (0-23)
       * @returns true if the bot should be sleeping
       */
    public static isSleepTime(sleepStartHour: number, sleepEndHour: number): boolean {
        const now = new Date();
        const currentHour = now.getHours();

        if (sleepStartHour > sleepEndHour) {
            // Sleep over midnight (e.g. 23:00 to 07:00)
            return currentHour >= sleepStartHour || currentHour < sleepEndHour;
        } else {
            // Sleep within the same day (e.g. 01:00 to 05:00)
            return currentHour >= sleepStartHour && currentHour < sleepEndHour;
        }
    }

    public getNextActiveTime(): number {
        this.data = this.loadData(); // Always reload to get updates from overlapping processes
        if (!this.data[this.accountId]) {
            return 0; // Can start immediately
        }
        return this.data[this.accountId].nextActiveTime || 0;
    }

    public setNextActiveTime(timestamp: number) {
        this.data = this.loadData();
        if (!this.data[this.accountId]) {
            this.data[this.accountId] = { nextActiveTime: 0 };
        }
        this.data[this.accountId].nextActiveTime = timestamp;
        this.saveData();
    }

    /**
       * Generate a random delay between a min and max amount of minutes.
       */
    public static getRandomDelayMs(minMinutes: number, maxMinutes: number): number {
        const minMs = minMinutes * 60 * 1000;
        const maxMs = maxMinutes * 60 * 1000;
        return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    }
}
