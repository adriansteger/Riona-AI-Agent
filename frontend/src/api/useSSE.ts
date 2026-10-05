import { useEffect, useState, useRef } from 'react';
import type { LogEntry } from './client';

export function useSSELogs(accountId: string) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState<boolean>(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setLogs([]); // Reset on account switch
    const token = localStorage.getItem('dash_token') || '';
    const url = `/api/dashboard/logs/${encodeURIComponent(accountId)}/stream?token=${encodeURIComponent(token)}`;

    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
    };

    es.onmessage = (event) => {
      if (!event.data) return;
      try {
        const entry: LogEntry = JSON.parse(event.data);
        setLogs((prev) => {
          const next = [...prev, entry];
          // Keep at most 500 lines in UI
          return next.slice(-500);
        });
      } catch {
        // ignore non-json keepalives
      }
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [accountId]);

  const clearLogs = () => setLogs([]);

  return { logs, connected, clearLogs };
}
