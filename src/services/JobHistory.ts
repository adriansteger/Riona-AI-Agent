import fs from 'fs';
import path from 'path';
import logger from '../config/logger';

interface Config {
    searched_jobs: string[];
}

export class JobHistory {
    private filePath: string;
    private history: Config;

    constructor() {
        this.filePath = path.resolve(__dirname, '../../data/job_history.json');
        this.ensureFile();
        this.history = this.loadHistory();
    }

    private ensureFile() {
        const dataDir = path.dirname(this.filePath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, JSON.stringify({ searched_jobs: [] }, null, 2));
        }
    }

    private loadHistory(): Config {
        try {
            const data = fs.readFileSync(this.filePath, 'utf-8');
            if (!data || data.trim() === '') {
                return { searched_jobs: [] };
            }
            return JSON.parse(data);
        } catch (error) {
            logger.error(`Failed to load job history: ${error}`);
            return { searched_jobs: [] };
        }
    }

    private saveHistory() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.history, null, 2));
        } catch (error) {
            logger.error(`Failed to save job history: ${error}`);
        }
    }

    isProcessed(limitId: string): boolean {
        // limitId can be URL or a hash of title+company
        return this.history.searched_jobs.includes(limitId);
    }

    addProcessed(limitId: string) {
        if (!this.isProcessed(limitId)) {
            this.history.searched_jobs.push(limitId);
            this.saveHistory();
        }
    }
}
