export interface SanitizedAccount {
  id: string;
  username: string;
  hasPassword: boolean;
  proxy?: string;
  character?: string;
  enabled: boolean;
  userDataDir?: string;
  settings?: {
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
  };
}

export type BotLifecycleState = 'running' | 'resting' | 'sleeping' | 'paused' | 'stopped' | 'disabled' | 'idle';

export interface AccountOverview {
  account: SanitizedAccount;
  state: BotLifecycleState;
  nextActiveTime: number;
  lastDMCheckTime: number;
  isSleeping: boolean;
  activeSession: boolean;
  activity: {
    likes1h: number;
    comments1h: number;
    dms1h: number;
    likesToday: number;
    commentsToday: number;
    dmsToday: number;
    likes24h: number;
    comments24h: number;
    dms24h: number;
  };
  lastError?: string;
  lastRunAt?: number;
}

export interface JobBotStatus {
  running: boolean;
  config: {
    id: string;
    enabled: boolean;
    preferences?: {
      platforms?: string[];
    };
    proxy?: string;
  } | null;
  lastRunAt?: number;
  lastError?: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  accountId: string;
}

export interface CharacterSummary {
  filename: string;
  name: string;
  sizeBytes: number;
  updatedAt: string;
}

const API_BASE = '/api/dashboard';

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('dash_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401 && !window.location.pathname.includes('/login')) {
    localStorage.removeItem('dash_token');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  // Auth
  async login(password: string) {
    const res = await request<{ success: boolean; token?: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    if (res.token) {
      localStorage.setItem('dash_token', res.token);
    }
    return res;
  },
  async logout() {
    localStorage.removeItem('dash_token');
    return request<{ success: boolean }>('/auth/logout', { method: 'POST' });
  },
  async me() {
    return request<{ authenticated: boolean }>('/auth/me');
  },

  // Overview
  async getOverview() {
    return request<{ accounts: AccountOverview[]; jobBot: JobBotStatus }>('/overview');
  },

  // Accounts
  async getAccounts() {
    return request<{ accounts: SanitizedAccount[] }>('/accounts');
  },
  async getAccount(id: string) {
    return request<{ account: SanitizedAccount }>(`/accounts/${id}`);
  },
  async createAccount(data: any) {
    return request<{ success: boolean; account: SanitizedAccount }>('/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  async updateAccount(id: string, data: any) {
    return request<{ success: boolean; account: SanitizedAccount }>(`/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async deleteAccount(id: string) {
    return request<{ success: boolean }>(`/accounts/${id}`, { method: 'DELETE' });
  },

  // Runtime Controls
  async startBot(id: string) {
    return request<{ success: boolean; message?: string }>(`/accounts/${id}/start`, { method: 'POST' });
  },
  async stopBot(id: string) {
    return request<{ success: boolean; message?: string }>(`/accounts/${id}/stop`, { method: 'POST' });
  },
  async pauseBot(id: string) {
    return request<{ success: boolean; message?: string }>(`/accounts/${id}/pause`, { method: 'POST' });
  },
  async resumeBot(id: string) {
    return request<{ success: boolean; message?: string }>(`/accounts/${id}/resume`, { method: 'POST' });
  },
  async restartBot(id: string) {
    return request<{ success: boolean; message?: string }>(`/accounts/${id}/restart`, { method: 'POST' });
  },

  // Logs
  async getLogs(id: string, date?: string, limit: number = 100) {
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    if (limit) q.set('limit', String(limit));
    return request<{ logs: LogEntry[] }>(`/logs/${id}?${q.toString()}`);
  },

  // Job Bot
  async getJobBot() {
    return request<JobBotStatus>('/jobbot');
  },
  async updateJobBot(data: { enabled?: boolean; platforms?: string[]; proxy?: string }) {
    return request<{ success: boolean; jobBot: JobBotStatus }>('/jobbot', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async startJobBot() {
    return request<{ success: boolean; message?: string }>('/jobbot/start', { method: 'POST' });
  },
  async stopJobBot() {
    return request<{ success: boolean; message?: string }>('/jobbot/stop', { method: 'POST' });
  },

  // Characters
  async listCharacters() {
    return request<{ characters: CharacterSummary[] }>('/characters');
  },
  async getCharacter(file: string) {
    return request<{ character: any }>(`/characters/${file}`);
  },
  async saveCharacter(file: string, data: any) {
    return request<{ success: boolean; message?: string }>(`/characters/${file}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async createCharacter(filename: string, data: any) {
    return request<{ success: boolean; message?: string }>('/characters', {
      method: 'POST',
      body: JSON.stringify({ filename, data }),
    });
  },
  async deleteCharacter(file: string) {
    return request<{ success: boolean }>(`/characters/${file}`, { method: 'DELETE' });
  },
};
