/**
 * Telemetry ingestion route.
 * 
 * Accepts POST /api/telemetry with device messages.
 * Handles: deduplication (via seq), stale detection, ordering, and state updates.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Accept single message or batch
router.post('/', async (req, res) => {
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const results = { accepted: 0, duplicates: 0, stale: 0, errors: 0 };

  for (const msg of messages) {
    try {
      const { device_id, pole_id, event, energized, ts, seq, battery_mv, rssi, fw } = msg;

      if (!pole_id || !event) {
        results.errors++;
        continue;
      }

      // Check for duplicate or stale message via seq number
      const stateResult = await pool.query(
        'SELECT last_seq, energized as prev_energized FROM device_state WHERE pole_id = $1',
        [pole_id]
      );

      let isDuplicate = false;
      let isStale = false;

      if (stateResult.rows.length > 0) {
        const { last_seq, prev_energized } = stateResult.rows[0];

        // Duplicate: same or lower seq
        if (seq != null && last_seq != null && seq <= last_seq) {
          isDuplicate = true;
          results.duplicates++;
        }

        // Stale: message timestamp is more than 30 minutes old
        if (ts) {
          const messageAge = Date.now() - new Date(ts).getTime();
          if (messageAge > 30 * 60 * 1000) {
            isStale = true;
            results.stale++;
          }
        }
      }

      // Log all messages (even duplicates, for audit trail)
      await pool.query(
        `INSERT INTO telemetry_log (device_id, pole_id, event, energized, ts, seq, battery_mv, rssi, fw, is_duplicate, is_stale)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [device_id, pole_id, event, energized, ts, seq, battery_mv, rssi, fw, isDuplicate, isStale]
      );

      // Only update state for non-duplicate, non-stale messages
      if (!isDuplicate && !isStale) {
        await pool.query(
          `INSERT INTO device_state (pole_id, device_id, last_seen_at, last_seq, energized, status, firmware, battery_mv, rssi, updated_at)
           VALUES ($1, $2, NOW(), $3, $4, 'online', $5, $6, $7, NOW())
           ON CONFLICT (pole_id) DO UPDATE SET
             device_id = COALESCE($2, device_state.device_id),
             last_seen_at = NOW(),
             last_seq = GREATEST(COALESCE($3, device_state.last_seq), device_state.last_seq),
             energized = $4,
             status = 'online',
             firmware = COALESCE($5, device_state.firmware),
             battery_mv = COALESCE($6, device_state.battery_mv),
             rssi = COALESCE($7, device_state.rssi),
             updated_at = NOW()`,
          [pole_id, device_id, seq, energized, fw, battery_mv, rssi]
        );

        // Broadcast state change via SSE
        const broadcastSSE = req.app.get('broadcastSSE');
        if (broadcastSSE) {
          broadcastSSE('device_update', { pole_id, event, energized, ts });
        }

        results.accepted++;
      }
    } catch (err) {
      console.error('Telemetry processing error:', err.message);
      results.errors++;
    }
  }

  res.json({ status: 'ok', ...results });
});

module.exports = router;
