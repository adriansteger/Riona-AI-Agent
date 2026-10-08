import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AccountOverview, JobBotStatus } from '../api/client';
import { BotCard } from '../components/BotCard';
import { LogViewer } from '../components/LogViewer';
import { Navbar } from '../components/Navbar';
import {
  Cpu,
  RefreshCw,
  Heart,
  MessageCircle,
  Send,
  Briefcase,
  Play,
  Square,
  X,
  AlertCircle,
} from 'lucide-react';

export const Overview: React.FC = () => {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<AccountOverview[]>([]);
  const [jobBot, setJobBot] = useState<JobBotStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeLogBotId, setActiveLogBotId] = useState<string | null>(null);
  const [jobBotLoading, setJobBotLoading] = useState<boolean>(false);

  const fetchOverview = async (silent: boolean = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.getOverview();
      setAccounts(data.accounts || []);
      setJobBot(data.jobBot || null);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch overview data');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(() => {
      fetchOverview(true);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleJobBotToggle = async () => {
    if (!jobBot) return;
    setJobBotLoading(true);
    try {
      if (jobBot.running) {
        await api.stopJobBot();
      } else {
        await api.startJobBot();
      }
      await fetchOverview(true);
    } catch (err: any) {
      alert(`Job Bot action failed: ${err.message}`);
    } finally {
      setJobBotLoading(false);
    }
  };

  // Aggregations
  const totalBots = accounts.length;
  const runningBots = accounts.filter((a) => a.state === 'running').length;
  const restingBots = accounts.filter((a) => a.state === 'resting').length;
  const sleepingBots = accounts.filter((a) => a.state === 'sleeping').length;
  const stoppedBots = accounts.filter((a) => a.state === 'stopped' || a.state === 'disabled').length;

  const totalLikes1h = accounts.reduce((acc, curr) => acc + (curr.activity.likes1h || 0), 0);
  const totalComments1h = accounts.reduce((acc, curr) => acc + (curr.activity.comments1h || 0), 0);
  const totalDMs1h = accounts.reduce((acc, curr) => acc + (curr.activity.dms1h || 0), 0);

  const totalLikesToday = accounts.reduce((acc, curr) => acc + (curr.activity.likesToday ?? curr.activity.likes24h ?? 0), 0);
  const totalCommentsToday = accounts.reduce((acc, curr) => acc + (curr.activity.commentsToday ?? curr.activity.comments24h ?? 0), 0);
  const totalDMsToday = accounts.reduce((acc, curr) => acc + (curr.activity.dmsToday ?? curr.activity.dms24h ?? 0), 0);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />

      <main style={{ padding: '24px', flex: 1, maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
        {/* Metric Banner */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '12px',
            marginBottom: '24px',
          }}
        >
          {/* Active Status Metric */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Bot Fleet Status
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '6px' }}>
              <span style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                {runningBots}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                running / {totalBots} total
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px', fontSize: '11px' }}>
              <span style={{ color: 'var(--state-resting)' }}>{restingBots} resting</span>
              <span style={{ color: 'var(--text-muted)' }}>•</span>
              <span style={{ color: 'var(--state-sleeping)' }}>{sleepingBots} sleeping</span>
              <span style={{ color: 'var(--text-muted)' }}>•</span>
              <span style={{ color: 'var(--text-muted)' }}>{stoppedBots} stopped</span>
            </div>
          </div>

          {/* 1h Activity Metrics */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Fleet Velocity (Past Hour)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Heart size={14} color="var(--accent)" />
                <span style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  {totalLikes1h}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>likes</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <MessageCircle size={14} color="#58a6ff" />
                <span style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  {totalComments1h}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>comments</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Send size={14} color="#3fb950" />
                <span style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  {totalDMs1h}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>dms</span>
              </div>
            </div>
          </div>

          {/* Today Daily Activity Metrics */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Fleet Volume (Today)
              </div>
              <span
                style={{
                  fontSize: '10px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-muted)',
                  backgroundColor: 'var(--bg-surface-elevated)',
                  padding: '1px 5px',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                00:00 - NOW
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Heart size={14} color="var(--accent)" />
                <span style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  {totalLikesToday}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>likes</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <MessageCircle size={14} color="#58a6ff" />
                <span style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  {totalCommentsToday}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>comments</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Send size={14} color="#3fb950" />
                <span style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  {totalDMsToday}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>dms</span>
              </div>
            </div>
          </div>

          {/* Job Bot Status Card */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Job Search Agent
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                <Briefcase size={16} color={jobBot?.running ? 'var(--state-running)' : 'var(--text-muted)'} />
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: jobBot?.running ? 'var(--state-running)' : 'var(--text-secondary)',
                  }}
                >
                  {jobBot?.running ? 'RUNNING AUTOMATION' : 'STANDBY'}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Platforms: {jobBot?.config?.preferences?.platforms?.join(', ') || 'indeed.ch'}
              </div>
            </div>

            <button
              onClick={handleJobBotToggle}
              disabled={jobBotLoading}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '6px 12px',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: jobBot?.running ? 'rgba(248,81,73,0.12)' : 'var(--state-running-bg)',
                border: `1px solid ${jobBot?.running ? 'var(--state-error-border)' : 'var(--state-running-border)'}`,
                color: jobBot?.running ? 'var(--state-error)' : 'var(--state-running)',
                fontSize: '12px',
                fontWeight: 600,
              }}
            >
              {jobBot?.running ? <Square size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
              {jobBot?.running ? 'Stop' : 'Start'}
            </button>
          </div>
        </div>

        {/* Section Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '0.02em' }}>
              MANAGED ACCOUNTS ({accounts.length})
            </h2>
            <button
              onClick={() => fetchOverview()}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px',
                color: 'var(--text-muted)',
                borderRadius: 'var(--radius-sm)',
              }}
              title="Refresh overview"
            >
              <RefreshCw size={14} className={loading ? 'pulse-dot' : ''} />
            </button>
          </div>

          <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            Live sync: 4s interval
          </div>
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

        {/* Bots Grid */}
        {accounts.length === 0 ? (
          <div
            style={{
              padding: '48px 24px',
              textAlign: 'center',
              backgroundColor: 'var(--bg-surface)',
              border: '1px dashed var(--border-medium)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <Cpu size={32} color="var(--text-muted)" style={{ margin: '0 auto 12px auto' }} />
            <h3 style={{ fontSize: '16px', fontWeight: 600 }}>No Instagram Accounts Configured</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '4px', marginBottom: '18px' }}>
              Add an account to begin automating interactions with human schedules and safety limits.
            </p>
            <button
              onClick={() => navigate('/accounts/new')}
              style={{
                padding: '8px 18px',
                backgroundColor: 'var(--accent)',
                color: 'var(--text-inverse)',
                borderRadius: 'var(--radius-md)',
                fontWeight: 600,
              }}
            >
              Add Your First Bot
            </button>
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
              gap: '16px',
            }}
          >
            {accounts.map((overview) => (
              <BotCard
                key={overview.account.id}
                data={overview}
                onRefresh={() => fetchOverview(true)}
                onOpenLogs={(id) => setActiveLogBotId(id)}
              />
            ))}
          </div>
        )}

        {/* Slide-Over Live Log Drawer */}
        {activeLogBotId && (
          <div
            style={{
              position: 'fixed',
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: 100,
              backgroundColor: 'var(--bg-surface)',
              borderTop: '2px solid var(--accent)',
              boxShadow: '0 -10px 30px rgba(0,0,0,0.8)',
              padding: '16px 24px',
              maxHeight: '60vh',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 700, fontSize: '14px' }}>
                  LIVE LOG CONSOLE: <span style={{ color: 'var(--accent)' }}>@{accounts.find((a) => a.account.id === activeLogBotId)?.account.username || activeLogBotId}</span>
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)',
                  }}
                >
                  ({activeLogBotId})
                </span>
              </div>
              <button
                onClick={() => setActiveLogBotId(null)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '4px 8px',
                  backgroundColor: 'var(--bg-surface-elevated)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)',
                }}
              >
                <X size={14} />
                Close
              </button>
            </div>

            <LogViewer accountId={activeLogBotId} isLive={true} height="320px" />
          </div>
        )}
      </main>
    </div>
  );
};
