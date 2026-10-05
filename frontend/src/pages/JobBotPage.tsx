import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { JobBotStatus } from '../api/client';
import { Navbar } from '../components/Navbar';
import { Briefcase, Play, Square, Save, AlertCircle, CheckCircle2, Globe, Shield } from 'lucide-react';

export const JobBotPage: React.FC = () => {
  const [status, setStatus] = useState<JobBotStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form Fields
  const [enabled, setEnabled] = useState(false);
  const [proxy, setProxy] = useState('');
  const [platforms, setPlatforms] = useState<string[]>(['indeed.ch']);

  const availablePlatforms = [
    { id: 'indeed.ch', label: 'Indeed Switzerland (indeed.ch)' },
    { id: 'indeed', label: 'Indeed Global' },
    { id: 'jobs.ch', label: 'Jobs.ch' },
    { id: 'ziprecruiter', label: 'ZipRecruiter' },
    { id: 'weworkremotely', label: 'We Work Remotely' },
  ];

  const fetchStatus = async () => {
    try {
      const data = await api.getJobBot();
      setStatus(data);
      if (data.config) {
        setEnabled(data.config.enabled);
        setProxy(data.config.proxy || '');
        if (data.config.preferences?.platforms) {
          setPlatforms(data.config.preferences.platforms);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch Job Bot status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleTogglePlatform = (pId: string) => {
    setPlatforms((prev) =>
      prev.includes(pId) ? prev.filter((p) => p !== pId) : [...prev, pId]
    );
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      await api.updateJobBot({
        enabled,
        platforms,
        proxy: proxy.trim(),
      });
      setSuccess('Job Bot configuration updated');
      fetchStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to save Job Bot settings');
    } finally {
      setSaving(false);
    }
  };

  const handleStartStop = async () => {
    if (!status) return;
    setActionLoading(true);
    setError(null);
    try {
      if (status.running) {
        await api.stopJobBot();
      } else {
        await api.startJobBot();
      }
      fetchStatus();
    } catch (err: any) {
      setError(err.message || 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Navbar />
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading Job Bot module...
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />

      <main style={{ padding: '24px', flex: 1, maxWidth: '860px', margin: '0 auto', width: '100%' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Briefcase size={20} color="var(--accent)" />
              Job Search Automation Agent
            </h1>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Automated job listing scanner with AI relevance analysis and email notifications.
            </p>
          </div>

          <button
            onClick={handleStartStop}
            disabled={actionLoading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 16px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: status?.running ? 'rgba(248,81,73,0.12)' : 'var(--state-running-bg)',
              border: `1px solid ${status?.running ? 'var(--state-error-border)' : 'var(--state-running-border)'}`,
              color: status?.running ? 'var(--state-error)' : 'var(--state-running)',
              fontSize: '13px',
              fontWeight: 600,
            }}
          >
            {status?.running ? <Square size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
            {status?.running ? 'Stop Agent' : 'Start Agent'}
          </button>
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

        {/* Status Panel */}
        <div
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            padding: '20px',
            marginBottom: '20px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '16px',
          }}
        >
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Execution State
            </div>
            <div style={{ fontSize: '16px', fontWeight: 700, marginTop: '4px', color: status?.running ? 'var(--state-running)' : 'var(--text-secondary)' }}>
              {status?.running ? 'RUNNING AUTOMATION' : 'IDLE / STOPPED'}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Last Search Cycle
            </div>
            <div style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
              {status?.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString() : 'Never in this session'}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Target Platforms
            </div>
            <div style={{ fontSize: '14px', marginTop: '4px', color: 'var(--text-primary)' }}>
              {platforms.join(', ') || 'None selected'}
            </div>
          </div>
        </div>

        {/* Settings Form */}
        <form onSubmit={handleSaveConfig} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '20px',
            }}
          >
            <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '14px' }}>
              Target Job Platforms
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {availablePlatforms.map((p) => {
                const checked = platforms.includes(p.id);
                return (
                  <label
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '10px 14px',
                      borderRadius: 'var(--radius-md)',
                      backgroundColor: checked ? 'var(--bg-surface-elevated)' : 'var(--bg-canvas)',
                      border: `1px solid ${checked ? 'var(--border-prominent)' : 'var(--border-subtle)'}`,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleTogglePlatform(p.id)}
                      style={{ accentColor: 'var(--accent)', width: '16px', height: '16px' }}
                    />
                    <Globe size={15} color={checked ? 'var(--accent)' : 'var(--text-muted)'} />
                    <span style={{ fontSize: '13px', fontWeight: checked ? 600 : 400 }}>{p.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '20px',
            }}
          >
            <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '14px' }}>
              Network & Run Policy
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Proxy (Optional)
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Shield size={16} color="var(--text-muted)" />
                  <input
                    type="text"
                    value={proxy}
                    onChange={(e) => setProxy(e.target.value)}
                    placeholder="http://user:pass@host:port"
                    style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '6px' }}>
                <input
                  type="checkbox"
                  id="jobEnabledCheck"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: 'var(--accent)' }}
                />
                <label htmlFor="jobEnabledCheck" style={{ fontSize: '13px', fontWeight: 600 }}>
                  Enable Job Bot on System Startup
                </label>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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
              {saving ? 'Saving...' : 'Save Preferences'}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
};
