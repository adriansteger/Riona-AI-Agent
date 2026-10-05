import { useState, useEffect, useRef } from 'react';
import type { LogEntry } from '../api/client';
import { useSSELogs } from '../api/useSSE';
import { Trash2, Copy, ArrowDown, Radio } from 'lucide-react';

interface Props {
  accountId: string;
  isLive?: boolean;
  initialLogs?: LogEntry[];
  height?: string | number;
}

export const LogViewer: React.FC<Props> = ({
  accountId,
  isLive = true,
  initialLogs = [],
  height = '450px',
}) => {
  const { logs: sseLogs, connected, clearLogs } = useSSELogs(accountId);
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayLogs = isLive ? sseLogs : initialLogs;

  const filteredLogs = displayLogs.filter((log) => {
    if (filterLevel === 'all') return true;
    return log.level.toLowerCase().includes(filterLevel.toLowerCase());
  });

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredLogs, autoScroll]);

  const formatTimestamp = (timestamp?: string): string => {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    return timestamp;
  };

  const handleCopy = () => {
    const text = filteredLogs
      .map((l) => `[${formatTimestamp(l.timestamp)}] [${l.level.toUpperCase()}]: ${l.message}`)
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getLevelColor = (level: string) => {
    const l = level.toLowerCase();
    if (l.includes('err')) return 'var(--state-error)';
    if (l.includes('warn')) return 'var(--state-resting)';
    if (l.includes('debug')) return 'var(--state-sleeping)';
    return 'var(--text-secondary)';
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#050709',
        border: '1px solid var(--border-medium)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
      }}
    >
      {/* Log Header Controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          backgroundColor: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isLive && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                color: connected ? 'var(--state-running)' : 'var(--text-muted)',
              }}
            >
              <Radio size={12} className={connected ? 'pulse-dot' : ''} />
              {connected ? 'LIVE STREAM' : 'CONNECTING...'}
            </span>
          )}
          <span style={{ color: 'var(--text-muted)' }}>|</span>
          <span style={{ color: 'var(--text-secondary)' }}>{filteredLogs.length} events</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {/* Level Filter */}
          <select
            value={filterLevel}
            onChange={(e) => setFilterLevel(e.target.value)}
            style={{
              padding: '2px 8px',
              fontSize: '11px',
              backgroundColor: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
            }}
          >
            <option value="all">ALL LEVELS</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
            <option value="debug">DEBUG</option>
          </select>

          {/* Autoscroll Toggle */}
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '3px 8px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: autoScroll ? 'rgba(255,87,51,0.15)' : 'var(--bg-surface-elevated)',
              color: autoScroll ? 'var(--accent)' : 'var(--text-muted)',
              border: `1px solid ${autoScroll ? 'var(--accent)' : 'var(--border-subtle)'}`,
              fontSize: '11px',
            }}
            title="Auto-scroll to bottom"
          >
            <ArrowDown size={12} />
            Scroll
          </button>

          {/* Copy Button */}
          <button
            onClick={handleCopy}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '3px 8px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--bg-surface-elevated)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
              fontSize: '11px',
            }}
            title="Copy logs to clipboard"
          >
            <Copy size={12} />
            {copied ? 'Copied!' : 'Copy'}
          </button>

          {/* Clear Button */}
          <button
            onClick={clearLogs}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '3px 8px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--bg-surface-elevated)',
              color: 'var(--text-muted)',
              border: '1px solid var(--border-subtle)',
              fontSize: '11px',
            }}
            title="Clear view"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Log Feed */}
      <div
        ref={containerRef}
        style={{
          height,
          overflowY: 'auto',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          lineHeight: 1.6,
        }}
      >
        {filteredLogs.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--text-muted)',
            }}
          >
            No log entries recorded for this view.
          </div>
        ) : (
          filteredLogs.map((log, index) => (
            <div
              key={index}
              style={{
                display: 'flex',
                gap: '8px',
                wordBreak: 'break-all',
              }}
            >
              <span style={{ color: 'var(--text-muted)', userSelect: 'none', minWidth: '70px' }}>
                {formatTimestamp(log.timestamp)}
              </span>
              <span
                style={{
                  color: getLevelColor(log.level),
                  fontWeight: 600,
                  minWidth: '55px',
                  textTransform: 'uppercase',
                }}
              >
                [{log.level}]
              </span>
              <span style={{ color: 'var(--text-primary)', flex: 1 }}>{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
