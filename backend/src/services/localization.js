/**
 * Fault Localization Service — THE CORE ALGORITHM
 * 
 * Runs periodically and on-demand. Turns dark pole signals into located faults.
 * 
 * Algorithm:
 *   1. Collect all dark/overdue poles (excluding scheduled outages & existing tickets)
 *   2. Group by DT
 *   3. For each DT group:
 *      a. Filter out dead sensors (dark pole with live children)
 *      b. Check for DT-level fault (all poles dark)
 *      c. Check for feeder-level fault (all DTs on feeder dark)
 *      d. Find span-level fault boundary (if topology available)
 *      e. Approximate fault area (if no topology)
 *   4. Create tickets (one per fault, not per pole)
 *   5. Auto-verify restoration for existing tickets
 */

const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { generateAISummary } = require('./ai');
const config = require('../config');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check if a pole is covered by an active scheduled outage.
 */
async function isScheduledOutage(pool, feederId, dtId) {
  const buffer = config.scheduledOutageBufferMin;
  const result = await pool.query(`
    SELECT COUNT(*) as count FROM scheduled_outages
    WHERE is_cancelled = false
      AND (
        (scope = 'feeder' AND target_id = $1)
        OR (scope = 'dt' AND target_id = $2)
      )
      AND start_time <= NOW() + INTERVAL '${buffer} minutes'
      AND end_time >= NOW() - INTERVAL '${buffer} minutes'
  `, [feederId, dtId]);
  return parseInt(result.rows[0].count) > 0;
}

/**
 * Find the PIN code for a fault location.
 * Falls back to nearest pole's pincode if the primary pole has none.
 */
async function findPincode(pool, lat, lon, dtId) {
  // First try: get pincode from nearest pole that has one
  const result = await pool.query(`
    SELECT pincode FROM poles
    WHERE dt_id = $1 AND pincode IS NOT NULL
    ORDER BY (lat - $2) * (lat - $2) + (lon - $3) * (lon - $3)
    LIMIT 1
  `, [dtId, lat, lon]);
  
  if (result.rows.length > 0) return result.rows[0].pincode;
  
  // Fallback: any pole in the same DT
  const fallback = await pool.query(
    `SELECT pincode FROM poles WHERE dt_id = $1 AND pincode IS NOT NULL LIMIT 1`,
    [dtId]
  );
  return fallback.rows.length > 0 ? fallback.rows[0].pincode : 'UNKNOWN';
}

/**
 * Build the tree structure for poles under a DT (only when topology is available).
 * Returns a map: pole_id → { pole, children: [] }
 */
function buildTree(poles) {
  const nodeMap = {};
  const roots = [];

  // Create nodes
  for (const pole of poles) {
    nodeMap[pole.pole_id] = { ...pole, children: [] };
  }

  // Link children to parents
  for (const pole of poles) {
    if (pole.parent_pole_id && nodeMap[pole.parent_pole_id]) {
      nodeMap[pole.parent_pole_id].children.push(nodeMap[pole.pole_id]);
    } else if (pole.parent_pole_id && pole.parent_pole_id.startsWith('D-')) {
      // Parent is the DT itself — this is a root pole
      roots.push(nodeMap[pole.pole_id]);
    } else if (!pole.parent_pole_id && pole.seq_on_line === 1) {
      roots.push(nodeMap[pole.pole_id]);
    }
  }

  // If no roots found (edge case), use poles with seq=1
  if (roots.length === 0) {
    for (const pole of poles) {
      if (pole.seq_on_line === 1) {
        roots.push(nodeMap[pole.pole_id]);
      }
    }
  }

  return { nodeMap, roots };
}

/**
 * Check if a pole is "dark" — either explicitly reported dark, or overdue.
 */
function isPoleDark(pole) {
  if (!pole.has_device) return null; // unknown — no sensor
  if (pole.device_status === 'offline') return null; // dead modem — unreliable
  if (pole.energized === false) return true;
  if (pole.device_status === 'overdue') return true;
  return false;
}

/**
 * Find fault boundaries by walking the tree.
 * Returns array of { from_pole, to_pole, affected_poles }
 */
function findFaultBoundaries(roots) {
  const faults = [];

  function walk(node, parentLive) {
    const dark = isPoleDark(node);

    if (dark === null) {
      // Unknown state (no device or dead modem) — pass through
      for (const child of node.children) {
        walk(child, parentLive);
      }
      return;
    }

    if (dark && parentLive) {
      // BOUNDARY FOUND: parent is live, this node is dark
      // This is a fault on the span between parent and this node
      const affectedPoles = collectDarkSubtree(node);
      faults.push({
        from_pole: node.parent_pole_id, // last live pole
        to_pole: node.pole_id,          // first dark pole
        affected_poles: affectedPoles,
      });
      return; // Don't walk deeper — everything below is affected by same fault
    }

    if (!dark) {
      // This node is live — check children
      // Also: if this node is live but was expected to be dark (children reported dark first due to timing),
      // that's fine — children will be caught in the next iteration
      for (const child of node.children) {
        walk(child, true);
      }
    } else {
      // This node is dark and parent was also dark (or unknown)
      // Part of an existing fault's affected area — don't create new fault
      for (const child of node.children) {
        walk(child, false);
      }
    }
  }

  for (const root of roots) {
    walk(root, true); // DT is the parent, assumed live
  }

  return faults;
}

/**
 * Collect all dark poles in a subtree (for counting affected poles).
 */
function collectDarkSubtree(node) {
  const affected = [node.pole_id];
  for (const child of node.children) {
    const dark = isPoleDark(child);
    if (dark !== false) { // dark or unknown
      affected.push(...collectDarkSubtree(child));
    }
  }
  return affected;
}

/**
 * Detect dead sensors: a dark pole whose children are all live.
 * This is physically impossible for a real power fault.
 */
function detectDeadSensors(roots) {
  const deadSensors = [];

  function walk(node) {
    const dark = isPoleDark(node);
    if (dark && node.children.length > 0) {
      const liveChildren = node.children.filter(c => isPoleDark(c) === false);
      if (liveChildren.length > 0) {
        // Dark pole with live children — impossible for real fault
        deadSensors.push(node.pole_id);
      }
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  for (const root of roots) {
    walk(root);
  }

  return deadSensors;
}

// ─── Main Localization Loop ─────────────────────────────────────────────────

async function runLocalization(pool, broadcastSSE) {
  try {
    // 1. Get all DTs that have dark poles
    const darkDTs = await pool.query(`
      SELECT DISTINCT p.dt_id, p.feeder_id, t.has_topology, t.lat as dt_lat, t.lon as dt_lon,
        t.households_served
      FROM poles p
      JOIN device_state ds ON p.pole_id = ds.pole_id
      JOIN transformers t ON p.dt_id = t.dt_id
      WHERE (ds.energized = false OR ds.status = 'overdue')
      AND p.pole_id NOT IN (
        SELECT tap.pole_id FROM ticket_affected_poles tap
        JOIN tickets tk ON tap.ticket_id = tk.ticket_id
        WHERE tk.status NOT IN ('closed', 'verified')
      )
    `);

    if (darkDTs.rows.length === 0) {
      // No new dark poles — check for auto-verification instead
      await checkRestorations(pool, broadcastSSE);
      return;
    }

    for (const dt of darkDTs.rows) {
      // Check scheduled outage
      const scheduled = await isScheduledOutage(pool, dt.feeder_id, dt.dt_id);
      if (scheduled) {
        continue; // Skip — this is a planned outage
      }

      // Get all poles under this DT with their device state
      const polesResult = await pool.query(`
        SELECT p.*, ds.energized, ds.status as device_status, ds.last_seen_at, ds.firmware
        FROM poles p
        LEFT JOIN device_state ds ON p.pole_id = ds.pole_id
        WHERE p.dt_id = $1
        ORDER BY p.seq_on_line NULLS LAST
      `, [dt.dt_id]);

      const poles = polesResult.rows;
      const darkPoles = poles.filter(p => isPoleDark(p) === true);
      const livePoles = poles.filter(p => isPoleDark(p) === false);
      const totalWithDevice = poles.filter(p => p.has_device).length;

      if (darkPoles.length === 0) continue;

      // Check for feeder-level fault: are ALL DTs on this feeder dark?
      const feederCheck = await pool.query(`
        SELECT t.dt_id,
          (SELECT COUNT(*) FROM device_state ds JOIN poles p ON ds.pole_id = p.pole_id WHERE p.dt_id = t.dt_id AND ds.energized = true) as live_count
        FROM transformers t
        WHERE t.feeder_id = $1
      `, [dt.feeder_id]);

      const allDTsDark = feederCheck.rows.every(r => parseInt(r.live_count) === 0);

      if (allDTsDark && feederCheck.rows.length > 1) {
        // FEEDER FAULT — check if ticket already exists for this feeder
        const existingFeeder = await pool.query(
          `SELECT ticket_id FROM tickets WHERE fault_feeder_id = $1 AND status NOT IN ('closed', 'verified')`,
          [dt.feeder_id]
        );
        if (existingFeeder.rows.length > 0) continue;

        // Create feeder fault ticket
        const ticketId = `TKT-${Date.now()}-F`;
        const allFeederPoles = await pool.query(
          `SELECT pole_id FROM poles WHERE feeder_id = $1`, [dt.feeder_id]
        );
        const totalHouseholds = feederCheck.rows.reduce((sum, r) => sum + (r.households_served || 0), 0);

        await createTicket(pool, broadcastSSE, {
          ticket_id: ticketId,
          fault_type: 'feeder',
          fault_feeder_id: dt.feeder_id,
          fault_dt_id: dt.dt_id,
          lat: dt.dt_lat,
          lon: dt.dt_lon,
          pincode: await findPincode(pool, dt.dt_lat, dt.dt_lon, dt.dt_id),
          affected_poles: allFeederPoles.rows.map(r => r.pole_id),
          affected_households: totalHouseholds,
          confidence: 'high',
          confidence_reason: `All ${feederCheck.rows.length} transformers on feeder ${dt.feeder_id} are dark. Indicates feeder-level fault.`,
          localization_type: 'feeder_level',
        });
        continue;
      }

      // Check for DT-level fault: ALL poles under this DT are dark
      if (darkPoles.length >= totalWithDevice * 0.9 && livePoles.length === 0) {
        // DT FAULT
        const existingDT = await pool.query(
          `SELECT ticket_id FROM tickets WHERE fault_dt_id = $1 AND status NOT IN ('closed', 'verified')`,
          [dt.dt_id]
        );
        if (existingDT.rows.length > 0) continue;

        const ticketId = `TKT-${Date.now()}-D`;
        await createTicket(pool, broadcastSSE, {
          ticket_id: ticketId,
          fault_type: 'dt',
          fault_dt_id: dt.dt_id,
          fault_feeder_id: dt.feeder_id,
          lat: dt.dt_lat,
          lon: dt.dt_lon,
          pincode: await findPincode(pool, dt.dt_lat, dt.dt_lon, dt.dt_id),
          affected_poles: darkPoles.map(p => p.pole_id),
          affected_households: dt.households_served || 0,
          confidence: 'high',
          confidence_reason: `All ${darkPoles.length} monitored poles under DT ${dt.dt_id} are dark. Indicates transformer or HT fuse fault.`,
          localization_type: 'dt_level',
        });
        continue;
      }

      // SPAN FAULT — some poles dark, some live
      if (dt.has_topology) {
        // ─── 40% case: topology available → precise span-level localization ───
        const { nodeMap, roots } = buildTree(poles);

        // Detect dead sensors first
        const deadSensors = detectDeadSensors(roots);
        if (deadSensors.length > 0) {
          console.log(`🔧 Dead sensors detected at DT ${dt.dt_id}: ${deadSensors.join(', ')}`);
        }

        // Find fault boundaries
        const boundaries = findFaultBoundaries(roots);

        for (const boundary of boundaries) {
          // Skip if it's just a dead sensor
          if (deadSensors.includes(boundary.to_pole) && boundary.affected_poles.length <= 1) {
            continue;
          }

          const existingSpan = await pool.query(
            `SELECT ticket_id FROM tickets WHERE fault_span_from = $1 AND fault_span_to = $2 AND status NOT IN ('closed', 'verified')`,
            [boundary.from_pole, boundary.to_pole]
          );
          if (existingSpan.rows.length > 0) continue;

          // Calculate fault coordinates (midpoint of the span)
          const fromPole = nodeMap[boundary.from_pole] || poles.find(p => p.pole_id === boundary.from_pole);
          const toPole = nodeMap[boundary.to_pole];

          let faultLat, faultLon;
          if (fromPole && toPole) {
            faultLat = (parseFloat(fromPole.lat) + parseFloat(toPole.lat)) / 2;
            faultLon = (parseFloat(fromPole.lon) + parseFloat(toPole.lon)) / 2;
          } else if (toPole) {
            faultLat = parseFloat(toPole.lat);
            faultLon = parseFloat(toPole.lon);
          }

          const ticketId = `TKT-${Date.now()}-S-${boundary.to_pole}`;
          await createTicket(pool, broadcastSSE, {
            ticket_id: ticketId,
            fault_type: 'span',
            fault_span_from: boundary.from_pole,
            fault_span_to: boundary.to_pole,
            fault_dt_id: dt.dt_id,
            fault_feeder_id: dt.feeder_id,
            lat: faultLat,
            lon: faultLon,
            pincode: await findPincode(pool, faultLat, faultLon, dt.dt_id),
            affected_poles: boundary.affected_poles,
            affected_households: Math.round((boundary.affected_poles.length / poles.length) * (dt.households_served || 0)),
            confidence: 'high',
            confidence_reason: `Span fault detected between ${boundary.from_pole} (live) and ${boundary.to_pole} (dark). ${boundary.affected_poles.length} poles affected downstream. Topology data available for this DT.`,
            localization_type: 'span_level',
          });
        }
      } else {
        // ─── 60% case: no topology → approximate DT-level localization ───
        const existingDT = await pool.query(
          `SELECT ticket_id FROM tickets WHERE fault_dt_id = $1 AND fault_type = 'span' AND status NOT IN ('closed', 'verified')`,
          [dt.dt_id]
        );
        if (existingDT.rows.length > 0) continue;

        // Calculate centroid of dark poles for approximate location
        const darkLat = darkPoles.reduce((sum, p) => sum + parseFloat(p.lat), 0) / darkPoles.length;
        const darkLon = darkPoles.reduce((sum, p) => sum + parseFloat(p.lon), 0) / darkPoles.length;

        // Find nearest live pole to the dark cluster
        let nearestLive = null;
        let minDist = Infinity;
        for (const lp of livePoles) {
          const dist = Math.sqrt(
            Math.pow(parseFloat(lp.lat) - darkLat, 2) +
            Math.pow(parseFloat(lp.lon) - darkLon, 2)
          );
          if (dist < minDist) {
            minDist = dist;
            nearestLive = lp;
          }
        }

        const ticketId = `TKT-${Date.now()}-A`;
        await createTicket(pool, broadcastSSE, {
          ticket_id: ticketId,
          fault_type: 'span',
          fault_span_from: nearestLive ? nearestLive.pole_id : null,
          fault_span_to: darkPoles[0].pole_id,
          fault_dt_id: dt.dt_id,
          fault_feeder_id: dt.feeder_id,
          lat: nearestLive ? (parseFloat(nearestLive.lat) + darkLat) / 2 : darkLat,
          lon: nearestLive ? (parseFloat(nearestLive.lon) + darkLon) / 2 : darkLon,
          pincode: await findPincode(pool, darkLat, darkLon, dt.dt_id),
          affected_poles: darkPoles.map(p => p.pole_id),
          affected_households: Math.round((darkPoles.length / poles.length) * (dt.households_served || 0)),
          confidence: nearestLive ? 'medium' : 'low',
          confidence_reason: `Approximate localization — topology data is not available for DT ${dt.dt_id}. ${darkPoles.length} dark poles detected. ${nearestLive ? `Nearest live pole: ${nearestLive.pole_id}. Fault is likely in the area between them.` : 'No live poles found under this DT for boundary reference.'}`,
          localization_type: nearestLive ? 'approximate' : 'dt_level',
        });
      }
    }

    // Always check restorations
    await checkRestorations(pool, broadcastSSE);

  } catch (err) {
    console.error('Localization error:', err.message);
  }
}

// ─── Ticket Creation ─────────────────────────────────────────────────────────

async function createTicket(pool, broadcastSSE, data) {
  await pool.query(`
    INSERT INTO tickets (ticket_id, fault_type, status, fault_span_from, fault_span_to,
      fault_dt_id, fault_feeder_id, lat, lon, pincode,
      affected_poles_count, affected_households,
      confidence, confidence_reason, localization_type, detected_at)
    VALUES ($1, $2, 'detected', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
  `, [
    data.ticket_id, data.fault_type, data.fault_span_from, data.fault_span_to,
    data.fault_dt_id, data.fault_feeder_id, data.lat, data.lon, data.pincode,
    data.affected_poles.length, data.affected_households,
    data.confidence, data.confidence_reason, data.localization_type,
  ]);

  // Record affected poles
  for (const poleId of data.affected_poles) {
    await pool.query(
      `INSERT INTO ticket_affected_poles (ticket_id, pole_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [data.ticket_id, poleId]
    );
  }

  console.log(`🎫 Ticket created: ${data.ticket_id} | Type: ${data.fault_type} | Confidence: ${data.confidence} | Affected: ${data.affected_poles.length} poles`);

  broadcastSSE('new_ticket', {
    ticket_id: data.ticket_id,
    fault_type: data.fault_type,
    lat: data.lat,
    lon: data.lon,
    confidence: data.confidence,
    localization_type: data.localization_type,
    affected_poles_count: data.affected_poles.length,
  });

  // Generate AI Summary asynchronously in the background
  generateAISummary(data.ticket_id, broadcastSSE);
}

// ─── Auto-Verification ──────────────────────────────────────────────────────

async function checkRestorations(pool, broadcastSSE) {
  // Find tickets that are not yet verified/closed
  const openTickets = await pool.query(`
    SELECT ticket_id, fault_type, fault_dt_id FROM tickets
    WHERE status IN ('detected', 'acknowledged', 'crew_assigned', 'resolved')
  `);

  for (const ticket of openTickets.rows) {
    // Check if ALL affected poles are now live
    const darkCount = await pool.query(`
      SELECT COUNT(*) as count FROM ticket_affected_poles tap
      JOIN device_state ds ON tap.pole_id = ds.pole_id
      WHERE tap.ticket_id = $1 AND (ds.energized = false OR ds.status = 'overdue')
    `, [ticket.ticket_id]);

    const stillDark = parseInt(darkCount.rows[0].count);

    if (stillDark === 0) {
      // All poles restored — auto-verify
      await pool.query(`
        UPDATE tickets
        SET status = 'verified',
            verified_at = NOW(),
            verified_by_telemetry = true
        WHERE ticket_id = $1 AND status != 'closed'
      `, [ticket.ticket_id]);

      // Mark all affected poles as restored
      await pool.query(`
        UPDATE ticket_affected_poles
        SET restored = true, restored_at = NOW()
        WHERE ticket_id = $1
      `, [ticket.ticket_id]);

      console.log(`✅ Ticket auto-verified: ${ticket.ticket_id}`);

      broadcastSSE('ticket_verified', {
        ticket_id: ticket.ticket_id,
        verified_by: 'telemetry',
        message: 'All affected poles are now energized. Restoration confirmed.',
      });
    } else {
      // Update restored count for partial restoration tracking
      await pool.query(`
        UPDATE ticket_affected_poles tap
        SET restored = true, restored_at = NOW()
        FROM device_state ds
        WHERE tap.pole_id = ds.pole_id
          AND tap.ticket_id = $1
          AND ds.energized = true
          AND tap.restored = false
      `, [ticket.ticket_id]);
    }
  }
}

// ─── Start Loop ──────────────────────────────────────────────────────────────

function startLocalizationLoop(pool, broadcastSSE) {
  const interval = config.localizationIntervalMs;

  async function loop() {
    await runLocalization(pool, broadcastSSE);
  }

  // Run after initial delay (let seed data load)
  setTimeout(() => {
    loop();
    setInterval(loop, interval);
  }, 5000);

  console.log(`   🔍 Localization loop: running every ${interval / 1000}s`);
}

module.exports = { startLocalizationLoop, runLocalization };
