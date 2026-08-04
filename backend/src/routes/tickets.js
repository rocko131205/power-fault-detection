/**
 * Ticket routes — CRUD and lifecycle transitions.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/tickets — List all tickets
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT t.*,
        (SELECT COUNT(*) FROM ticket_affected_poles WHERE ticket_id = t.ticket_id) as affected_poles_detail_count,
        (SELECT COUNT(*) FROM ticket_affected_poles WHERE ticket_id = t.ticket_id AND restored = true) as restored_poles_count
      FROM tickets t
    `;
    const params = [];

    if (status) {
      if (status === 'active') {
        query += ` WHERE t.status NOT IN ('closed', 'verified')`;
      } else {
        query += ' WHERE t.status = $1';
        params.push(status);
      }
    }

    query += ' ORDER BY t.detected_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tickets/:id — Single ticket with affected poles
router.get('/:id', async (req, res) => {
  try {
    const ticket = await pool.query('SELECT * FROM tickets WHERE ticket_id = $1', [req.params.id]);
    if (ticket.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const affectedPoles = await pool.query(`
      SELECT tap.*, p.lat, p.lon, p.dt_id, ds.energized, ds.status as device_status
      FROM ticket_affected_poles tap
      JOIN poles p ON tap.pole_id = p.pole_id
      LEFT JOIN device_state ds ON p.pole_id = ds.pole_id
      WHERE tap.ticket_id = $1
    `, [req.params.id]);

    res.json({
      ...ticket.rows[0],
      affected_poles: affectedPoles.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/tickets/:id — Update ticket status
router.patch('/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const ticketId = req.params.id;

    const ticket = await pool.query('SELECT * FROM tickets WHERE ticket_id = $1', [ticketId]);
    if (ticket.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const currentStatus = ticket.rows[0].status;

    // Valid transitions
    const validTransitions = {
      'detected': ['acknowledged'],
      'acknowledged': ['crew_assigned'],
      'crew_assigned': ['resolved'],
      'resolved': ['verified', 'crew_assigned'], // can go back if verification fails
      'verified': ['closed'],
    };

    if (!validTransitions[currentStatus] || !validTransitions[currentStatus].includes(status)) {
      return res.status(400).json({
        error: `Invalid transition from '${currentStatus}' to '${status}'`,
        valid_transitions: validTransitions[currentStatus] || [],
      });
    }

    // If marking as resolved, check telemetry — are poles actually live?
    if (status === 'resolved') {
      const darkPoles = await pool.query(`
        SELECT COUNT(*) as count FROM ticket_affected_poles tap
        JOIN device_state ds ON tap.pole_id = ds.pole_id
        WHERE tap.ticket_id = $1 AND ds.energized = false
      `, [ticketId]);

      const stillDark = parseInt(darkPoles.rows[0].count);

      if (stillDark > 0) {
        // Reject resolution — poles are still dark
        await pool.query(
          `UPDATE tickets SET resolution_rejected = true, rejection_reason = $1, updated_at = NOW() WHERE ticket_id = $2`,
          [`${stillDark} poles are still dark according to telemetry. Cannot verify resolution.`, ticketId]
        );

        const broadcastSSE = req.app.get('broadcastSSE');
        if (broadcastSSE) {
          broadcastSSE('ticket_update', { ticket_id: ticketId, action: 'resolution_rejected', still_dark: stillDark });
        }

        return res.status(409).json({
          error: 'Resolution rejected',
          reason: `${stillDark} pole(s) are still dark according to telemetry`,
          still_dark: stillDark,
        });
      }
    }

    // Update status with timestamp
    const timestampField = {
      'acknowledged': 'acknowledged_at',
      'crew_assigned': 'crew_assigned_at',
      'resolved': 'resolved_at',
      'verified': 'verified_at',
      'closed': 'closed_at',
    }[status];

    await pool.query(
      `UPDATE tickets SET status = $1, ${timestampField} = NOW(), resolution_rejected = false, rejection_reason = NULL WHERE ticket_id = $2`,
      [status, ticketId]
    );

    const broadcastSSE = req.app.get('broadcastSSE');
    if (broadcastSSE) {
      broadcastSSE('ticket_update', { ticket_id: ticketId, status, action: 'status_changed' });
    }

    const updated = await pool.query('SELECT * FROM tickets WHERE ticket_id = $1', [ticketId]);
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
