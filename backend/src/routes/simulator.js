/**
 * Fault Simulator — generates realistic telemetry for testing.
 * 
 * Supports:
 *   - Span fault: one wire breaks, downstream poles go dark
 *   - DT fault: transformer fails, all poles under it go dark
 *   - Feeder fault: feeder goes down, all DTs on it go dark
 *   - Noise: individual device failure, scheduled outage
 *   - Repair: restore power and generate restoration telemetry
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { runLocalization } = require('../services/localization');

// ─── Inject a fault ──────────────────────────────────────────────────────────

router.post('/inject-fault', async (req, res) => {
  try {
    const { fault_type, dt_id, feeder_id, pole_id } = req.body;
    const broadcastSSE = req.app.get('broadcastSSE');

    if (!fault_type) {
      return res.status(400).json({ error: 'fault_type is required (span, dt, feeder)' });
    }

    let affectedPoles = [];
    let description = '';

    if (fault_type === 'feeder') {
      if (!feeder_id) return res.status(400).json({ error: 'feeder_id required for feeder fault' });

      // All poles on this feeder go dark
      const result = await pool.query(
        `SELECT p.pole_id FROM poles p WHERE p.feeder_id = $1 AND p.has_device = true`,
        [feeder_id]
      );
      affectedPoles = result.rows.map(r => r.pole_id);
      description = `Feeder fault on ${feeder_id} — ${affectedPoles.length} poles affected`;

    } else if (fault_type === 'dt') {
      if (!dt_id) return res.status(400).json({ error: 'dt_id required for DT fault' });

      // All poles under this DT go dark
      const result = await pool.query(
        `SELECT p.pole_id FROM poles p WHERE p.dt_id = $1 AND p.has_device = true`,
        [dt_id]
      );
      affectedPoles = result.rows.map(r => r.pole_id);
      description = `DT fault on ${dt_id} — ${affectedPoles.length} poles affected`;

    } else if (fault_type === 'span') {
      if (!dt_id) return res.status(400).json({ error: 'dt_id required for span fault' });

      // Get the DT's topology status
      const dtInfo = await pool.query('SELECT has_topology FROM transformers WHERE dt_id = $1', [dt_id]);
      if (dtInfo.rows.length === 0) return res.status(404).json({ error: 'DT not found' });

      if (dtInfo.rows[0].has_topology && !pole_id) {
        // Pick a random pole with children to make it interesting
        const candidates = await pool.query(`
          SELECT p.pole_id, p.seq_on_line FROM poles p
          WHERE p.dt_id = $1 AND p.seq_on_line IS NOT NULL AND p.has_device = true
          AND p.seq_on_line > 3
          ORDER BY RANDOM() LIMIT 1
        `, [dt_id]);

        if (candidates.rows.length === 0) {
          return res.status(400).json({ error: 'No suitable pole found for span fault' });
        }

        const faultPoleId = pole_id || candidates.rows[0].pole_id;

        // Get all downstream poles (seq_on_line >= fault pole's seq, and children of children)
        // Simple approach: all poles with higher seq_on_line or that are children in the subtree
        const downstream = await pool.query(`
          WITH RECURSIVE subtree AS (
            SELECT pole_id FROM poles WHERE pole_id = $1
            UNION ALL
            SELECT p.pole_id FROM poles p
            JOIN subtree s ON p.parent_pole_id = s.pole_id
          )
          SELECT pole_id FROM subtree
          WHERE pole_id IN (SELECT pole_id FROM poles WHERE has_device = true)
        `, [faultPoleId]);

        affectedPoles = downstream.rows.map(r => r.pole_id);
        description = `Span fault at ${faultPoleId} on DT ${dt_id} — ${affectedPoles.length} poles affected downstream`;

      } else {
        // No topology or specific pole — just pick ~40% of poles under the DT
        const result = await pool.query(
          `SELECT p.pole_id FROM poles p WHERE p.dt_id = $1 AND p.has_device = true ORDER BY RANDOM()`,
          [dt_id]
        );
        const allPoles = result.rows.map(r => r.pole_id);
        const cutPoint = Math.max(3, Math.floor(allPoles.length * 0.4));
        affectedPoles = allPoles.slice(0, cutPoint);
        description = `Span fault on DT ${dt_id} (no topology) — ${affectedPoles.length} poles affected`;
      }

    } else {
      return res.status(400).json({ error: 'Invalid fault_type. Use: span, dt, feeder' });
    }

    if (affectedPoles.length === 0) {
      return res.status(400).json({ error: 'No poles would be affected by this fault' });
    }

    // Simulate telemetry: set poles to dark with realistic constraints
    let powerLostSent = 0;
    let silentDeath = 0;
    const telemetryMessages = [];

    for (const pId of affectedPoles) {
      // Get device info
      const deviceInfo = await pool.query(
        'SELECT device_id, firmware, last_seq FROM device_state WHERE pole_id = $1',
        [pId]
      );

      if (deviceInfo.rows.length === 0) continue;
      const device = deviceInfo.rows[0];

      // Update device state to dark
      await pool.query(
        `UPDATE device_state SET energized = false, updated_at = NOW() WHERE pole_id = $1`,
        [pId]
      );

      // Simulate power_lost message
      const isOldFirmware = device.firmware && device.firmware.startsWith('1.2');
      const messageSurvives = Math.random() < 0.7; // 70% success rate

      if (!isOldFirmware && messageSurvives) {
        // Firmware ≥ 1.3 and message succeeds
        const newSeq = (parseInt(device.last_seq) || 0) + 1;
        const skew = (Math.random() - 0.5) * 180; // ±90 seconds
        const ts = new Date(Date.now() + skew * 1000).toISOString();

        const msg = {
          device_id: device.device_id,
          pole_id: pId,
          event: 'power_lost',
          energized: false,
          ts: ts,
          seq: newSeq,
          battery_mv: Math.floor(Math.random() * 400 + 3000),
          rssi: Math.floor(Math.random() * 30 - 100),
          fw: device.firmware || '1.4.2',
        };

        // Log telemetry
        await pool.query(
          `INSERT INTO telemetry_log (device_id, pole_id, event, energized, ts, seq, battery_mv, rssi, fw)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [msg.device_id, msg.pole_id, msg.event, msg.energized, msg.ts, msg.seq, msg.battery_mv, msg.rssi, msg.fw]
        );

        // Update seq
        await pool.query(
          `UPDATE device_state SET last_seq = $1 WHERE pole_id = $2`,
          [newSeq, pId]
        );

        telemetryMessages.push(msg);
        powerLostSent++;
      } else {
        // Silent death — old firmware or message failed
        silentDeath++;
      }
    }

    // Broadcast fault injection
    if (broadcastSSE) {
      broadcastSSE('fault_injected', {
        fault_type,
        description,
        affected_count: affectedPoles.length,
        power_lost_sent: powerLostSent,
        silent_deaths: silentDeath,
      });
    }

    // Trigger localization immediately
    setTimeout(() => runLocalization(pool, broadcastSSE), 1000);

    res.json({
      status: 'ok',
      description,
      affected_poles: affectedPoles.length,
      power_lost_messages_sent: powerLostSent,
      silent_deaths: silentDeath,
      message: 'Fault injected. Localization will run shortly.',
    });

  } catch (err) {
    console.error('Simulator inject error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Repair a fault ──────────────────────────────────────────────────────────

router.post('/repair-fault', async (req, res) => {
  try {
    const { ticket_id, dt_id, feeder_id } = req.body;
    const broadcastSSE = req.app.get('broadcastSSE');

    let polesToRestore = [];

    if (ticket_id) {
      // Restore all poles in this ticket
      const affected = await pool.query(
        'SELECT pole_id FROM ticket_affected_poles WHERE ticket_id = $1',
        [ticket_id]
      );
      polesToRestore = affected.rows.map(r => r.pole_id);
    } else if (dt_id) {
      // Restore all dark poles under this DT
      const result = await pool.query(`
        SELECT ds.pole_id FROM device_state ds
        JOIN poles p ON ds.pole_id = p.pole_id
        WHERE p.dt_id = $1 AND ds.energized = false
      `, [dt_id]);
      polesToRestore = result.rows.map(r => r.pole_id);
    } else if (feeder_id) {
      // Restore all dark poles on this feeder
      const result = await pool.query(`
        SELECT ds.pole_id FROM device_state ds
        JOIN poles p ON ds.pole_id = p.pole_id
        WHERE p.feeder_id = $1 AND ds.energized = false
      `, [feeder_id]);
      polesToRestore = result.rows.map(r => r.pole_id);
    } else {
      return res.status(400).json({ error: 'Provide ticket_id, dt_id, or feeder_id' });
    }

    // Restore power and generate restoration telemetry
    for (const pId of polesToRestore) {
      const deviceInfo = await pool.query(
        'SELECT device_id, firmware, last_seq FROM device_state WHERE pole_id = $1',
        [pId]
      );

      if (deviceInfo.rows.length === 0) continue;
      const device = deviceInfo.rows[0];
      const newSeq = (parseInt(device.last_seq) || 0) + 1;

      // Update state
      await pool.query(
        `UPDATE device_state SET energized = true, status = 'online', last_seen_at = NOW(), last_seq = $1, updated_at = NOW() WHERE pole_id = $2`,
        [newSeq + 1, pId]
      );

      // Generate boot + power_restored telemetry
      const ts = new Date().toISOString();
      await pool.query(
        `INSERT INTO telemetry_log (device_id, pole_id, event, energized, ts, seq, fw)
         VALUES ($1, $2, 'boot', true, $3, $4, $5)`,
        [device.device_id, pId, ts, newSeq, device.firmware]
      );
      await pool.query(
        `INSERT INTO telemetry_log (device_id, pole_id, event, energized, ts, seq, fw)
         VALUES ($1, $2, 'power_restored', true, $3, $4, $5)`,
        [device.device_id, pId, ts, newSeq + 1, device.firmware]
      );
    }

    // Broadcast
    if (broadcastSSE) {
      broadcastSSE('fault_repaired', {
        poles_restored: polesToRestore.length,
        ticket_id,
      });
    }

    // Trigger localization to auto-verify
    setTimeout(() => runLocalization(pool, broadcastSSE), 2000);

    res.json({
      status: 'ok',
      poles_restored: polesToRestore.length,
      message: 'Power restored. Auto-verification will run shortly.',
    });

  } catch (err) {
    console.error('Simulator repair error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Inject noise (dead sensor) ──────────────────────────────────────────────

router.post('/inject-noise', async (req, res) => {
  try {
    const { type, pole_id, dt_id } = req.body;
    const broadcastSSE = req.app.get('broadcastSSE');

    if (type === 'dead_sensor') {
      // Kill a specific device — power stays on but device stops responding
      const targetPole = pole_id || (await pool.query(
        `SELECT pole_id FROM device_state WHERE status = 'online' ORDER BY RANDOM() LIMIT 1`
      )).rows[0]?.pole_id;

      if (!targetPole) return res.status(400).json({ error: 'No online device found' });

      await pool.query(
        `UPDATE device_state SET status = 'offline', last_seen_at = NOW() - INTERVAL '2 hours', updated_at = NOW() WHERE pole_id = $1`,
        [targetPole]
      );

      res.json({ status: 'ok', type: 'dead_sensor', pole_id: targetPole, message: 'Device marked as offline. Power is still on.' });

    } else if (type === 'scheduled_outage') {
      // Create a scheduled outage for a DT or feeder
      const targetDt = dt_id || (await pool.query('SELECT dt_id FROM transformers ORDER BY RANDOM() LIMIT 1')).rows[0]?.dt_id;
      const now = new Date();
      const start = new Date(now.getTime() - 5 * 60000); // started 5 min ago
      const end = new Date(now.getTime() + 2 * 3600000); // ends in 2 hours

      await pool.query(
        `INSERT INTO scheduled_outages (id, scope, target_id, start_time, end_time, reason)
         VALUES ($1, 'dt', $2, $3, $4, 'Simulated load shedding')
         ON CONFLICT (id) DO NOTHING`,
        [`SO-SIM-${Date.now()}`, targetDt, start.toISOString(), end.toISOString()]
      );

      res.json({ status: 'ok', type: 'scheduled_outage', dt_id: targetDt, start: start.toISOString(), end: end.toISOString() });

    } else {
      return res.status(400).json({ error: 'type must be: dead_sensor, scheduled_outage' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get simulator state ────────────────────────────────────────────────────

router.get('/state', async (req, res) => {
  try {
    const dark = await pool.query('SELECT COUNT(*) as count FROM device_state WHERE energized = false');
    const overdue = await pool.query(`SELECT COUNT(*) as count FROM device_state WHERE status = 'overdue'`);
    const offline = await pool.query(`SELECT COUNT(*) as count FROM device_state WHERE status = 'offline'`);
    const tickets = await pool.query(`SELECT COUNT(*) as count FROM tickets WHERE status NOT IN ('closed')`);

    // Get list of DTs and feeders for the simulator UI
    const dts = await pool.query('SELECT dt_id, feeder_id, has_topology, households_served FROM transformers ORDER BY dt_id LIMIT 50');
    const feeders = await pool.query('SELECT feeder_id FROM feeders ORDER BY feeder_id');

    res.json({
      dark_poles: parseInt(dark.rows[0].count),
      overdue_devices: parseInt(overdue.rows[0].count),
      offline_devices: parseInt(offline.rows[0].count),
      open_tickets: parseInt(tickets.rows[0].count),
      transformers: dts.rows,
      feeders: feeders.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
