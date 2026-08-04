/**
 * Heartbeat Monitor — runs periodically to detect devices that missed their heartbeat.
 * 
 * This is the PRIMARY detection mechanism for:
 *   - Firmware 1.2.x devices (never send power_lost)
 *   - Firmware 1.3+ devices whose power_lost message failed (30% of the time)
 * 
 * Logic:
 *   - Every 30 seconds, scan device_state for devices not seen in >16 minutes
 *   - Mark them as 'overdue'
 *   - After 1 hour without contact, mark as 'offline' (probably dead modem)
 */

const config = require('../config');

function startHeartbeatMonitor(pool, broadcastSSE) {
  const HEARTBEAT_TIMEOUT = config.heartbeatTimeoutMs; // 16 min
  const OFFLINE_TIMEOUT = 60 * 60 * 1000; // 1 hour
  const CHECK_INTERVAL = config.heartbeatIntervalMs; // 30s

  async function check() {
    try {
      // Mark devices as overdue if no message in 16 minutes
      const overdueResult = await pool.query(`
        UPDATE device_state
        SET status = 'overdue', updated_at = NOW()
        WHERE status = 'online'
          AND last_seen_at < NOW() - INTERVAL '${HEARTBEAT_TIMEOUT / 1000} seconds'
        RETURNING pole_id, device_id
      `);

      if (overdueResult.rows.length > 0) {
        console.log(`⏰ ${overdueResult.rows.length} devices now overdue`);
        broadcastSSE('devices_overdue', {
          count: overdueResult.rows.length,
          poles: overdueResult.rows.map(r => r.pole_id),
        });
      }

      // Mark devices as offline if no message in 1 hour (likely dead modem)
      const offlineResult = await pool.query(`
        UPDATE device_state
        SET status = 'offline', updated_at = NOW()
        WHERE status = 'overdue'
          AND last_seen_at < NOW() - INTERVAL '${OFFLINE_TIMEOUT / 1000} seconds'
        RETURNING pole_id, device_id
      `);

      if (offlineResult.rows.length > 0) {
        console.log(`💀 ${offlineResult.rows.length} devices now offline (probable dead modem)`);
      }
    } catch (err) {
      console.error('Heartbeat monitor error:', err.message);
    }
  }

  // Run immediately, then on interval
  check();
  setInterval(check, CHECK_INTERVAL);
  console.log(`   ⏰ Heartbeat monitor: checking every ${CHECK_INTERVAL / 1000}s, timeout ${HEARTBEAT_TIMEOUT / 1000}s`);
}

module.exports = { startHeartbeatMonitor };
