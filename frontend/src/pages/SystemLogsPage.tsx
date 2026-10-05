import React, { useState } from 'react';
import { Navbar } from '../components/Navbar';
import { LogViewer } from '../components/LogViewer';
import { Terminal } from 'lucide-react';

export const SystemLogsPage: React.FC = () => {
  const [selectedTarget, setSelectedTarget] = useState<string>('system');

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />

      <main style={{ padding: '24px', flex: 1, maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Terminal size={20} color="var(--accent)" />
              System Diagnostics & Global Logs
            </h1>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Live real-time event stream across bot loops, scheduler, network, and error handlers.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Channel:</span>
            <select
              value={selectedTarget}
              onChange={(e) => setSelectedTarget(e.target.value)}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="system">System Daemon Only</option>
              <option value="all">Global (All Bots + System)</option>
            </select>
          </div>
        </div>

        <LogViewer accountId={selectedTarget} isLive={true} height="650px" />
      </main>
    </div>
  );
};
