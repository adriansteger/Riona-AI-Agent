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
      likesPerDay?: number;
      likesPerDayJitter?: number;
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

export type StatsGranularity = 'hour' | 'day' | 'week' | 'month' | 'year';

export interface StatTotals {
  likes: number;
  comments: number;
  dms: number;
  posts: number;
  commentLikes: number;
  dmRequestsAccepted: number;
  spamRequestsDeleted: number;
  actionBlocks: number;
  rateLimits: number;
  challenges: number;
  errors: number;
  sessions: number;
  emptySessions: number;
  activeMinutes: number;
}

export interface StatsResponse {
  granularity: StatsGranularity;
  tz: string;
  from: string;
  to: string;
  buckets: Array<{ key: string } & StatTotals>;
  totals: StatTotals;
  previousTotals: StatTotals | null;
  perAccount: Array<{ accountId: string } & StatTotals>;
}

const API_BASE = '/api/dashboard';

export type TaskState = 'queued' | 'running' | 'done' | 'failed';

export interface TaskStatus {
  id: string;
  accountId: string;
  kind: string;
  status: TaskState;
  result?: any;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface DmThread {
  accountId: string;
  threadId: string;
  title: string;
  participants: Array<{ username: string; fullName?: string; profilePicUrl?: string }>;
  isGroup: boolean;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  lastMessageFromMe?: boolean;
  unread: boolean;
  aiEnabled: boolean;
  syncedAt?: string;
}

export interface DmMessage {
  _id: string;
  itemId: string;
  threadId: string;
  fromMe: boolean;
  senderUsername?: string;
  text: string;
  kind: 'text' | 'media' | 'link' | 'other';
  timestamp: string;
}

export type PostType = 'photo' | 'carousel' | 'reel';
export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

export interface ScheduledPost {
  _id: string;
  accountId: string;
  type: PostType;
  media: Array<{ file: string; mime: string; size: number }>;
  caption: string;
  scheduledAt?: string;
  status: PostStatus;
  attempts: number;
  lastError?: string;
  publishedAt?: string;
  permalink?: string;
  createdAt: string;
  updatedAt: string;
}

export const mediaUrl = (accountId: string, file: string) => `${API_BASE}/media/${encodeURIComponent(accountId)}/${encodeURIComponent(file)}`;

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

async function upload<T>(endpoint: string, form: FormData, method: string = 'POST'): Promise<T> {
  // No Content-Type header: the browser sets the multipart boundary itself
  const token = localStorage.getItem('dash_token');
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    body: form,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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

/** Polls a background browser task until it finishes. Rejects with the task's error if it failed. */
export async function waitForTask(taskId: string, onUpdate?: (task: TaskStatus) => void, intervalMs: number = 2000): Promise<TaskStatus> {
  for (;;) {
    const { task } = await request<{ task: TaskStatus }>(`/tasks/${taskId}`);
    onUpdate?.(task);
    if (task.status === 'done') return task;
    if (task.status === 'failed') throw new Error(task.error || 'Task failed');
    await new Promise(r => setTimeout(r, intervalMs));
  }
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
  avatarUrl(id: string) {
    return `${API_BASE}/accounts/${encodeURIComponent(id)}/avatar`;
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

  // DM Inbox
  async getDmThreads(accountId: string) {
    return request<{ threads: DmThread[]; lastSyncedAt: string | null }>(`/accounts/${accountId}/dms`);
  },
  async getDmThread(accountId: string, threadId: string) {
    return request<{ thread: DmThread; messages: DmMessage[] }>(`/accounts/${accountId}/dms/${encodeURIComponent(threadId)}`);
  },
  async refreshInbox(accountId: string) {
    return request<{ taskId: string }>(`/accounts/${accountId}/dms/refresh`, { method: 'POST' });
  },
  async refreshDmThread(accountId: string, threadId: string) {
    return request<{ taskId: string }>(`/accounts/${accountId}/dms/${encodeURIComponent(threadId)}/refresh`, { method: 'POST' });
  },
  async sendDm(accountId: string, threadId: string, text: string) {
    return request<{ taskId: string }>(`/accounts/${accountId}/dms/${encodeURIComponent(threadId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },
  async setDmThreadAi(accountId: string, threadId: string, aiEnabled: boolean) {
    return request<{ success: boolean; thread: DmThread }>(`/accounts/${accountId}/dms/${encodeURIComponent(threadId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ aiEnabled }),
    });
  },
  async suggestDmReply(accountId: string, threadId: string) {
    return request<{ suggestion: string }>(`/accounts/${accountId}/dms/${encodeURIComponent(threadId)}/suggest`, { method: 'POST' });
  },

  // Content planner
  async getPosts(accountId: string, params: { from?: string; to?: string } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<{ posts: ScheduledPost[] }>(`/accounts/${accountId}/posts?${qs.toString()}`);
  },
  async createPost(accountId: string, form: FormData) {
    return upload<{ success: boolean; post: ScheduledPost }>(`/accounts/${accountId}/posts`, form);
  },
  async updatePost(postId: string, data: { caption?: string; scheduledAt?: string | null; status?: 'draft' | 'scheduled'; mediaOrder?: string[] }) {
    return request<{ success: boolean; post: ScheduledPost }>(`/posts/${postId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
  async deletePost(postId: string) {
    return request<{ success: boolean }>(`/posts/${postId}`, { method: 'DELETE' });
  },
  async publishPostNow(postId: string) {
    return request<{ taskId: string }>(`/posts/${postId}/publish-now`, { method: 'POST' });
  },
  async generateCaption(accountId: string, brief: string, type: PostType) {
    return request<{ caption: string; hashtags: string[] }>(`/accounts/${accountId}/caption`, {
      method: 'POST',
      body: JSON.stringify({ brief, type }),
    });
  },

  // Statistics
  async getStats(params: { granularity: StatsGranularity; accountId?: string; from?: string; to?: string; prevFrom?: string; tz?: string }) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<StatsResponse>(`/stats?${qs.toString()}`);
  },
};
