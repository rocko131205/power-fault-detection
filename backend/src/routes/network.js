/**
 * Network data routes — poles, transformers, stats.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/network/stats — Dashboard summary
router.get('/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM poles) as total_poles,
        (SELECT COUNT(*) FROM poles WHERE has_device = true) as poles_with_device,
        (SELECT COUNT(*) FROM transformers) as total_dts,
        (SELECT COUNT(*) FROM transformers WHERE has_topology = true) as dts_with_topology,
        (SELECT COUNT(*) FROM feeders) as total_feeders,
        (SELECT COUNT(*) FROM device_state WHERE energized = false) as dark_poles,
        (SELECT COUNT(*) FROM device_state WHERE status = 'overdue') as overdue_devices,
        (SELECT COUNT(*) FROM device_state WHERE status = 'offline') as offline_devices,
        (SELECT COUNT(*) FROM tickets WHERE status NOT IN ('closed', 'verified')) as active_tickets,
        (SELECT COUNT(*) FROM scheduled_outages WHERE start_time <= NOW() AND end_time >= NOW()) as active_outages
    `);
    res.json(stats.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/network/poles — All poles with device state
router.get('/poles', async (req, res) => {
  try {
    const { dt_id, feeder_id } = req.query;
    let query = `
      SELECT p.*, 
        ds.energized, ds.status as device_status, ds.last_seen_at, ds.firmware,
        ds.battery_mv, ds.rssi
      FROM poles p
      LEFT JOIN device_state ds ON p.pole_id = ds.pole_id
    `;
    const params = [];

    if (dt_id) {
      query += ' WHERE p.dt_id = $1';
      params.push(dt_id);
    } else if (feeder_id) {
      query += ' WHERE p.feeder_id = $1';
      params.push(feeder_id);
    }

    query += ' ORDER BY p.dt_id, p.seq_on_line NULLS LAST';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/network/transformers — All DTs with status
router.get('/transformers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM poles WHERE dt_id = t.dt_id) as pole_count,
        (SELECT COUNT(*) FROM device_state ds JOIN poles p ON ds.pole_id = p.pole_id WHERE p.dt_id = t.dt_id AND ds.energized = false) as dark_count
      FROM transformers t
      ORDER BY t.dt_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/network/feeders — All feeders
router.get('/feeders', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT f.*,
        (SELECT COUNT(*) FROM transformers WHERE feeder_id = f.feeder_id) as dt_count,
        (SELECT COUNT(*) FROM poles WHERE feeder_id = f.feeder_id) as pole_count
      FROM feeders f
      ORDER BY f.feeder_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
