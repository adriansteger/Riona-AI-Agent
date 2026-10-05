import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AccountOverview } from '../api/client';
import { StatusBadge } from './StatusBadge';
import { Countdown } from './Countdown';
import { Play, Square, Pause, RotateCw, Terminal, Settings, Heart, MessageCircle, Send, Moon } from 'lucide-react';

interface Props {
  data: AccountOverview;
  onRefresh: () => void;
  onOpenLogs?: (accountId: string) => void;
}

export const BotCard: React.FC<Props> = ({ data, onRefresh, onOpenLogs }) => {
  const navigate = useNavigate();
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const { account, state, nextActiveTime, isSleeping, activeSession, activity } = data;

  const handleAction = async (action: 'start' | 'stop' | 'pause' | 'resume' | 'restart', e: React.MouseEvent) => {
    e.stopPropagation();
    setLoadingAction(action);
    try {
      if (action === 'start') await api.startBot(account.id);
      if (action === 'stop') await api.stopBot(account.id);
      if (action === 'pause') await api.pauseBot(account.id);
      if (action === 'resume') await api.resumeBot(account.id);
      if (action === 'restart') await api.restartBot(account.id);
      onRefresh();
    } catch (err: any) {
      alert(`Action failed: ${err.message}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const likesLimit = account.settings?.limits?.likesPerHour ?? 10;
  const commentsLimit = account.settings?.limits?.commentsPerHour ?? 5;
  const dmsLimit = account.settings?.limits?.dmsPerHour ?? 8;

  const sleepStart = account.settings?.schedule?.sleepStartHour ?? 23;
  const sleepEnd = account.settings?.schedule?.sleepEndHour ?? 7;

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: `1px solid ${state === 'running' ? 'var(--state-running-border)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        transition: 'transform 0.15s ease, border-color 0.15s ease',
        boxShadow: 'var(--shadow-card)',
        position: 'relative',
      }}
    >
      {/* Top Header: ID, Username & Status */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 700, fontSize: '16px', color: 'var(--text-primary)' }}>
              @{account.username}
            </span>
            <span
              style={{
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-muted)',
                backgroundColor: 'var(--bg-surface-elevated)',
                padding: '2px 6px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {account.id}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
            Persona: <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{account.character || 'Default'}</span>
            {account.proxy && <span style={{ marginLeft: '8px', color: 'var(--text-muted)' }}>• Proxy Active</span>}
          </div>
        </div>

        <StatusBadge state={state} activeSession={activeSession} />
      </div>

      {/* Activity Counters (1h window vs limits) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '8px',
          backgroundColor: 'var(--bg-canvas)',
          padding: '10px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
            <Heart size={12} color="var(--accent)" />
            Likes 1h
          </div>
          <div style={{ fontSize: '15px', fontWeight: 700, fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
            {activity.likes1h} <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>/ {likesLimit}</span>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
            <MessageCircle size={12} color="#58a6ff" />
            Comments
          </div>
          <div style={{ fontSize: '15px', fontWeight: 700, fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
            {activity.comments1h} <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>/ {commentsLimit}</span>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
            <Send size={12} color="#3fb950" />
            Auto DMs
          </div>
          <div style={{ fontSize: '15px', fontWeight: 700, fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
            {activity.dms1h} <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>/ {dmsLimit}</span>
          </div>
        </div>
      </div>

      {/* Schedule & Cycle Info */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '12px',
          padding: '4px 0',
          borderTop: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)' }}>
          <Moon size={13} color={isSleeping ? 'var(--state-sleeping)' : 'var(--text-muted)'} />
          <span>Sleep: {sleepStart}:00–{sleepEnd}:00</span>
        </div>

        <div>
          {state === 'resting' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ color: 'var(--text-muted)' }}>Wake in:</span>
              <Countdown targetTimestamp={nextActiveTime} />
            </div>
          )}
          {state === 'sleeping' && (
            <span style={{ color: 'var(--state-sleeping)', fontFamily: 'var(--font-mono)' }}>In Sleep Window</span>
          )}
          {state === 'running' && (
            <span style={{ color: 'var(--state-running)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>Active Loop</span>
          )}
        </div>
      </div>

      {/* Action Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: '6px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {state === 'stopped' || state === 'disabled' ? (
            <button
              onClick={(e) => handleAction('start', e)}
              disabled={!!loadingAction}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '5px 12px',
                backgroundColor: 'var(--state-running-bg)',
                border: '1px solid var(--state-running-border)',
                color: 'var(--state-running)',
                borderRadius: 'var(--radius-sm)',
                fontWeight: 600,
                fontSize: '12px',
              }}
              title="Start bot loop"
            >
              <Play size={12} fill="currentColor" />
              Start
            </button>
          ) : (
            <>
              {state === 'paused' ? (
                <button
                  onClick={(e) => handleAction('resume', e)}
                  disabled={!!loadingAction}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '5px 10px',
                    backgroundColor: 'rgba(57, 197, 187, 0.15)',
                    border: '1px solid var(--state-paused-border)',
                    color: 'var(--state-paused)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}
                  title="Resume bot"
                >
                  <Play size={12} fill="currentColor" />
                  Resume
                </button>
              ) : (
                <button
                  onClick={(e) => handleAction('pause', e)}
                  disabled={!!loadingAction}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '5px 10px',
                    backgroundColor: 'var(--bg-surface-elevated)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '12px',
                  }}
                  title="Pause bot cycles"
                >
                  <Pause size={12} />
                  Pause
                </button>
              )}

              <button
                onClick={(e) => handleAction('stop', e)}
                disabled={!!loadingAction}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '5px 10px',
                  backgroundColor: 'rgba(248, 81, 73, 0.12)',
                  border: '1px solid var(--state-error-border)',
                  color: 'var(--state-error)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '12px',
                  fontWeight: 600,
                }}
                title="Stop bot immediately"
              >
                <Square size={12} fill="currentColor" />
                Stop
              </button>

              <button
                onClick={(e) => handleAction('restart', e)}
                disabled={!!loadingAction}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '5px 8px',
                  backgroundColor: 'var(--bg-surface-elevated)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '12px',
                }}
                title="Restart bot"
              >
                <RotateCw size={12} />
              </button>
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            onClick={() => onOpenLogs ? onOpenLogs(account.id) : navigate(`/accounts/${account.id}`)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '5px 10px',
              backgroundColor: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '12px',
            }}
            title="View live stream logs"
          >
            <Terminal size={12} />
            Logs
          </button>

          <button
            onClick={() => navigate(`/accounts/${account.id}/edit`)}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '5px 8px',
              backgroundColor: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
              borderRadius: 'var(--radius-sm)',
            }}
            title="Edit account settings"
          >
            <Settings size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};
