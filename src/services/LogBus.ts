import { EventEmitter } from 'events';
import Transport from 'winston-transport';
import fs from 'fs';
import path from 'path';

export interface LogEntry {
    timestamp: string;
    level: string;
    message: string;
    accountId: string;
}

export class LogBus extends EventEmitter {
    private static instance: LogBus;
    private buffers: Map<string, LogEntry[]> = new Map();
    private readonly MAX_BUFFER_SIZE = 500;

    private constructor() {
        super();
        this.setMaxListeners(100);
    }

    public static getInstance(): LogBus {
        if (!LogBus.instance) {
            LogBus.instance = new LogBus();
        }
        return LogBus.instance;
    }

    public pushLog(entry: LogEntry): void {
        const key = entry.accountId || 'system';
        let buf = this.buffers.get(key);
        if (!buf) {
            buf = [];
            this.buffers.set(key, buf);
        }

        buf.push(entry);
        if (buf.length > this.MAX_BUFFER_SIZE) {
            buf.shift();
        }

        // Emit targeted and global events
        this.emit(`log:${key}`, entry);
        this.emit('log:*', entry);
    }

    public getRecentLogs(accountId?: string, limit: number = 100): LogEntry[] {
        const key = accountId || 'system';
        const buf = this.buffers.get(key) || [];
        return buf.slice(-limit);
    }

    public getHistoricalLogs(accountId: string, dateStr?: string, limit: number = 200): LogEntry[] {
        // If no date specified, default to today's date YYYY-MM-DD
        const targetDate = dateStr || new Date().toISOString().split('T')[0];
        const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, '_');
        
        let logFilePath: string;
        if (accountId === 'system') {
            logFilePath = path.join(process.cwd(), 'logs', 'system', `${targetDate}-combined.log`);
        } else {
            logFilePath = path.join(process.cwd(), 'logs', 'accounts', safeId, `${targetDate}.log`);
        }

        if (!fs.existsSync(logFilePath)) {
            // Fall back to in-memory recent logs if file doesn't exist yet
            return this.getRecentLogs(accountId, limit);
        }

        try {
            const content = fs.readFileSync(logFilePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            const parsed: LogEntry[] = [];

            for (const line of lines) {
                try {
                    const json = JSON.parse(line);
                    parsed.push({
                        timestamp: json.timestamp || new Date().toISOString(),
                        level: json.level || 'info',
                        message: json.message || '',
                        accountId
                    });
                } catch {
                    parsed.push({
                        timestamp: new Date().toISOString(),
                        level: 'info',
                        message: line,
                        accountId
                    });
                }
            }

            return parsed.slice(-limit);
        } catch (error) {
            console.error(`[LogBus] Failed to read log file ${logFilePath}:`, error);
            return this.getRecentLogs(accountId, limit);
        }
    }
}

export interface LogBusTransportOptions extends Transport.TransportStreamOptions {
    accountId: string;
}

export class LogBusTransport extends Transport {
    private accountId: string;
    private bus: LogBus;

    constructor(opts: LogBusTransportOptions) {
        super(opts);
        this.accountId = opts.accountId;
        this.bus = LogBus.getInstance();
    }

    public log(info: any, callback: () => void): void {
        setImmediate(() => {
            this.emit('logged', info);
        });

        const entry: LogEntry = {
            timestamp: info.timestamp || new Date().toISOString(),
            level: info.level ? String(info.level).replace(/\u001b\[[0-9;]*m/g, '') : 'info',
            message: typeof info.message === 'string' ? info.message : JSON.stringify(info.message),
            accountId: this.accountId
        };

        this.bus.pushLog(entry);
        callback();
    }
}
