import fs from 'fs';
import path from 'path';
import * as puppeteer from 'puppeteer';

/**
 * Reads Instagram DMs through the GraphQL operations the web app itself uses (2026 "slide" protocol).
 * Everything runs inside the logged-in page, so requests carry the session's cookies and come from the
 * same origin. Reading never opens a thread, and marking read is a separate mutation we never send.
 *
 * Operation names, doc ids and response shapes follow mautrix's Instagram bridge:
 * https://github.com/mautrix/meta/tree/main/pkg/instameow (slidetypes, graphql.go) and
 * https://github.com/mautrix/meta/blob/main/pkg/messagix/graphql/docs.go
 */

export interface InboxMessage {
    itemId: string;
    fromMe: boolean;
    senderUsername?: string;
    text: string;
    kind: 'text' | 'media' | 'link' | 'other';
    timestamp: number; // ms
}

export interface InboxThread {
    threadId: string; // thread_key: the canonical id, used in /direct/t/<id>/ URLs and by the thread query
    threadFbid?: string; // thread_fbid: normally the chat's IG id; kept as an alternate id
    relayId?: string;
    title: string;
    participants: { username: string; fullName?: string; profilePicUrl?: string }[];
    isGroup: boolean;
    lastMessageAt: number; // ms
    lastMessagePreview?: string;
    lastMessageFromMe?: boolean;
    unread: boolean;
    messages: InboxMessage[];
    source: 'graphql';
}

export class GraphQLShapeError extends Error {
    constructor(public operation: string, public at: string) {
        super(`GraphQL ${operation} shape changed at ${at}`);
        this.name = 'GraphQLShapeError';
    }
}

const INBOX_OPERATION = 'PolarisDirectInboxQuery';
const THREAD_OPERATION = 'IGDThreadDetailQuery';
const TRACKED_OPERATION = /^(Polaris|IGD|useIGD)/;
const GRAPHQL_PATH = /\/(api\/graphql|graphql\/query)\/?(\?|$)/;
const DEFAULT_ENDPOINT = '/api/graphql';
const IG_APP_ID = '936619743392459';

// Fallbacks for when the web app hasn't sent an operation yet in this process; live ids from the page win
const DEFAULT_DOCS: Record<string, string> = {
    [INBOX_OPERATION]: '27262915580045003',
    [THREAD_OPERATION]: '37117700834487428',
};

const RELAY_FLAGS = {
    __relay_internal__pv__IGDIsProfessionalAccountGKrelayprovider: false,
    __relay_internal__pv__IGDPinnedThreadsRenderEnabledGKrelayprovider: true,
    __relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider: 5,
    __relay_internal__pv__PolarisAIGMAccountLabelEnabledrelayprovider: false,
    __relay_internal__pv__IGDThreadListActionsEnabledGKrelayprovider: true,
};

// Form fields that describe one specific operation; everything else in a captured request is session state we can reuse
const PER_OPERATION_FIELDS = new Set(['doc_id', 'variables', 'fb_api_req_friendly_name', 'fb_api_caller_class', 'server_timestamps', 'client_doc_id']);
const REUSABLE_HEADERS = ['x-asbd-id', 'x-fb-lsd', 'x-ig-app-id', 'x-ig-www-claim', 'x-bloks-version-id', 'x-requested-with'];

// ---------- Learned operations (shared by all accounts in this process) ----------

const DOCS_FILE = path.resolve(process.cwd(), 'data', 'ig_graphql_docs.json');

interface LearnedOperation { docId: string; endpoint: string; seenAt: string }

let learnedDocs: Record<string, LearnedOperation> | null = null;
const learnedVariables = new Map<string, any>(); // In memory only: variables contain thread ids

function loadLearnedDocs(): Record<string, LearnedOperation> {
    if (learnedDocs) return learnedDocs;
    try {
        learnedDocs = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf-8'));
    } catch {
        learnedDocs = {};
    }
    return learnedDocs!;
}

function recordOperation(name: string, docId: string, endpoint: string): void {
    const docs = loadLearnedDocs();
    if (docs[name]?.docId === docId && docs[name]?.endpoint === endpoint) return;
    docs[name] = { docId, endpoint, seenAt: new Date().toISOString() };
    try {
        fs.mkdirSync(path.dirname(DOCS_FILE), { recursive: true });
        fs.writeFileSync(DOCS_FILE, JSON.stringify(docs, null, 2));
    } catch {
        // Learning is best effort; the defaults still apply
    }
}

function operationFor(name: string): { docId?: string; endpoint: string } {
    const learned = loadLearnedDocs()[name];
    return { docId: learned?.docId || DEFAULT_DOCS[name], endpoint: learned?.endpoint || DEFAULT_ENDPOINT };
}

// ---------- Normalization ----------

function kindOf(contentType: string | undefined, hasText: boolean): InboxMessage['kind'] {
    const t = (contentType || '').toLowerCase();
    if (/link/.test(t)) return 'link';
    if (!t || /^text/.test(t)) return hasText ? 'text' : 'other';
    if (/photo|image|video|media|clip|reel|story|share|sticker|gif|audio|voice|animated/.test(t)) return 'media';
    return 'other';
}

function normalizeMessage(m: any, viewerFbid: string, viewerUsername: string, usernameByFbid: Map<string, string>): InboxMessage | null {
    const itemId = String(m.message_id || m.id || m.offline_threading_id || '');
    const timestamp = Number(m.timestamp_ms);
    if (!itemId || !timestamp) return null;

    const senderFbid = String(m.sender_fbid ?? m.sender?.id ?? '');
    const fromMe = !!viewerFbid && senderFbid === viewerFbid;
    const body = typeof m.text_body === 'string' ? m.text_body : '';
    const text = body || m.igd_snippet || (m.content_type ? `[${String(m.content_type).replace(/_/g, ' ').toLowerCase()}]` : '[message]');
    return {
        itemId,
        fromMe,
        senderUsername: fromMe ? viewerUsername : (usernameByFbid.get(senderFbid) || m.sender?.user_dict?.username || m.sender?.name),
        text,
        kind: kindOf(m.content_type, !!body),
        timestamp
    };
}

export function normalizeThread(t: any, viewerUsername: string, operation: string = THREAD_OPERATION): InboxThread {
    // The thread key is the id used in /direct/t/<id>/ URLs
    const threadId = String(t.thread_key ?? t.thread_fbid ?? '');
    if (!threadId) throw new GraphQLShapeError(operation, 'as_ig_direct_thread.thread_key');

    const viewerFbid = String(t.viewer?.interop_messaging_user_fbid ?? '');
    const users: any[] = (t.users || []).filter(Boolean);
    const usernameByFbid = new Map<string, string>(users.map(u => [String(u.interop_messaging_user_fbid), u.username]));
    const others = users.filter(u => String(u.interop_messaging_user_fbid ?? '') !== viewerFbid && u.username !== viewerUsername);

    const messages = (t.slide_messages?.edges || [])
        .map((e: any) => e?.node && normalizeMessage(e.node, viewerFbid, viewerUsername, usernameByFbid))
        .filter(Boolean)
        .sort((a: InboxMessage, b: InboxMessage) => a.timestamp - b.timestamp) as InboxMessage[];
    const last = messages[messages.length - 1];

    const myWatermark = Number((t.slide_read_receipts || []).find((r: any) => String(r.participant_fbid) === viewerFbid)?.watermark_timestamp_ms || 0);
    const unread = !!t.marked_as_unread || (myWatermark > 0 && messages.some(m => !m.fromMe && m.timestamp > myWatermark));

    return {
        threadId,
        threadFbid: t.thread_fbid ? String(t.thread_fbid) : undefined,
        relayId: t.id ? String(t.id) : undefined,
        title: t.thread_title || others.map(u => u.username).join(', ') || 'Conversation',
        participants: others.map(u => ({ username: u.username, fullName: u.full_name || undefined, profilePicUrl: u.profile_pic_url || undefined })),
        isGroup: !!t.is_group,
        lastMessageAt: Number(t.last_activity_timestamp_ms) || last?.timestamp || 0,
        lastMessagePreview: last?.text,
        lastMessageFromMe: last?.fromMe,
        unread,
        messages,
        source: 'graphql'
    };
}

export function normalizeMailbox(data: any, viewerUsername: string): InboxThread[] {
    const mailbox = data?.get_slide_mailbox_for_iris_subscription ?? data?.fetch__SlideMailbox;
    if (!mailbox) throw new GraphQLShapeError(INBOX_OPERATION, 'data.get_slide_mailbox_for_iris_subscription');
    const edges = mailbox.threads_by_folder?.edges;
    if (!Array.isArray(edges)) throw new GraphQLShapeError(INBOX_OPERATION, 'threads_by_folder.edges');

    const wrapped = [...(mailbox.pinned_threads_v2 || []), ...edges.map((e: any) => e?.node)];
    const threads: InboxThread[] = [];
    const seen = new Set<string>();
    for (const w of wrapped) {
        const t = w?.as_ig_direct_thread;
        if (!t) continue;
        const thread = normalizeThread(t, viewerUsername, INBOX_OPERATION);
        if (seen.has(thread.threadId)) continue;
        seen.add(thread.threadId);
        threads.push(thread);
    }
    return threads;
}

// Message fields sit about 12 levels deep in mailbox responses
const SHAPE_MAX_DEPTH = 16;

/** Keys and types only (no values), so a dump of a changed response can be shared without leaking messages. */
export function describeShape(value: any, depth: number = 0): any {
    if (value === null) return 'null';
    if (Array.isArray(value)) return value.length === 0 ? [] : [depth >= SHAPE_MAX_DEPTH ? '…' : describeShape(value[0], depth + 1)];
    if (typeof value !== 'object') return typeof value;
    if (depth >= SHAPE_MAX_DEPTH) return '{…}';
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).slice(0, 80)) out[key] = describeShape(value[key], depth + 1);
    return out;
}

function writeShapeDump(operation: string, data: any): string | null {
    try {
        const file = path.resolve(process.cwd(), 'logs', `dm_shape_${operation}_${Date.now()}.json`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(describeShape(data), null, 2));
        return file;
    } catch {
        return null;
    }
}

function parseForm(body: string): Record<string, string> {
    const form: Record<string, string> = {};
    new URLSearchParams(body).forEach((value, key) => { form[key] = value; });
    return form;
}

function parseGraphQLBody(text: string): any {
    return JSON.parse(text.replace(/^for \(;;\);/, ''));
}

// ---------- Client ----------

interface PageTokens { fb_dtsg?: string; lsd?: string; deviceId?: string; userId?: string }

export class IgDirectGraphQL {
    // Session form fields and headers from the web app's latest GraphQL request on this account's page
    private template: { form: Record<string, string>; headers: Record<string, string> } | null = null;
    private inboxResponse: any = null;
    private waitingForInbox = false;
    private inboxRequests = new WeakSet<puppeteer.HTTPRequest>();

    constructor(private logger: any, private viewerUsername: string) {}

    /** Watches the web app's own GraphQL traffic on a page: learns doc ids, variables and session fields. */
    attach(page: puppeteer.Page): void {
        page.on('request', (req) => {
            if (req.method() !== 'POST' || !GRAPHQL_PATH.test(req.url())) return;
            const handle = (body: string | undefined) => {
                if (!body) return;
                const form = parseForm(body);
                const name = form.fb_api_req_friendly_name;
                const endpoint = new URL(req.url()).pathname;
                if (name && TRACKED_OPERATION.test(name) && (form.doc_id || form.client_doc_id)) {
                    recordOperation(name, form.doc_id || form.client_doc_id, endpoint);
                    try { learnedVariables.set(name, JSON.parse(form.variables || '{}')); } catch { }
                }
                if (name === INBOX_OPERATION) this.inboxRequests.add(req);
                if (form.fb_dtsg) {
                    const reusable: Record<string, string> = {};
                    for (const [k, v] of Object.entries(form)) if (!PER_OPERATION_FIELDS.has(k)) reusable[k] = v;
                    const headers: Record<string, string> = {};
                    const reqHeaders = req.headers();
                    for (const h of REUSABLE_HEADERS) if (reqHeaders[h]) headers[h] = reqHeaders[h];
                    this.template = { form: reusable, headers };
                }
            };
            const body = req.postData();
            if (body) handle(body);
            else if (req.hasPostData()) req.fetchPostData().then(handle).catch(() => {});
        });

        page.on('response', (res) => {
            if (!this.waitingForInbox || !this.inboxRequests.has(res.request())) return;
            res.text()
                .then(text => {
                    const json = parseGraphQLBody(text);
                    if (json?.data) this.inboxResponse = json.data;
                })
                .catch(() => {});
        });
    }

    /**
     * Loads the inbox list. gotoInbox must navigate the page to /direct/inbox/; the web app then fetches the
     * mailbox itself and we read its response, so normally no extra request is sent.
     */
    async getInbox(page: puppeteer.Page, gotoInbox: () => Promise<void>): Promise<{ threads: InboxThread[]; via: string }> {
        this.inboxResponse = null;
        this.waitingForInbox = true;
        try {
            await gotoInbox();
            const deadline = Date.now() + 8000;
            while (!this.inboxResponse && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 250));
            }
        } finally {
            this.waitingForInbox = false;
        }

        let data = this.inboxResponse;
        let via = 'page request';
        if (!data) {
            data = await this.readPreloadedInbox(page);
            via = 'page preload';
        }
        if (!data) {
            const tokens = await this.readPageTokens(page);
            const variables = learnedVariables.get(INBOX_OPERATION) || { device_id_for_iris_subscription: tokens.deviceId, ...RELAY_FLAGS };
            if (!variables.device_id_for_iris_subscription) throw new Error('Could not find the inbox device id on the page.');
            data = await this.query(page, INBOX_OPERATION, variables);
            via = 'direct query';
        }

        try {
            return { threads: normalizeMailbox(data, this.viewerUsername), via };
        } catch (err) {
            if (err instanceof GraphQLShapeError) {
                const file = writeShapeDump(INBOX_OPERATION, data);
                if (file) this.logger.warn(`[DM Sync] Saved response structure (no values) to ${file}`);
            }
            throw err;
        }
    }

    /**
     * Loads one thread with its latest messages. Does not open or mark the thread read.
     * Despite the variable's name, the web app (and mautrix) pass the thread key as thread_fbid.
     */
    async getThread(page: puppeteer.Page, threadKey: string): Promise<InboxThread> {
        const learned = learnedVariables.get(THREAD_OPERATION);
        const variables = learned ? { ...learned, thread_fbid: threadKey } : {
            min_uq_seq_id: null,
            thread_fbid: threadKey,
            __relay_internal__pv__IGDEnableOffMsysChatThemesQErelayprovider: false,
            __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20,
            __relay_internal__pv__PolarisAIGMAccountLabelEnabledrelayprovider: false,
        };
        const data = await this.query(page, THREAD_OPERATION, variables);
        if (data && 'get_slide_thread_nullable' in data && !data.get_slide_thread_nullable) {
            throw new Error('Instagram returned no thread for this id.');
        }
        const thread = data?.get_slide_thread_nullable?.as_ig_direct_thread;
        try {
            if (!thread) throw new GraphQLShapeError(THREAD_OPERATION, 'data.get_slide_thread_nullable.as_ig_direct_thread');
            return normalizeThread(thread, this.viewerUsername);
        } catch (err) {
            if (err instanceof GraphQLShapeError) {
                const file = writeShapeDump(THREAD_OPERATION, data);
                if (file) this.logger.warn(`[DM Sync] Saved response structure (no values) to ${file}`);
            }
            throw err;
        }
    }

    private async query(page: puppeteer.Page, name: string, variables: any): Promise<any> {
        const { docId, endpoint } = operationFor(name);
        if (!docId) throw new Error(`No GraphQL doc id known for ${name}.`);

        let session: Record<string, string> | undefined = this.template?.form;
        if (!session) {
            const tokens = await this.readPageTokens(page);
            if (!tokens.fb_dtsg || !tokens.lsd) throw new Error('Could not find the session tokens (fb_dtsg/lsd) on the page.');
            const jazoest = '2' + Array.from(tokens.fb_dtsg).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
            session = { fb_dtsg: tokens.fb_dtsg, lsd: tokens.lsd, jazoest, __a: '1', __comet_req: '7', __user: '0', ...(tokens.userId ? { av: tokens.userId } : {}) };
        }
        const form: Record<string, string> = {
            ...session,
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: name,
            variables: JSON.stringify(variables),
            server_timestamps: 'true',
            doc_id: docId,
        };
        const headers: Record<string, string> = {
            'x-ig-app-id': IG_APP_ID,
            ...(this.template?.headers || {}),
            'content-type': 'application/x-www-form-urlencoded',
            'x-fb-friendly-name': name,
            ...(form.lsd ? { 'x-fb-lsd': form.lsd } : {}),
        };

        // No async/await in here: with the es6 target TypeScript emits an __awaiter helper that doesn't exist in the page
        const result = await page.evaluate((url, body, hdrs) => {
            const csrf = document.cookie.match(/(?:^|; )csrftoken=([^;]*)/)?.[1];
            if (csrf) hdrs['x-csrftoken'] = csrf;
            return fetch(url, { method: 'POST', credentials: 'include', headers: hdrs, body })
                .then(res => res.text().then(text => ({ status: res.status, text })))
                .catch(err => ({ status: 0, text: String(err) }));
        }, endpoint, new URLSearchParams(form).toString(), headers);

        if (result.status !== 200) {
            throw new Error(`GraphQL ${name} failed: ${result.status ? `HTTP ${result.status}` : result.text}`);
        }
        let json: any;
        try {
            json = parseGraphQLBody(result.text);
        } catch {
            throw new Error(`GraphQL ${name} failed: response was not JSON`);
        }
        if (json?.errors?.length) {
            throw new Error(`GraphQL ${name} failed: ${json.errors[0]?.message || json.errors[0]?.summary || 'unknown error'} (doc ${docId})`);
        }
        if (!json?.data) {
            throw new Error(`GraphQL ${name} failed: ${json?.error ? `error ${json.error} ${json.errorSummary || ''}`.trim() : 'no data'} (doc ${docId})`);
        }
        return json.data;
    }

    /** Session tokens from the page's inline config (Meta's ["Name", [], {...}] entries), with a regex fallback. */
    private async readPageTokens(page: puppeteer.Page): Promise<PageTokens> {
        return page.evaluate(() => {
            const wanted = ['DTSGInitialData', 'LSD', 'IGDMqttWebDeviceID', 'CurrentUserInitialData'];
            const found: Record<string, any> = {};
            const visit = (node: any, depth: number) => {
                if (depth > 60 || !node || typeof node !== 'object') return;
                if (Array.isArray(node)) {
                    if (typeof node[0] === 'string' && wanted.includes(node[0]) && Array.isArray(node[1]) && node[2] && typeof node[2] === 'object' && !found[node[0]]) {
                        found[node[0]] = node[2];
                    }
                    for (const child of node) visit(child, depth + 1);
                } else {
                    for (const key of Object.keys(node)) visit(node[key], depth + 1);
                }
            };
            document.querySelectorAll('script[type="application/json"]').forEach(s => {
                try { visit(JSON.parse(s.textContent || ''), 0); } catch { }
            });
            const html = document.documentElement.innerHTML;
            const rx = (re: RegExp) => html.match(re)?.[1];
            return {
                fb_dtsg: found.DTSGInitialData?.token || rx(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/),
                lsd: found.LSD?.token || rx(/"LSD",\[\],\{"token":"([^"]+)"/),
                deviceId: found.IGDMqttWebDeviceID?.clientID || rx(/"IGDMqttWebDeviceID",\[\],\{"clientID":"([^"]+)"/),
                userId: found.CurrentUserInitialData?.ACCOUNT_ID || found.CurrentUserInitialData?.USER_ID,
            };
        });
    }

    /** Mailbox data the server embedded in the page HTML (used when the web app didn't request it separately). */
    private async readPreloadedInbox(page: puppeteer.Page): Promise<any | null> {
        const json = await page.evaluate(() => {
            const key = 'get_slide_mailbox_for_iris_subscription';
            let result: any = null;
            const visit = (node: any, depth: number) => {
                if (result || depth > 80 || !node || typeof node !== 'object') return;
                if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, key) && node[key]) {
                    result = node;
                    return;
                }
                for (const child of Array.isArray(node) ? node : Object.values(node)) visit(child, depth + 1);
            };
            const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
            for (const s of scripts) {
                if (!(s.textContent || '').includes(key)) continue;
                try { visit(JSON.parse(s.textContent || ''), 0); } catch { }
                if (result) break;
            }
            return result ? JSON.stringify(result) : null;
        }).catch(() => null);
        return json ? JSON.parse(json) : null;
    }
}
