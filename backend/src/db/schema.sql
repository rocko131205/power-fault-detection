-- Propel Power Fault Detection System — Database Schema

-- Substations (66/11kV)
CREATE TABLE IF NOT EXISTS substations (
    substation_id VARCHAR(20) PRIMARY KEY,
    name VARCHAR(100),
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION
);

-- 11kV Feeders
CREATE TABLE IF NOT EXISTS feeders (
    feeder_id VARCHAR(20) PRIMARY KEY,
    substation_id VARCHAR(20) REFERENCES substations(substation_id),
    name VARCHAR(100)
);

-- Distribution Transformers
CREATE TABLE IF NOT EXISTS transformers (
    dt_id VARCHAR(20) PRIMARY KEY,
    feeder_id VARCHAR(20) REFERENCES feeders(feeder_id),
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    capacity_kva INTEGER DEFAULT 250,
    households_served INTEGER DEFAULT 0,
    has_topology BOOLEAN DEFAULT FALSE
);

-- Poles
CREATE TABLE IF NOT EXISTS poles (
    pole_id VARCHAR(20) PRIMARY KEY,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    feeder_id VARCHAR(20) REFERENCES feeders(feeder_id),
    dt_id VARCHAR(20) REFERENCES transformers(dt_id),
    seq_on_line INTEGER,
    parent_pole_id VARCHAR(20),
    pole_type VARCHAR(30) DEFAULT 'LT-9m-PCC',
    ward VARCHAR(20),
    pincode VARCHAR(10),
    device_id VARCHAR(50),
    has_device BOOLEAN DEFAULT TRUE
);

-- Device state tracking (one row per device, updated on each message)
CREATE TABLE IF NOT EXISTS device_state (
    pole_id VARCHAR(20) PRIMARY KEY REFERENCES poles(pole_id),
    device_id VARCHAR(50),
    last_seen_at TIMESTAMPTZ,
    last_seq BIGINT DEFAULT 0,
    energized BOOLEAN DEFAULT TRUE,
    status VARCHAR(20) DEFAULT 'online',
    firmware VARCHAR(10) DEFAULT '1.4.2',
    battery_mv INTEGER DEFAULT 3600,
    rssi INTEGER DEFAULT -85,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Telemetry log (append-only)
CREATE TABLE IF NOT EXISTS telemetry_log (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(50),
    pole_id VARCHAR(20),
    event VARCHAR(20),
    energized BOOLEAN,
    ts TIMESTAMPTZ,
    seq BIGINT,
    battery_mv INTEGER,
    rssi INTEGER,
    fw VARCHAR(10),
    received_at TIMESTAMPTZ DEFAULT NOW(),
    is_duplicate BOOLEAN DEFAULT FALSE,
    is_stale BOOLEAN DEFAULT FALSE
);

-- Fault tickets
CREATE TABLE IF NOT EXISTS tickets (
    ticket_id VARCHAR(30) PRIMARY KEY,
    fault_type VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'detected',
    
    -- Location
    fault_span_from VARCHAR(20),
    fault_span_to VARCHAR(20),
    fault_dt_id VARCHAR(20),
    fault_feeder_id VARCHAR(20),
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    pincode VARCHAR(10),
    
    -- Impact
    affected_poles_count INTEGER DEFAULT 0,
    affected_households INTEGER DEFAULT 0,
    
    -- Confidence
    confidence VARCHAR(10) DEFAULT 'medium',
    confidence_reason TEXT,
    localization_type VARCHAR(20) DEFAULT 'dt_level',
    
    -- AI summary
    ai_summary TEXT,
    
    -- Timestamps
    detected_at TIMESTAMPTZ DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    crew_assigned_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    
    -- Verification
    verified_by_telemetry BOOLEAN DEFAULT FALSE,
    resolution_rejected BOOLEAN DEFAULT FALSE,
    rejection_reason TEXT
);

-- Affected poles per ticket
CREATE TABLE IF NOT EXISTS ticket_affected_poles (
    ticket_id VARCHAR(30) REFERENCES tickets(ticket_id),
    pole_id VARCHAR(20) REFERENCES poles(pole_id),
    was_dark BOOLEAN DEFAULT TRUE,
    restored BOOLEAN DEFAULT FALSE,
    restored_at TIMESTAMPTZ,
    PRIMARY KEY (ticket_id, pole_id)
);

-- Scheduled outages (mock)
CREATE TABLE IF NOT EXISTS scheduled_outages (
    id VARCHAR(30) PRIMARY KEY,
    scope VARCHAR(10) NOT NULL,
    target_id VARCHAR(20) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    reason TEXT,
    is_cancelled BOOLEAN DEFAULT FALSE
);

-- ============ INDEXES ============

-- Poles: we query by DT, feeder, and parent frequently
CREATE INDEX IF NOT EXISTS idx_poles_dt ON poles(dt_id);
CREATE INDEX IF NOT EXISTS idx_poles_feeder ON poles(feeder_id);
CREATE INDEX IF NOT EXISTS idx_poles_parent ON poles(parent_pole_id);
CREATE INDEX IF NOT EXISTS idx_poles_device ON poles(device_id);

-- Device state: heartbeat monitor queries
CREATE INDEX IF NOT EXISTS idx_device_state_status ON device_state(status);
CREATE INDEX IF NOT EXISTS idx_device_state_last_seen ON device_state(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_device_state_energized ON device_state(energized);

-- Telemetry: query by pole and time
CREATE INDEX IF NOT EXISTS idx_telemetry_pole ON telemetry_log(pole_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_received ON telemetry_log(received_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_seq ON telemetry_log(device_id, seq);

-- Tickets: filter by status
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_dt ON tickets(fault_dt_id);
CREATE INDEX IF NOT EXISTS idx_tickets_detected ON tickets(detected_at);

-- Ticket affected poles
CREATE INDEX IF NOT EXISTS idx_ticket_affected_ticket ON ticket_affected_poles(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_affected_restored ON ticket_affected_poles(restored);
