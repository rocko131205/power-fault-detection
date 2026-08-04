const API_BASE = import.meta.env.VITE_API_URL || '/api';

export async function fetchStats() {
  const res = await fetch(`${API_BASE}/network/stats`);
  return res.json();
}

export async function fetchPoles(dtId) {
  const url = dtId ? `${API_BASE}/network/poles?dt_id=${dtId}` : `${API_BASE}/network/poles`;
  const res = await fetch(url);
  return res.json();
}

export async function fetchTransformers() {
  const res = await fetch(`${API_BASE}/network/transformers`);
  return res.json();
}

export async function fetchTickets(status) {
  const url = status ? `${API_BASE}/tickets?status=${status}` : `${API_BASE}/tickets`;
  const res = await fetch(url);
  return res.json();
}

export async function fetchTicket(id) {
  const res = await fetch(`${API_BASE}/tickets/${id}`);
  return res.json();
}

export async function updateTicketStatus(id, status) {
  const res = await fetch(`${API_BASE}/tickets/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return res.json();
}

export async function fetchSimulatorState() {
  const res = await fetch(`${API_BASE}/simulator/state`);
  return res.json();
}

export async function injectFault(faultType, targetId) {
  const body = { fault_type: faultType };
  if (faultType === 'feeder') body.feeder_id = targetId;
  else body.dt_id = targetId;

  const res = await fetch(`${API_BASE}/simulator/inject-fault`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function repairFault(ticketId, dtId) {
  const body = {};
  if (ticketId) body.ticket_id = ticketId;
  else if (dtId) body.dt_id = dtId;

  const res = await fetch(`${API_BASE}/simulator/repair-fault`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function injectNoise(type, poleId) {
  const res = await fetch(`${API_BASE}/simulator/inject-noise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, pole_id: poleId }),
  });
  return res.json();
}
