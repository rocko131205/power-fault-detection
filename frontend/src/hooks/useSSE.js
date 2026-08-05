import { useState, useEffect, useCallback } from 'react';

/**
 * Hook for Server-Sent Events connection.
 * Auto-reconnects on disconnection.
 */
export function useSSE(onEvent) {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let eventSource;
    let reconnectTimer;

    function connect() {
      const API_BASE = import.meta.env.VITE_API_URL || '/api';
      eventSource = new EventSource(`${API_BASE}/events`);

      eventSource.onopen = () => {
        setConnected(true);
        console.log('SSE connected');
      };

      eventSource.onerror = () => {
        setConnected(false);
        eventSource.close();
        // Reconnect after 3 seconds
        reconnectTimer = setTimeout(connect, 3000);
      };

      // Listen to custom events
      const events = [
        'device_update', 'devices_overdue',
        'new_ticket', 'ticket_update', 'ticket_verified',
        'fault_injected', 'fault_repaired',
      ];

      events.forEach(eventName => {
        eventSource.addEventListener(eventName, (e) => {
          try {
            const data = JSON.parse(e.data);
            onEvent(eventName, data);
          } catch (err) {
            console.error('SSE parse error:', err);
          }
        });
      });
    }

    connect();

    return () => {
      if (eventSource) eventSource.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [onEvent]);

  return connected;
}
