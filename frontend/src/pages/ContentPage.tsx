import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import {
  CalendarDays, ChevronLeft, ChevronRight, Plus, Image as ImageIcon, Images, Film, Sparkles, X, ArrowLeft, ArrowRight,
  ExternalLink, Trash2, AlertTriangle,
} from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { api, mediaUrl, waitForTask } from '../api/client';
import type { PostStatus, PostType, SanitizedAccount, ScheduledPost, TaskState } from '../api/client';

const POLL_MS = 20000;
const MAX_CAPTION = 2200;
const BUSY_DAY_POSTS = 3;
const ACCEPT = 'image/jpeg,image/png,video/mp4,video/quicktime';

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

const primaryStyle: React.CSSProperties = {
  ...controlStyle,
  backgroundColor: 'var(--accent)',
  color: 'var(--text-inverse)',
  border: 'none',
  fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: '13px',
  fontFamily: 'inherit',
  backgroundColor: 'var(--bg-canvas)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px', display: 'block',
};

const STATUS_STYLE: Record<PostStatus, { label: string; color: string; bg: string }> = {
  draft: { label: 'Draft', color: 'var(--state-stopped)', bg: 'var(--state-stopped-bg)' },
  scheduled: { label: 'Scheduled', color: 'var(--state-sleeping)', bg: 'var(--state-sleeping-bg)' },
  publishing: { label: 'Publishing', color: 'var(--state-resting)', bg: 'var(--state-resting-bg)' },
  published: { label: 'Published', color: 'var(--state-running)', bg: 'var(--state-running-bg)' },
  failed: { label: 'Failed', color: 'var(--state-error)', bg: 'var(--state-error-bg)' },
};

const TYPE_ICON: Record<PostType, React.ReactNode> = {
  photo: <ImageIcon size={12} />,
  carousel: <Images size={12} />,
  reel: <Film size={12} />,
};
const TYPE_LABEL: Record<PostType, string> = { photo: 'Photo', carousel: 'Carousel', reel: 'Reel' };

const taskLabel: Record<TaskState, string> = {
  queued: 'Waiting for the bot session…',
  running: 'Uploading to Instagram…',
  done: 'Published',
  failed: 'Failed',
};

// ---------- Dates (browser-local) ----------

function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7)); // Monday
  return r;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Value for <input type="datetime-local">, in local time. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const postDate = (p: ScheduledPost) => (p.publishedAt || p.scheduledAt ? new Date((p.publishedAt || p.scheduledAt)!) : null);
const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// ---------- Pieces ----------

const StatusBadge: React.FC<{ status: PostStatus }> = ({ status }) => {
  const s = STATUS_STYLE[status];
  return (
    <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--radius-sm)', color: s.color, backgroundColor: s.bg, fontWeight: 600 }}>
      {s.label}
    </span>
  );
};

const MediaThumb: React.FC<{ src: string; video: boolean; size?: number | string }> = ({ src, video, size = '100%' }) => {
  const style: React.CSSProperties = { width: size, height: size, objectFit: 'cover', borderRadius: 'var(--radius-sm)', display: 'block', backgroundColor: 'var(--bg-canvas)' };
  return video
    ? <video src={src} muted preload="metadata" style={style} />
    : <img src={src} alt="" style={style} />;
};

const PostCard: React.FC<{ post: ScheduledPost; onOpen: () => void }> = ({ post, onOpen }) => {
  const first = post.media[0];
  const when = postDate(post);
  return (
    <button
      onClick={onOpen}
      title={post.lastError || post.caption}
      style={{
        display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px', width: '100%', textAlign: 'left', cursor: 'pointer',
        backgroundColor: 'var(--bg-surface-elevated)', border: `1px solid ${post.status === 'failed' ? 'var(--state-error-border)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
      }}
    >
      {first && (
        <div style={{ aspectRatio: '1 / 1', width: '100%' }}>
          <MediaThumb src={mediaUrl(post.accountId, first.file)} video={first.mime.startsWith('video/')} />
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)' }}>
        {TYPE_ICON[post.type]}
        {when ? fmtTime(when) : 'No date'}
        <span style={{ marginLeft: 'auto' }}><StatusBadge status={post.status} /></span>
      </div>
      {post.caption && (
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {post.caption}
        </div>
      )}
    </button>
  );
};

// ---------- Editor ----------

type EditorMedia = { key: string; src: string; video: boolean; file?: File; serverFile?: string };

interface EditorProps {
  accountId: string;
  post: ScheduledPost | null; // null = new post
  defaultDate: Date | null;
  onClose: () => void;
  onChanged: () => void;
}

const PostEditor: React.FC<EditorProps> = ({ accountId, post, defaultDate, onClose, onChanged }) => {
  const locked = post?.status === 'publishing' || post?.status === 'published';
  const [media, setMedia] = useState<EditorMedia[]>(() =>
    post ? post.media.map(m => ({ key: m.file, src: mediaUrl(accountId, m.file), video: m.mime.startsWith('video/'), serverFile: m.file })) : []
  );
  const [caption, setCaption] = useState(post?.caption || '');
  const [when, setWhen] = useState(() => {
    const d = post?.scheduledAt ? new Date(post.scheduledAt) : defaultDate;
    return d ? toLocalInput(d) : '';
  });
  const [brief, setBrief] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishState, setPublishState] = useState<TaskState | null>(null);
  const [error, setError] = useState<string | null>(post?.status === 'failed' ? post.lastError || 'Publishing failed.' : null);
  const [dragOver, setDragOver] = useState(false);

  // Free object URLs of local previews
  useEffect(() => () => media.forEach(m => m.file && URL.revokeObjectURL(m.src)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const type: PostType | null = media.length === 0 ? null : media.length > 1 ? 'carousel' : media[0].video ? 'reel' : 'photo';
  const hashtagCount = (caption.match(/#[\p{L}\p{N}_]+/gu) || []).length;

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const accepted = Array.from(files).filter(f => ACCEPT.split(',').includes(f.type));
    if (accepted.length < files.length) setError('Some files were skipped. Use JPEG, PNG, MP4 or MOV.');
    setMedia(m => [...m, ...accepted.map(f => ({ key: `${f.name}-${f.size}-${Math.random()}`, src: URL.createObjectURL(f), video: f.type.startsWith('video/'), file: f }))].slice(0, 10));
  };

  const move = (i: number, dir: -1 | 1) => setMedia(m => {
    const j = i + dir;
    if (j < 0 || j >= m.length) return m;
    const next = [...m];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const remove = (i: number) => setMedia(m => {
    const item = m[i];
    if (item.file) URL.revokeObjectURL(item.src);
    return m.filter((_, k) => k !== i);
  });

  const generate = async () => {
    if (!brief.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const r = await api.generateCaption(accountId, brief, type || 'photo');
      setCaption([r.caption, r.hashtags.join(' ')].filter(Boolean).join('\n\n').slice(0, MAX_CAPTION));
    } catch (e: any) {
      setError(`Caption generation failed: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  };

  /** Creates or updates the post; returns its id. */
  const save = async (status: 'draft' | 'scheduled'): Promise<string> => {
    const scheduledAt = when ? new Date(when).toISOString() : null;
    if (status === 'scheduled' && !scheduledAt) throw new Error('Pick a date and time to schedule the post.');
    if (status === 'scheduled' && new Date(scheduledAt!).getTime() < Date.now() - 60000) throw new Error('That time is in the past. Use "Post now" instead.');

    if (post) {
      const r = await api.updatePost(post._id, {
        caption,
        scheduledAt,
        status,
        mediaOrder: media.map(m => m.serverFile!),
      });
      return r.post._id;
    }
    const form = new FormData();
    media.forEach(m => form.append('files', m.file!));
    form.append('caption', caption);
    form.append('status', status);
    if (scheduledAt) form.append('scheduledAt', scheduledAt);
    const r = await api.createPost(accountId, form);
    return r.post._id;
  };

  const run = async (action: 'draft' | 'scheduled' | 'now') => {
    if (media.length === 0) return setError('Add at least one photo or video.');
    if (caption.length > MAX_CAPTION) return setError(`Caption is longer than ${MAX_CAPTION} characters.`);
    setSaving(true);
    setError(null);
    try {
      const id = await save(action === 'now' ? 'draft' : action);
      onChanged();
      if (action === 'now') {
        const { taskId } = await api.publishPostNow(id);
        setPublishState('queued');
        await waitForTask(taskId, t => setPublishState(t.status));
        onChanged();
      }
      onClose();
    } catch (e: any) {
      setError(e.message);
      setPublishState(null);
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!post || !window.confirm('Delete this post and its media?')) return;
    try {
      await api.deletePost(post._id);
      onChanged();
      onClose();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const busy = saving || publishState !== null;

  return (
    <Dialog.Portal>
      <Dialog.Overlay style={{ position: 'fixed', inset: 0, backgroundColor: 'var(--overlay)', zIndex: 100 }} />
      <Dialog.Content
        onInteractOutside={e => busy && e.preventDefault()}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 101,
          width: 'min(760px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
          backgroundColor: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-modal)', padding: '20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
          <Dialog.Title style={{ fontSize: '16px', fontWeight: 700, flex: 1 }}>
            {post ? 'Edit post' : 'New post'}
            {type && <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', marginLeft: '8px' }}>{TYPE_LABEL[type]}</span>}
          </Dialog.Title>
          {post && <StatusBadge status={post.status} />}
          <Dialog.Close asChild>
            <button aria-label="Close" disabled={busy} style={{ ...controlStyle, border: 'none', marginLeft: '8px' }}><X size={16} /></button>
          </Dialog.Close>
        </div>
        <Dialog.Description style={{ display: 'none' }}>Upload media, write a caption and choose when to publish.</Dialog.Description>

        {/* Media */}
        <span style={labelStyle}>Media {media.length > 0 && `(${media.length}/10)`}</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '8px', marginBottom: '8px' }}>
          {media.map((m, i) => (
            <div key={m.key} style={{ position: 'relative', aspectRatio: '1 / 1' }}>
              <MediaThumb src={m.src} video={m.video} />
              {m.video && <Film size={14} style={{ position: 'absolute', top: 6, left: 6, color: '#fff' }} />}
              {!locked && (
                <div style={{ position: 'absolute', bottom: 4, left: 4, right: 4, display: 'flex', gap: '4px', justifyContent: 'space-between' }}>
                  <button aria-label="Move left" onClick={() => move(i, -1)} disabled={i === 0} style={{ ...controlStyle, padding: '3px', opacity: i === 0 ? 0.4 : 0.9 }}><ArrowLeft size={12} /></button>
                  {!post && <button aria-label="Remove" onClick={() => remove(i)} style={{ ...controlStyle, padding: '3px', opacity: 0.9 }}><X size={12} /></button>}
                  <button aria-label="Move right" onClick={() => move(i, 1)} disabled={i === media.length - 1} style={{ ...controlStyle, padding: '3px', opacity: i === media.length - 1 ? 0.4 : 0.9 }}><ArrowRight size={12} /></button>
                </div>
              )}
            </div>
          ))}
          {!post && media.length < 10 && (
            <label
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
              style={{
                aspectRatio: '1 / 1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px',
                border: `1px dashed ${dragOver ? 'var(--accent)' : 'var(--border-prominent)'}`, borderRadius: 'var(--radius-md)',
                fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer', textAlign: 'center', padding: '8px',
              }}
            >
              <Plus size={18} />
              Add photos or videos
              <input type="file" accept={ACCEPT} multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
          )}
        </div>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px' }}>
          {post ? 'Media can be reordered. To change files, create a new post.' : 'One image is a photo post, several files make a carousel, a single video becomes a Reel. JPEG/PNG up to 30 MB, MP4/MOV up to 300 MB.'}
        </p>

        {/* AI caption */}
        {!locked && (
          <>
            <span style={labelStyle}>Write with AI</span>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <input
                value={brief}
                onChange={e => setBrief(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && generate()}
                placeholder="What is this post about? e.g. sunset run along the lake, new personal best"
                style={inputStyle}
              />
              <button onClick={generate} disabled={generating || !brief.trim()} style={{ ...controlStyle, flexShrink: 0, opacity: generating || !brief.trim() ? 0.6 : 1 }}>
                <Sparkles size={14} />
                {generating ? 'Writing…' : 'Generate'}
              </button>
            </div>
          </>
        )}

        {/* Caption */}
        <span style={labelStyle}>Caption</span>
        <textarea
          value={caption}
          onChange={e => setCaption(e.target.value)}
          readOnly={locked}
          rows={7}
          placeholder="Write a caption…"
          style={{ ...inputStyle, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginTop: '4px', marginBottom: '16px', color: 'var(--text-muted)' }}>
          <span style={{ color: hashtagCount > 30 ? 'var(--state-error)' : undefined }}>{hashtagCount} hashtag{hashtagCount === 1 ? '' : 's'}{hashtagCount > 30 && ' (Instagram allows 30)'}</span>
          <span style={{ color: caption.length > MAX_CAPTION ? 'var(--state-error)' : undefined }}>{caption.length}/{MAX_CAPTION}</span>
        </div>

        {/* Schedule */}
        {!locked && (
          <>
            <span style={labelStyle}>Publish at</span>
            <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} style={{ ...inputStyle, width: 'auto', colorScheme: 'dark', marginBottom: '16px' }} />
          </>
        )}

        {post?.permalink && (
          <a href={post.permalink} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--accent)', marginBottom: '16px' }}>
            <ExternalLink size={14} /> View on Instagram
          </a>
        )}

        {error && (
          <div style={{ marginBottom: '12px', padding: '8px 12px', fontSize: '13px', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--state-error-bg)', border: '1px solid var(--state-error-border)', color: 'var(--state-error)' }}>
            {error}
          </div>
        )}

        {!locked && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {post && (
              <button onClick={del} disabled={busy} style={{ ...controlStyle, color: 'var(--state-error)' }}>
                <Trash2 size={14} /> Delete
              </button>
            )}
            <span style={{ flex: 1, fontSize: '12px', color: 'var(--text-secondary)' }}>{publishState && taskLabel[publishState]}</span>
            <button onClick={() => run('draft')} disabled={busy} style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}>Save draft</button>
            <button onClick={() => run('now')} disabled={busy} style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}>Post now</button>
            <button onClick={() => run('scheduled')} disabled={busy || !when} style={{ ...primaryStyle, opacity: busy || !when ? 0.6 : 1 }}>
              <CalendarDays size={14} /> Schedule
            </button>
          </div>
        )}
        {post?.status === 'published' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={del} style={{ ...controlStyle, color: 'var(--text-secondary)' }} title="Removes it from the planner only, not from Instagram">
              <Trash2 size={14} /> Remove from planner
            </button>
          </div>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  );
};

// ---------- Page ----------

export const ContentPage: React.FC = () => {
  const { accountId: routeAccountId } = useParams();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<SanitizedAccount[]>([]);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [editor, setEditor] = useState<{ post: ScheduledPost | null; date: Date | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountId = routeAccountId || accounts[0]?.id;
  const weekStart = useMemo(() => addDays(startOfWeek(new Date()), weekOffset * 7), [weekOffset]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  useEffect(() => {
    api.getAccounts().then(r => setAccounts(r.accounts)).catch(e => setError(e.message));
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      const r = await api.getPosts(accountId, { from: weekStart.toISOString(), to: addDays(weekStart, 7).toISOString() });
      setPosts(r.posts);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [accountId, weekStart]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const unscheduled = posts.filter(p => !postDate(p));
  const postsOn = (day: Date) => posts
    .filter(p => { const d = postDate(p); return d && sameDay(d, day); })
    .sort((a, b) => postDate(a)!.getTime() - postDate(b)!.getTime());
  const busyDays = days.filter(d => postsOn(d).filter(p => p.status !== 'draft' && p.status !== 'failed').length > BUSY_DAY_POSTS);

  const today = new Date();
  const weekTitle = `${weekStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${addDays(weekStart, 6).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const newPostAt = (day: Date) => {
    const d = new Date(day);
    const now = new Date();
    // Default to 18:00, or the next full hour when planning for today
    d.setHours(sameDay(day, now) ? Math.min(now.getHours() + 1, 23) : 18, 0, 0, 0);
    setEditor({ post: null, date: d });
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />

      <main style={{ padding: '24px', flex: 1, maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <CalendarDays size={20} color="var(--accent)" />
              Content Planner
            </h1>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Plan photos, carousels and Reels. Scheduled posts are published by the account's browser session at the chosen time.
            </p>
          </div>
          <button style={primaryStyle} disabled={!accountId} onClick={() => setEditor({ post: null, date: null })}>
            <Plus size={14} strokeWidth={2.5} /> New post
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <select value={accountId || ''} onChange={e => navigate(`/content/${e.target.value}`)} style={controlStyle} aria-label="Account">
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.username === a.id ? a.id : `${a.id} (@${a.username})`}</option>
            ))}
          </select>
          <button style={controlStyle} onClick={() => setWeekOffset(o => o - 1)} aria-label="Previous week"><ChevronLeft size={14} /></button>
          <span style={{ fontSize: '13px', fontWeight: 600, minWidth: '190px', textAlign: 'center' }}>{weekTitle}</span>
          <button style={controlStyle} onClick={() => setWeekOffset(o => o + 1)} aria-label="Next week"><ChevronRight size={14} /></button>
          {weekOffset !== 0 && <button style={controlStyle} onClick={() => setWeekOffset(0)}>This week</button>}
        </div>

        {error && (
          <div style={{ marginBottom: '12px', padding: '8px 12px', fontSize: '13px', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--state-error-bg)', border: '1px solid var(--state-error-border)', color: 'var(--state-error)' }}>
            {error}
          </div>
        )}
        {busyDays.length > 0 && (
          <div style={{ marginBottom: '12px', padding: '8px 12px', fontSize: '13px', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--state-resting-bg)', border: '1px solid var(--state-resting-border)', color: 'var(--state-resting)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={14} />
            More than {BUSY_DAY_POSTS} posts on {busyDays.map(d => d.toLocaleDateString(undefined, { weekday: 'long' })).join(', ')}. Posting a lot in one day can look automated.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(120px, 1fr)) minmax(150px, 0.9fr)', gap: '8px', overflowX: 'auto' }}>
          {days.map(day => {
            const isToday = sameDay(day, today);
            const isPast = day < new Date(today.getFullYear(), today.getMonth(), today.getDate());
            return (
              <div key={day.toISOString()} style={{ backgroundColor: 'var(--bg-surface)', border: `1px solid ${isToday ? 'var(--accent)' : 'var(--border-subtle)'}`, borderRadius: 'var(--radius-md)', padding: '8px', minHeight: '360px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: isToday ? 'var(--accent)' : 'var(--text-primary)' }}>
                    {day.toLocaleDateString(undefined, { weekday: 'short' })} {day.getDate()}
                  </span>
                  {!isPast && (
                    <button aria-label={`New post on ${day.toDateString()}`} onClick={() => newPostAt(day)} style={{ ...controlStyle, padding: '2px 4px', border: 'none', backgroundColor: 'transparent', color: 'var(--text-muted)' }}>
                      <Plus size={14} />
                    </button>
                  )}
                </div>
                {postsOn(day).map(p => <PostCard key={p._id} post={p} onOpen={() => setEditor({ post: p, date: null })} />)}
              </div>
            );
          })}

          <div style={{ backgroundColor: 'var(--bg-surface)', border: '1px dashed var(--border-medium)', borderRadius: 'var(--radius-md)', padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600 }}>Drafts <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(no date)</span></span>
            {unscheduled.length === 0 && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Drafts without a date show up here.</span>}
            {unscheduled.map(p => <PostCard key={p._id} post={p} onOpen={() => setEditor({ post: p, date: null })} />)}
          </div>
        </div>
      </main>

      <Dialog.Root open={!!editor} onOpenChange={open => !open && setEditor(null)}>
        {editor && accountId && (
          <PostEditor
            key={editor.post?._id || 'new'}
            accountId={accountId}
            post={editor.post}
            defaultDate={editor.date}
            onClose={() => setEditor(null)}
            onChanged={load}
          />
        )}
      </Dialog.Root>
    </div>
  );
};
