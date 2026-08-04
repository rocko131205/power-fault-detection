import { useState, useCallback, useEffect } from 'react';
import './App.css';
import { useSSE } from './hooks/useSSE';
import { fetchStats, fetchTickets, fetchTicket, updateTicketStatus, fetchSimulatorState, injectFault, repairFault, injectNoise } from './utils/api';
import FaultMap from './components/FaultMap';

function App() {
  const [stats, setStats] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [ticketDetail, setTicketDetail] = useState(null);
  const [activeTab, setActiveTab] = useState('active');
  const [showSimulator, setShowSimulator] = useState(false);
  const [simState, setSimState] = useState(null);
  const [simFaultType, setSimFaultType] = useState('span');
  const [simTarget, setSimTarget] = useState('');
  const [simResult, setSimResult] = useState(null);
  const [toasts, setToasts] = useState([]);

  // Add toast notification
  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }, []);

  // Load initial data
  const refreshData = useCallback(async () => {
    try {
      const [statsData, ticketsData] = await Promise.all([
        fetchStats(),
        fetchTickets(activeTab === 'active' ? 'active' : undefined),
      ]);
      setStats(statsData);
      setTickets(ticketsData);
    } catch (err) {
      console.error('Refresh error:', err);
    }
  }, [activeTab]);

  useEffect(() => {
    refreshData();
    const interval = setInterval(refreshData, 5000);
    return () => clearInterval(interval);
  }, [refreshData]);

  // Load ticket detail
  const selectTicket = useCallback(async (ticketId) => {
    setSelectedTicket(ticketId);
    try {
      const detail = await fetchTicket(ticketId);
      setTicketDetail(detail);
    } catch (err) {
      console.error('Fetch ticket error:', err);
    }
  }, []);

  // SSE events
  const handleSSE = useCallback((event, data) => {
    if (event === 'new_ticket') {
      addToast(`🚨 New ${data.fault_type} fault detected! ${data.affected_poles_count} poles affected.`, 'fault');
      refreshData();
    } else if (event === 'ticket_verified') {
      addToast(`✅ Ticket ${data.ticket_id} auto-verified by telemetry.`, 'verified');
      refreshData();
    } else if (event === 'ticket_update') {
      if (data.action === 'resolution_rejected') {
        addToast(`⚠️ Resolution rejected — ${data.still_dark} poles still dark!`, 'fault');
      } else if (data.action === 'summary_generated') {
        addToast(`✨ AI incident summary generated for ${data.ticket_id}`, 'info');
      }
      refreshData();
      if (selectedTicket === data.ticket_id) {
        selectTicket(data.ticket_id);
      }
    } else if (event === 'fault_injected') {
      addToast(`⚡ Fault injected: ${data.description}`, 'info');
    } else if (event === 'fault_repaired') {
      addToast(`🔧 Fault repaired: ${data.poles_restored} poles restored`, 'verified');
      refreshData();
    }
  }, [addToast, refreshData, selectedTicket, selectTicket]);

  const sseConnected = useSSE(handleSSE);


  // Status transitions
  const handleStatusChange = async (ticketId, newStatus) => {
    try {
      const result = await updateTicketStatus(ticketId, newStatus);
      if (result.error) {
        addToast(`❌ ${result.error}: ${result.reason || ''}`, 'fault');
      } else {
        addToast(`Ticket updated to ${newStatus}`, 'info');
        selectTicket(ticketId);
        refreshData();
      }
    } catch (err) {
      addToast(`Error: ${err.message}`, 'fault');
    }
  };

  // Simulator
  const loadSimState = async () => {
    const state = await fetchSimulatorState();
    setSimState(state);
    if (state.transformers?.length > 0 && !simTarget) {
      setSimTarget(state.transformers[0].dt_id);
    }
  };

  useEffect(() => {
    if (showSimulator) loadSimState();
  }, [showSimulator]);

  const handleInjectFault = async () => {
    try {
      const result = await injectFault(simFaultType, simTarget);
      setSimResult(result);
      refreshData();
    } catch (err) {
      setSimResult({ error: err.message });
    }
  };

  const handleRepair = async () => {
    if (!selectedTicket) {
      addToast('Select a ticket first to repair', 'fault');
      return;
    }
    try {
      const result = await repairFault(selectedTicket);
      setSimResult(result);
      refreshData();
    } catch (err) {
      setSimResult({ error: err.message });
    }
  };

  const handleInjectNoise = async (type) => {
    try {
      const result = await injectNoise(type);
      setSimResult(result);
      addToast(`Noise injected: ${type}`, 'info');
    } catch (err) {
      setSimResult({ error: err.message });
    }
  };

  const getNextStatus = (current) => {
    const map = {
      'detected': 'acknowledged',
      'acknowledged': 'crew_assigned',
      'crew_assigned': 'resolved',
      'verified': 'closed',
    };
    return map[current];
  };

  const getStatusLabel = (status) => {
    const map = {
      'detected': 'Acknowledge',
      'acknowledged': 'Assign Crew',
      'crew_assigned': 'Mark Resolved',
      'verified': 'Close Ticket',
    };
    return map[status] || status;
  };

  const formatTime = (ts) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const timeSince = (ts) => {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  };

  return (
    <div className="app-container">
      {/* Top Bar */}
      <div className="top-bar">
        <div className="top-bar-left">
          <div>
            <div className="logo">⚡ KSPDB Control Room</div>
            <div className="logo-sub">Power Fault Detection System</div>
          </div>
          <div className={`connection-badge`}>
            <div className={`connection-dot ${sseConnected ? 'connected' : ''}`} />
            {sseConnected ? 'Live' : 'Reconnecting...'}
          </div>
        </div>
        <div className="stats-bar">
          {stats && (
            <>
              <div className={`stat-chip ${parseInt(stats.active_tickets) > 0 ? 'danger' : 'ok'}`}>
                🎫 Active Tickets: <span className="value">{stats.active_tickets}</span>
              </div>
              <div className={`stat-chip ${parseInt(stats.dark_poles) > 0 ? 'warning' : 'ok'}`}>
                🔴 Dark Poles: <span className="value">{stats.dark_poles}</span>
              </div>
              <div className="stat-chip">
                📡 Total Poles: <span className="value">{stats.total_poles}</span>
              </div>
              <div className="stat-chip">
                🏗️ DTs: <span className="value">{stats.total_dts}</span>
              </div>
              {parseInt(stats.active_outages) > 0 && (
                <div className="stat-chip warning">
                  📅 Scheduled Outages: <span className="value">{stats.active_outages}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="main-content">
        {/* Sidebar — Ticket List */}
        <div className="sidebar">
          <div className="sidebar-header">
            <h2>Fault Tickets</h2>
          </div>
          <div className="sidebar-tabs">
            {['active', 'all'].map(tab => (
              <button
                key={tab}
                className={`sidebar-tab ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'active' ? 'Active' : 'All'}
              </button>
            ))}
          </div>
          <div className="ticket-list">
            {tickets.length === 0 ? (
              <div className="empty-state">
                <div className="icon">✅</div>
                <div>No active faults</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Use the simulator to inject a fault</div>
              </div>
            ) : (
              tickets.map(ticket => (
                <div
                  key={ticket.ticket_id}
                  className={`ticket-card ${selectedTicket === ticket.ticket_id ? 'selected' : ''}`}
                  onClick={() => selectTicket(ticket.ticket_id)}
                >
                  <div className="ticket-card-header">
                    <div>
                      <div className="ticket-id">{ticket.ticket_id}</div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        <span className={`ticket-type ${ticket.fault_type}`}>{ticket.fault_type}</span>
                        <span className={`status-badge ${ticket.status}`}>{ticket.status.replace('_', ' ')}</span>
                        <span className={`confidence-badge ${ticket.confidence}`}>{ticket.confidence}</span>
                      </div>
                    </div>
                  </div>
                  <div className="ticket-location">
                    {ticket.fault_type === 'span'
                      ? `Span: ${ticket.fault_span_from || '?'} → ${ticket.fault_span_to || '?'}`
                      : ticket.fault_type === 'dt'
                        ? `DT: ${ticket.fault_dt_id}`
                        : `Feeder: ${ticket.fault_feeder_id}`}
                  </div>
                  <div className="ticket-meta">
                    <div className="ticket-meta-item">📍 {ticket.pincode || 'N/A'}</div>
                    <div className="ticket-meta-item">🔴 {ticket.affected_poles_count} poles</div>
                    <div className="ticket-meta-item">🕐 {timeSince(ticket.detected_at)}</div>
                    {ticket.localization_type && (
                      <div className="ticket-meta-item">
                        {ticket.localization_type === 'span_level' ? '🎯' : ticket.localization_type === 'approximate' ? '📍' : '📦'}
                        {' '}{ticket.localization_type.replace('_', ' ')}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Map Area */}
        <div className="map-area">
          <div className="map-container">
            <FaultMap
              tickets={tickets}
              selectedTicket={selectedTicket}
              onTicketSelect={selectTicket}
            />
          </div>

          {/* Ticket Detail Panel */}
          {ticketDetail && (
            <div className="detail-panel">
              <div className="detail-header">
                <div className="detail-title">
                  {ticketDetail.fault_type === 'span'
                    ? `Span Fault: ${ticketDetail.fault_span_from || '?'} → ${ticketDetail.fault_span_to || '?'}`
                    : ticketDetail.fault_type === 'dt'
                      ? `DT Fault: ${ticketDetail.fault_dt_id}`
                      : `Feeder Fault: ${ticketDetail.fault_feeder_id}`}
                </div>
                <button className="detail-close" onClick={() => { setSelectedTicket(null); setTicketDetail(null); }}>
                  ✕ Close
                </button>
              </div>

              <div className="detail-grid">
                <div className="detail-field">
                  <label>Status</label>
                  <div className="value"><span className={`status-badge ${ticketDetail.status}`}>{ticketDetail.status.replace('_', ' ')}</span></div>
                </div>
                <div className="detail-field">
                  <label>Coordinates</label>
                  <div className="value mono">{ticketDetail.lat?.toFixed(6)}, {ticketDetail.lon?.toFixed(6)}</div>
                </div>
                <div className="detail-field">
                  <label>PIN Code</label>
                  <div className="value">{ticketDetail.pincode || 'N/A'}</div>
                </div>
                <div className="detail-field">
                  <label>Affected Poles</label>
                  <div className="value">{ticketDetail.affected_poles_count}</div>
                </div>
                <div className="detail-field">
                  <label>Households</label>
                  <div className="value">~{ticketDetail.affected_households}</div>
                </div>
                <div className="detail-field">
                  <label>Confidence</label>
                  <div className="value"><span className={`confidence-badge ${ticketDetail.confidence}`}>{ticketDetail.confidence}</span></div>
                </div>
                <div className="detail-field">
                  <label>Localization</label>
                  <div className="value">
                    {ticketDetail.localization_type === 'span_level' ? '🎯 Span-level (precise)' :
                     ticketDetail.localization_type === 'approximate' ? '📍 Approximate (no topology)' :
                     ticketDetail.localization_type === 'dt_level' ? '📦 DT-level' :
                     '📡 Feeder-level'}
                  </div>
                </div>
                <div className="detail-field">
                  <label>Detected At</label>
                  <div className="value">{formatTime(ticketDetail.detected_at)}</div>
                </div>
                {ticketDetail.verified_by_telemetry && (
                  <div className="detail-field">
                    <label>Verified</label>
                    <div className="value" style={{ color: 'var(--accent-green)' }}>✅ Auto-verified by telemetry</div>
                  </div>
                )}
              </div>

              {ticketDetail.ai_summary && (
                <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 8, padding: '12px 14px', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--accent-purple)' }}>
                  <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--accent-purple)', marginBottom: 4, fontWeight: 700 }}>✨ AI Incident Summary</div>
                  {ticketDetail.ai_summary}
                </div>
              )}

              {ticketDetail.confidence_reason && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, padding: '8px 10px', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)' }}>
                  <strong>Reasoning:</strong> {ticketDetail.confidence_reason}
                </div>
              )}

              {ticketDetail.resolution_rejected && (
                <div className="rejection-banner">
                  ⚠️ Resolution was rejected: {ticketDetail.rejection_reason}
                </div>
              )}

              {/* Restoration progress */}
              {ticketDetail.affected_poles && ticketDetail.affected_poles.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0' }}>
                  Restoration: {ticketDetail.affected_poles.filter(p => p.restored).length} / {ticketDetail.affected_poles.length} poles restored
                </div>
              )}

              <div className="detail-actions">
                {getNextStatus(ticketDetail.status) && (
                  <button
                    className={`btn ${ticketDetail.status === 'crew_assigned' ? 'btn-warning' : 'btn-primary'}`}
                    onClick={() => handleStatusChange(ticketDetail.ticket_id, getNextStatus(ticketDetail.status))}
                  >
                    {getStatusLabel(ticketDetail.status)}
                  </button>
                )}
                <button className="btn btn-ghost" onClick={() => handleRepair()}>
                  🔧 Simulate Repair
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Simulator Toggle */}
      <button className="simulator-toggle" onClick={() => setShowSimulator(!showSimulator)}>
        {showSimulator ? '✕ Close' : '🧪 Simulator'}
      </button>

      {/* Simulator Panel */}
      {showSimulator && (
        <div className="simulator-panel">
          <h3>🧪 Fault Simulator</h3>

          <div className="sim-section">
            <label>Fault Type</label>
            <select className="sim-select" value={simFaultType} onChange={e => setSimFaultType(e.target.value)}>
              <option value="span">Span Fault (wire break)</option>
              <option value="dt">DT Fault (transformer)</option>
              <option value="feeder">Feeder Fault (11kV line)</option>
            </select>
          </div>

          <div className="sim-section">
            <label>Target {simFaultType === 'feeder' ? 'Feeder' : 'Transformer'}</label>
            <select className="sim-select" value={simTarget} onChange={e => setSimTarget(e.target.value)}>
              {simFaultType === 'feeder'
                ? simState?.feeders?.map(f => (
                    <option key={f.feeder_id} value={f.feeder_id}>{f.feeder_id}</option>
                  ))
                : simState?.transformers?.map(t => (
                    <option key={t.dt_id} value={t.dt_id}>
                      {t.dt_id} {t.has_topology ? '(has topology)' : '(no topology)'} — {t.households_served} homes
                    </option>
                  ))
              }
            </select>
          </div>

          <div className="sim-buttons">
            <button className="btn btn-danger" onClick={handleInjectFault}>⚡ Inject Fault</button>
            <button className="btn btn-success" onClick={handleRepair} disabled={!selectedTicket}>
              🔧 Repair Selected
            </button>
          </div>

          <div className="sim-section" style={{ marginTop: 12 }}>
            <label>Inject Noise</label>
            <div className="sim-buttons">
              <button className="btn btn-ghost" onClick={() => handleInjectNoise('dead_sensor')}>💀 Dead Sensor</button>
              <button className="btn btn-ghost" onClick={() => handleInjectNoise('scheduled_outage')}>📅 Scheduled Outage</button>
            </div>
          </div>

          {simResult && (
            <div className="sim-result">
              {simResult.error
                ? `❌ ${simResult.error}`
                : `✅ ${simResult.message || simResult.description || JSON.stringify(simResult)}`}
            </div>
          )}
        </div>
      )}

      {/* Toast Notifications */}
      <div className="toast-container">
        {toasts.map(toast => (
          <div key={toast.id} className={`toast ${toast.type}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
