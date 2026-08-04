/**
 * Scheduled outage routes (mock).
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/scheduled-outages
router.get('/', async (req, res) => {
  try {
    const { from, to } = req.query;
    let query = 'SELECT * FROM scheduled_outages';
    const params = [];

    if (from && to) {
      query += ' WHERE start_time >= $1 AND end_time <= $2';
      params.push(from, to);
    } else {
      // Default: show outages from last 24h to next 48h
      query += ` WHERE end_time >= NOW() - INTERVAL '24 hours' AND start_time <= NOW() + INTERVAL '48 hours'`;
    }

    query += ' ORDER BY start_time';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
