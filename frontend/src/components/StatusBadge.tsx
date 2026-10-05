import type { BotLifecycleState } from '../api/client';

interface Props {
  state: BotLifecycleState;
  activeSession?: boolean;
}

export const StatusBadge: React.FC<Props> = ({ state, activeSession }) => {
  const configMap: Record<BotLifecycleState, { label: string; color: string; bg: string; border: string }> = {
    running: {
      label: activeSession ? 'ACTIVE SESSION' : 'RUNNING',
      color: 'var(--state-running)',
      bg: 'var(--state-running-bg)',
      border: 'var(--state-running-border)',
    },
    resting: {
      label: 'RESTING',
      color: 'var(--state-resting)',
      bg: 'var(--state-resting-bg)',
      border: 'var(--state-resting-border)',
    },
    sleeping: {
      label: 'SLEEPING',
      color: 'var(--state-sleeping)',
      bg: 'var(--state-sleeping-bg)',
      border: 'var(--state-sleeping-border)',
    },
    paused: {
      label: 'PAUSED',
      color: 'var(--state-paused)',
      bg: 'var(--state-paused-bg)',
      border: 'var(--state-paused-border)',
    },
    stopped: {
      label: 'STOPPED',
      color: 'var(--state-stopped)',
      bg: 'var(--state-stopped-bg)',
      border: 'var(--state-stopped-border)',
    },
    disabled: {
      label: 'DISABLED',
      color: 'var(--state-stopped)',
      bg: 'rgba(50, 50, 50, 0.2)',
      border: 'var(--border-subtle)',
    },
    idle: {
      label: 'IDLE',
      color: 'var(--text-secondary)',
      bg: 'var(--bg-surface-elevated)',
      border: 'var(--border-subtle)',
    },
  };

  const current = configMap[state] || configMap.idle;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 8px',
        borderRadius: 'var(--radius-full)',
        backgroundColor: current.bg,
        border: `1px solid ${current.border}`,
        color: current.color,
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.05em',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
      }}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          backgroundColor: current.color,
          animation: state === 'running' ? 'pulseGlow 1.5s infinite ease-in-out' : 'none',
        }}
      />
      {current.label}
    </span>
  );
};
