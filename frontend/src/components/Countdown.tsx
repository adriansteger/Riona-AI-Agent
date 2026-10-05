import React, { useEffect, useState } from 'react';

interface Props {
  targetTimestamp: number;
  label?: string;
}

export const Countdown: React.FC<Props> = ({ targetTimestamp, label }) => {
  const [diff, setDiff] = useState<number>(targetTimestamp - Date.now());

  useEffect(() => {
    const update = () => setDiff(targetTimestamp - Date.now());
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [targetTimestamp]);

  if (!targetTimestamp || targetTimestamp <= 0) {
    return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  }

  if (diff <= 0) {
    return (
      <span style={{ color: 'var(--state-running)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
        Due now
      </span>
    );
  }

  const totalSeconds = Math.floor(diff / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const formatted = [
    hours > 0 ? `${hours}h` : null,
    `${minutes}m`,
    hours === 0 ? `${seconds}s` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        color: 'var(--text-secondary)',
      }}
      title={new Date(targetTimestamp).toLocaleTimeString()}
    >
      {label && <span style={{ color: 'var(--text-muted)', marginRight: '4px' }}>{label}</span>}
      {formatted}
    </span>
  );
};
