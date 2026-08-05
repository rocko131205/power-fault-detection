const express = require('express');
const cors = require('cors');
const config = require('./config');
const pool = require('./db/pool');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── SSE clients registry ───────────────────────────────────────────────────
const sseClients = new Set();

function broadcastSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

// Make broadcastSSE available to routes
app.set('broadcastSSE', broadcastSSE);

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW() as time, (SELECT COUNT(*) FROM poles) as pole_count');
    res.json({
      status: 'ok',
      time: dbResult.rows[0].time,
      poles: parseInt(dbResult.rows[0].pole_count),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── SSE endpoint ────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'SSE connected' })}\n\n`);

  sseClients.add(res);
  console.log(`📡 SSE client connected (total: ${sseClients.size})`);

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`📡 SSE client disconnected (total: ${sseClients.size})`);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
const telemetryRoutes = require('./routes/telemetry');
const networkRoutes = require('./routes/network');
const ticketRoutes = require('./routes/tickets');
const simulatorRoutes = require('./routes/simulator');
const scheduledOutageRoutes = require('./routes/scheduled-outages');

app.use('/api/telemetry', telemetryRoutes);
app.use('/api/network', networkRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/simulator', simulatorRoutes);
app.use('/api/scheduled-outages', scheduledOutageRoutes);

// ─── Background services ────────────────────────────────────────────────────
const { startHeartbeatMonitor } = require('./services/heartbeat-monitor');
const { startLocalizationLoop } = require('./services/localization');

// ─── Start server ────────────────────────────────────────────────────────────
async function start() {
  try {
    // Verify DB connection
    await pool.query('SELECT 1');
    console.log('✅ Database connected');

    // Start background services
    startHeartbeatMonitor(pool, broadcastSSE);
    startLocalizationLoop(pool, broadcastSSE);

    // Simulated telemetry: refresh heartbeats for all healthy devices every 5 minutes.
    // In production, real smart poles send pings. In this demo, we simulate it so
    // the heartbeat monitor doesn't flag the entire grid as overdue.
    setInterval(async () => {
      try {
        await pool.query(`
          UPDATE device_state SET last_seen_at = NOW()
          WHERE status = 'online' AND energized = true
        `);
      } catch (err) {
        console.error('Simulated heartbeat error:', err.message);
      }
    }, 5 * 60 * 1000); // every 5 minutes

    console.log('✅ Background services started');

    app.listen(config.port, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${config.port}`);
    });
  } catch (err) {
    console.error('❌ Failed to start:', err.message);
    // Retry after 3 seconds (DB might still be starting)
    console.log('⏳ Retrying in 3 seconds...');
    setTimeout(start, 3000);
  }
}

start();

module.exports = app;
