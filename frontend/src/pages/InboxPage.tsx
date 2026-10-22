import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as Switch from '@radix-ui/react-switch';
import { MessageSquare, RefreshCw, Send, Sparkles, Bot } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { api, waitForTask } from '../api/client';
import type { DmMessage, DmThread, SanitizedAccount, TaskState } from '../api/client';

const POLL_MS = 30000;

const controlStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: '12px',
  backgroundColor: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-primary)',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  cursor: 'pointer',
};

const paneStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};

function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

const taskLabel: Record<TaskState, string> = {
  queued: 'Waiting for the bot session…',
  running: 'Opening Instagram…',
  done: 'Done',
  failed: 'Failed',
};

const Avatar: React.FC<{ thread: DmThread; size?: number }> = ({ thread, size = 36 }) => {
  const [broken, setBroken] = useState(false);
  const pic = thread.participants[0]?.profilePicUrl;
  const initials = (thread.title || '?').replace(/^@/, '').slice(0, 2).toUpperCase();
  const style: React.CSSProperties = {
    width: size, height: size, borderRadius: 'var(--radius-full)', flexShrink: 0,
    backgroundColor: 'var(--bg-surface-active)', color: 'var(--text-secondary)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.36, fontWeight: 600,
    objectFit: 'cover',
  };
  if (pic && !broken) {
    return <img src={pic} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} style={style} />;
  }
  return <div style={style}>{initials}</div>;
};

export const InboxPage: React.FC = () => {
  const { accountId: routeAccountId } = useParams();
  const navigate = useNavigate();

  const [accounts, setAccounts] = useState<SanitizedAccount[]>([]);
  const [threads, setThreads] = useState<DmThread[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<TaskState | null>(null);
  const [sendState, setSendState] = useState<TaskState | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const accountId = routeAccountId || accounts[0]?.id;
  const account = accounts.find(a => a.id === accountId);
  const selected = threads.find(t => t.threadId === selectedId) || null;

  useEffect(() => {
    api.getAccounts().then(r => setAccounts(r.accounts)).catch(e => setError(e.message));
  }, []);

  const loadThreads = useCallback(async () => {
    if (!accountId) return;
    try {
      const r = await api.getDmThreads(accountId);
      setThreads(r.threads);
      setLastSyncedAt(r.lastSyncedAt);
    } catch (e: any) {
      setError(e.message);
    }
  }, [accountId]);

  const loadMessages = useCallback(async () => {
    if (!accountId || !selectedId) return;
    try {
      const r = await api.getDmThread(accountId, selectedId);
      setMessages(r.messages);
    } catch (e: any) {
      setError(e.message);
    }
  }, [accountId, selectedId]);

  useEffect(() => {
    setSelectedId(null);
    setThreads([]);
    loadThreads();
    const t = setInterval(loadThreads, POLL_MS);
    return () => clearInterval(t);
  }, [loadThreads]);

  useEffect(() => {
    setMessages([]);
    setDraft('');
    loadMessages();
    const t = setInterval(loadMessages, POLL_MS);
    return () => clearInterval(t);
  }, [loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, pending]);

  const refreshInbox = async () => {
    if (!accountId) return;
    setError(null);
    try {
      const { taskId } = await api.refreshInbox(accountId);
      await waitForTask(taskId, t => setSyncState(t.status));
      await loadThreads();
      await loadMessages();
    } catch (e: any) {
      setError(`Inbox sync failed: ${e.message}`);
    } finally {
      setSyncState(null);
    }
  };

  const refreshThread = async () => {
    if (!accountId || !selectedId) return;
    setError(null);
    try {
      const { taskId } = await api.refreshDmThread(accountId, selectedId);
      await waitForTask(taskId, t => setSyncState(t.status));
      await loadMessages();
      await loadThreads();
    } catch (e: any) {
      setError(`Thread sync failed: ${e.message}`);
    } finally {
      setSyncState(null);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!accountId || !selectedId || !text || sendState || pending) return;
    setError(null);
    setPending(text);
    setDraft('');
    try {
      const { taskId } = await api.sendDm(accountId, selectedId, text);
      await waitForTask(taskId, t => setSendState(t.status));
      await loadMessages();
      await loadThreads();
    } catch (e: any) {
      setDraft(text);
      setError(`Message not sent: ${e.message}`);
    } finally {
      setPending(null);
      setSendState(null);
    }
  };

  const suggest = async () => {
    if (!accountId || !selectedId) return;
    setError(null);
    setSuggesting(true);
    try {
      const { suggestion } = await api.suggestDmReply(accountId, selectedId);
      if (suggestion) setDraft(suggestion);
      else setError('The persona chose not to reply to this message (looks like spam).');
    } catch (e: any) {
      setError(`Suggestion failed: ${e.message}`);
    } finally {
      setSuggesting(false);
    }
  };

  const toggleAi = async (aiEnabled: boolean) => {
    if (!accountId || !selected) return;
    setThreads(ts => ts.map(t => (t.threadId === selected.threadId ? { ...t, aiEnabled } : t)));
    try {
      await api.setDmThreadAi(accountId, selected.threadId, aiEnabled);
    } catch (e: any) {
      setError(e.message);
      loadThreads();
    }
  };

  const autoDmsOn = account?.settings?.behavior?.enableAutoDMs === true;
  const busy = syncState !== null;
  const syncedAgo = relativeTime(lastSyncedAt);
  const syncedLabel = !lastSyncedAt ? 'Never synced' : syncedAgo === 'just now' ? 'Synced just now' : `Synced ${syncedAgo} ago`;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />

      <main style={{ padding: '24px', flex: 1, maxWidth: '1400px', margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <MessageSquare size={20} color="var(--accent)" />
              Inbox
            </h1>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Read and answer direct messages. Sending opens the account's browser session, so it can take a moment.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <select
              value={accountId || ''}
              onChange={e => navigate(`/inbox/${e.target.value}`)}
              style={controlStyle}
              aria-label="Account"
            >
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.username === a.id ? a.id : `${a.id} (@${a.username})`}</option>
              ))}
            </select>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{busy ? taskLabel[syncState!] : syncedLabel}</span>
            <button style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }} disabled={busy || !accountId} onClick={refreshInbox}>
              <RefreshCw size={14} style={{ animation: busy ? 'spin 1s linear infinite' : undefined }} />
              Refresh inbox
            </button>
          </div>
        </div>

        {error && (
          <div style={{ marginBottom: '12px', padding: '8px 12px', fontSize: '13px', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--state-error-bg)', border: '1px solid var(--state-error-border)', color: 'var(--state-error)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: '12px', flex: 1, minHeight: 0 }}>
          {/* Thread list */}
          <div style={{ ...paneStyle, overflowY: 'auto' }}>
            {threads.length === 0 && (
              <div style={{ padding: '24px', fontSize: '13px', color: 'var(--text-secondary)', textAlign: 'center' }}>
                No conversations stored yet. Click <b>Refresh inbox</b> to load them from Instagram.
              </div>
            )}
            {threads.map(t => {
              const active = t.threadId === selectedId;
              return (
                <button
                  key={t.threadId}
                  onClick={() => setSelectedId(t.threadId)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', textAlign: 'left', width: '100%',
                    border: 'none', borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer',
                    backgroundColor: active ? 'var(--bg-surface-active)' : 'transparent', color: 'var(--text-primary)',
                  }}
                >
                  <Avatar thread={t} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: t.unread ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {t.title || t.participants[0]?.username || 'Conversation'}
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>{relativeTime(t.lastMessageAt)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                      <span style={{ fontSize: '12px', color: t.unread ? 'var(--text-primary)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {t.lastMessageFromMe ? 'You: ' : ''}{t.lastMessagePreview || ''}
                      </span>
                      {!t.aiEnabled && (
                        <span title="AI auto-reply is off for this thread" style={{ fontSize: '10px', padding: '1px 5px', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--state-stopped-bg)', color: 'var(--state-stopped)', flexShrink: 0 }}>
                          AI off
                        </span>
                      )}
                      {t.unread && <span aria-label="Unread" style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--state-sleeping)', flexShrink: 0 }} />}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Conversation */}
          <div style={paneStyle}>
            {!selected ? (
              <div style={{ margin: 'auto', fontSize: '13px', color: 'var(--text-secondary)' }}>Select a conversation</div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
                  <Avatar thread={selected} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>{selected.title}</div>
                    {selected.participants[0] && !selected.isGroup && (
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>@{selected.participants[0].username}</div>
                    )}
                  </div>

                  <label
                    title={autoDmsOn ? 'Let the persona answer new messages in this thread' : 'Auto-DMs are turned off for this account in its settings'}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-secondary)', opacity: autoDmsOn ? 1 : 0.6 }}
                  >
                    <Bot size={14} />
                    AI auto-reply
                    <Switch.Root
                      checked={selected.aiEnabled}
                      onCheckedChange={toggleAi}
                      style={{
                        width: 34, height: 20, borderRadius: 'var(--radius-full)', border: 'none', position: 'relative', cursor: 'pointer',
                        backgroundColor: selected.aiEnabled ? 'var(--state-running)' : 'var(--bg-surface-active)',
                      }}
                    >
                      <Switch.Thumb
                        style={{
                          display: 'block', width: 16, height: 16, borderRadius: '50%', backgroundColor: '#fff',
                          transition: 'transform 0.15s', transform: selected.aiEnabled ? 'translateX(16px)' : 'translateX(2px)',
                        }}
                      />
                    </Switch.Root>
                  </label>

                  <button style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={refreshThread} aria-label="Refresh conversation" title="Reload this conversation from Instagram">
                    <RefreshCw size={14} style={{ animation: busy ? 'spin 1s linear infinite' : undefined }} />
                  </button>
                </div>

                {!autoDmsOn && (
                  <div style={{ padding: '6px 14px', fontSize: '12px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                    Auto-DMs are off for this account, so the AI won't reply anywhere regardless of this switch.
                  </div>
                )}

                <div style={{ flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {messages.map(m => (
                    <div key={m._id} style={{ alignSelf: m.fromMe ? 'flex-end' : 'flex-start', maxWidth: '70%' }}>
                      <div
                        title={new Date(m.timestamp).toLocaleString()}
                        style={{
                          padding: '8px 12px', fontSize: '13px', lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          borderRadius: 'var(--radius-lg)',
                          backgroundColor: m.fromMe ? 'var(--accent)' : 'var(--bg-surface-elevated)',
                          color: m.fromMe ? 'var(--text-inverse)' : 'var(--text-primary)',
                          fontStyle: m.kind === 'text' || m.kind === 'link' ? 'normal' : 'italic',
                        }}
                      >
                        {m.text}
                      </div>
                    </div>
                  ))}
                  {pending && (
                    <div style={{ alignSelf: 'flex-end', maxWidth: '70%', textAlign: 'right' }}>
                      <div style={{ padding: '8px 12px', fontSize: '13px', whiteSpace: 'pre-wrap', borderRadius: 'var(--radius-lg)', backgroundColor: 'var(--accent)', color: 'var(--text-inverse)', opacity: 0.6 }}>
                        {pending}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sendState ? taskLabel[sendState] : 'Sending…'}</div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <div style={{ display: 'flex', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--border-subtle)', alignItems: 'flex-end' }}>
                  <textarea
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
                    rows={2}
                    maxLength={1000}
                    style={{
                      flex: 1, resize: 'vertical', padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit',
                      backgroundColor: 'var(--bg-canvas)', color: 'var(--text-primary)',
                      border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
                    }}
                  />
                  <button style={{ ...controlStyle, opacity: suggesting ? 0.6 : 1 }} disabled={suggesting} onClick={suggest} title="Draft a reply in the persona's voice">
                    <Sparkles size={14} />
                    {suggesting ? 'Thinking…' : 'Suggest'}
                  </button>
                  <button
                    onClick={send}
                    disabled={!draft.trim() || !!sendState || !!pending}
                    style={{ ...controlStyle, backgroundColor: 'var(--accent)', color: 'var(--text-inverse)', border: 'none', fontWeight: 600, opacity: !draft.trim() || sendState || pending ? 0.6 : 1 }}
                  >
                    <Send size={14} />
                    Send
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
