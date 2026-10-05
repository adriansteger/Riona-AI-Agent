import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { CharacterSummary } from '../api/client';
import { Navbar } from '../components/Navbar';
import { ArrowLeft, Save, Trash2, AlertCircle, CheckCircle2 } from 'lucide-react';

export const AccountEdit: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();

  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(!isNew);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form Fields
  const [accountId, setAccountId] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [proxy, setProxy] = useState('');
  const [character, setCharacter] = useState('Ascotech.Agent.json');
  const [enabled, setEnabled] = useState(true);

  // Behavior
  const [enableLikes, setEnableLikes] = useState(true);
  const [enableComments, setEnableComments] = useState(false);
  const [enableCommentLikes, setEnableCommentLikes] = useState(false);
  const [enableAutoDMs, setEnableAutoDMs] = useState(false);

  // Limits
  const [likesPerHour, setLikesPerHour] = useState(12);
  const [likesPerSession, setLikesPerSession] = useState('3-6');
  const [commentsPerHour, setCommentsPerHour] = useState(5);
  const [dmsPerHour, setDmsPerHour] = useState(8);

  // Schedule
  const [sleepStartHour, setSleepStartHour] = useState(23);
  const [sleepEndHour, setSleepEndHour] = useState(7);
  const [minRestMinutes, setMinRestMinutes] = useState(60);
  const [maxRestMinutes, setMaxRestMinutes] = useState(150);
  const [dmCheckIntervalMinutes, setDmCheckIntervalMinutes] = useState(15);

  // Hashtags
  const [hashtagsStr, setHashtagsStr] = useState('zürich, bern, basel');
  const [hashtagMix, setHashtagMix] = useState(1.0);

  useEffect(() => {
    // Load characters list for dropdown
    api.listCharacters().then((res) => {
      setCharacters(res.characters || []);
    }).catch(() => {});

    if (!isNew && id) {
      api.getAccount(id)
        .then((res) => {
          const acc = res.account;
          setAccountId(acc.id);
          setUsername(acc.username);
          setHasPassword(acc.hasPassword);
          setProxy(acc.proxy || '');
          setCharacter(acc.character || 'Ascotech.Agent.json');
          setEnabled(acc.enabled);

          // Behavior
          if (acc.settings?.behavior) {
            setEnableLikes(acc.settings.behavior.enableLikes ?? true);
            setEnableComments(acc.settings.behavior.enableComments ?? false);
            setEnableCommentLikes(acc.settings.behavior.enableCommentLikes ?? false);
            setEnableAutoDMs(acc.settings.behavior.enableAutoDMs ?? false);
          }

          // Limits
          if (acc.settings?.limits) {
            setLikesPerHour(acc.settings.limits.likesPerHour ?? 12);
            setLikesPerSession(String(acc.settings.limits.likesPerSession ?? '3-6'));
            setCommentsPerHour(acc.settings.limits.commentsPerHour ?? 5);
            setDmsPerHour(acc.settings.limits.dmsPerHour ?? 8);
          }

          // Schedule
          if (acc.settings?.schedule) {
            setSleepStartHour(acc.settings.schedule.sleepStartHour ?? 23);
            setSleepEndHour(acc.settings.schedule.sleepEndHour ?? 7);
            setMinRestMinutes(acc.settings.schedule.minRestMinutes ?? 60);
            setMaxRestMinutes(acc.settings.schedule.maxRestMinutes ?? 150);
            setDmCheckIntervalMinutes(acc.settings.schedule.dmCheckIntervalMinutes ?? 15);
          }

          // Hashtags
          if (acc.settings?.hashtags) {
            setHashtagsStr(acc.settings.hashtags.join(', '));
          }
          if (acc.settings?.hashtagMix !== undefined) {
            setHashtagMix(acc.settings.hashtagMix);
          }
        })
        .catch((err) => {
          setError(err.message || 'Failed to load account');
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [id, isNew]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);

    const hashtags = hashtagsStr
      .split(',')
      .map((h) => h.trim().replace(/^#/, ''))
      .filter((h) => h.length > 0);

    const payload: any = {
      id: accountId.trim(),
      username: username.trim(),
      proxy: proxy.trim(),
      character,
      enabled,
      settings: {
        hashtags,
        hashtagMix: Number(hashtagMix),
        behavior: {
          enableLikes,
          enableComments,
          enableCommentLikes,
          enableAutoDMs,
        },
        limits: {
          likesPerHour: Number(likesPerHour),
          likesPerSession,
          commentsPerHour: Number(commentsPerHour),
          dmsPerHour: Number(dmsPerHour),
        },
        schedule: {
          sleepStartHour: Number(sleepStartHour),
          sleepEndHour: Number(sleepEndHour),
          minRestMinutes: Number(minRestMinutes),
          maxRestMinutes: Number(maxRestMinutes),
          dmCheckIntervalMinutes: Number(dmCheckIntervalMinutes),
        },
      },
    };

    if (password.trim() !== '') {
      payload.password = password.trim();
    }

    try {
      if (isNew) {
        await api.createAccount(payload);
        setSuccess('Account created successfully');
        setTimeout(() => navigate('/'), 800);
      } else {
        await api.updateAccount(id!, payload);
        setSuccess('Account updated and saved to config');
        setPassword('');
        setHasPassword(true);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to save account');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id || isNew) return;
    const confirmed = window.confirm(`Are you sure you want to stop and delete bot account "${id}"?`);
    if (!confirmed) return;

    try {
      await api.deleteAccount(id);
      navigate('/');
    } catch (err: any) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Navbar />
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading account configuration...
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />

      <main style={{ padding: '24px', flex: 1, maxWidth: '860px', margin: '0 auto', width: '100%' }}>
        {/* Top Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              onClick={() => navigate('/')}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '6px',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
              }}
            >
              <ArrowLeft size={16} />
            </button>
            <h1 style={{ fontSize: '18px', fontWeight: 700 }}>
              {isNew ? 'Create New Instagram Bot' : `Configure Bot: @${username} (${accountId})`}
            </h1>
          </div>

          {!isNew && (
            <button
              onClick={handleDelete}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                backgroundColor: 'rgba(248, 81, 73, 0.12)',
                border: '1px solid var(--state-error-border)',
                color: 'var(--state-error)',
                borderRadius: 'var(--radius-md)',
                fontSize: '12px',
                fontWeight: 600,
              }}
            >
              <Trash2 size={13} />
              Delete Account
            </button>
          )}
        </div>

        {error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: 'var(--state-error-bg)',
              color: 'var(--state-error)',
              border: '1px solid var(--state-error-border)',
              padding: '12px',
              borderRadius: 'var(--radius-md)',
              marginBottom: '18px',
            }}
          >
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: 'var(--state-running-bg)',
              color: 'var(--state-running)',
              border: '1px solid var(--state-running-border)',
              padding: '12px',
              borderRadius: 'var(--radius-md)',
              marginBottom: '18px',
            }}
          >
            <CheckCircle2 size={16} />
            <span>{success}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Section 1: General & Authentication */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '20px',
            }}
          >
            <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '14px', color: 'var(--text-primary)' }}>
              1. Identity & Credentials
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Account ID (Key in config)
                </label>
                <input
                  type="text"
                  required
                  disabled={!isNew}
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  placeholder="e.g. ascotech_main"
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Instagram Username
                </label>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. ascotech_schweiz"
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Password {hasPassword && <span style={{ color: 'var(--state-running)', fontSize: '11px' }}>(Saved on file)</span>}
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={hasPassword ? 'Leave blank to keep existing password' : 'Enter Instagram password'}
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  HTTP Proxy (Optional)
                </label>
                <input
                  type="text"
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                  placeholder="http://user:pass@host:port"
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  AI Character Persona
                </label>
                <select
                  value={character}
                  onChange={(e) => setCharacter(e.target.value)}
                  style={{ width: '100%' }}
                >
                  {characters.map((c) => (
                    <option key={c.filename} value={c.filename}>
                      {c.name} ({c.filename})
                    </option>
                  ))}
                  <option value="adrian-style">Default (Adrian Style Base)</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '20px' }}>
                <input
                  type="checkbox"
                  id="enabledCheck"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                />
                <label htmlFor="enabledCheck" style={{ fontSize: '13px', fontWeight: 600 }}>
                  Account Enabled in Fleet
                </label>
              </div>
            </div>
          </div>

          {/* Section 2: Behavior */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '20px',
            }}
          >
            <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '14px' }}>
              2. Interaction Behaviors
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <input
                  type="checkbox"
                  checked={enableLikes}
                  onChange={(e) => setEnableLikes(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                />
                Enable Likes
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <input
                  type="checkbox"
                  checked={enableComments}
                  onChange={(e) => setEnableComments(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                />
                Enable AI Comments
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <input
                  type="checkbox"
                  checked={enableAutoDMs}
                  onChange={(e) => setEnableAutoDMs(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                />
                Enable Auto DMs
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <input
                  type="checkbox"
                  checked={enableCommentLikes}
                  onChange={(e) => setEnableCommentLikes(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                />
                Enable Comment Likes
              </label>
            </div>
          </div>

          {/* Section 3: Limits */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '20px',
            }}
          >
            <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '14px' }}>
              3. Rate & Safety Limits
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Likes / Hour
                </label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={likesPerHour}
                  onChange={(e) => setLikesPerHour(Number(e.target.value))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Likes / Session (Min-Max)
                </label>
                <input
                  type="text"
                  value={likesPerSession}
                  onChange={(e) => setLikesPerSession(e.target.value)}
                  placeholder="3-6"
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Comments / Hour
                </label>
                <input
                  type="number"
                  min="0"
                  max="30"
                  value={commentsPerHour}
                  onChange={(e) => setCommentsPerHour(Number(e.target.value))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  DMs / Hour
                </label>
                <input
                  type="number"
                  min="0"
                  max="30"
                  value={dmsPerHour}
                  onChange={(e) => setDmsPerHour(Number(e.target.value))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </div>
          </div>

          {/* Section 4: Schedule */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '20px',
            }}
          >
            <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '14px' }}>
              4. Human-like Schedule & Rest Cycles
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Sleep Start (0-23h)
                </label>
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={sleepStartHour}
                  onChange={(e) => setSleepStartHour(Number(e.target.value))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Sleep End (0-23h)
                </label>
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={sleepEndHour}
                  onChange={(e) => setSleepEndHour(Number(e.target.value))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Min Rest (Minutes)
                </label>
                <input
                  type="number"
                  min="5"
                  max="300"
                  value={minRestMinutes}
                  onChange={(e) => setMinRestMinutes(Number(e.target.value))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Max Rest (Minutes)
                </label>
                <input
                  type="number"
                  min="10"
                  max="400"
                  value={maxRestMinutes}
                  onChange={(e) => setMaxRestMinutes(Number(e.target.value))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  DM Interval (Min)
                </label>
                <input
                  type="number"
                  min="2"
                  max="60"
                  value={dmCheckIntervalMinutes}
                  onChange={(e) => setDmCheckIntervalMinutes(Number(e.target.value))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </div>
          </div>

          {/* Section 5: Hashtags */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '20px',
            }}
          >
            <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '14px' }}>
              5. Target Hashtags & Mix
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Hashtags (Comma-separated)
                </label>
                <input
                  type="text"
                  value={hashtagsStr}
                  onChange={(e) => setHashtagsStr(e.target.value)}
                  placeholder="zürich, bern, basel, ai, tech"
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  <span>Hashtag Strategy Mix ({Math.round(hashtagMix * 100)}% Hashtags, {Math.round((1 - hashtagMix) * 100)}% Feed)</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{hashtagMix.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={hashtagMix}
                  onChange={(e) => setHashtagMix(Number(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent)' }}
                />
              </div>
            </div>
          </div>

          {/* Submit Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '12px', marginTop: '10px' }}>
            <button
              type="button"
              onClick={() => navigate('/')}
              style={{
                padding: '10px 18px',
                backgroundColor: 'var(--bg-surface-elevated)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
                borderRadius: 'var(--radius-md)',
                fontSize: '13px',
              }}
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={saving}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 24px',
                backgroundColor: 'var(--accent)',
                color: 'var(--text-inverse)',
                borderRadius: 'var(--radius-md)',
                fontWeight: 600,
                fontSize: '13px',
                opacity: saving ? 0.7 : 1,
              }}
            >
              <Save size={15} />
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
};
