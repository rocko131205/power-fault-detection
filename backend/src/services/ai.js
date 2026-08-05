const pool = require('../db/pool');

/**
 * Generates an AI summary for a ticket using Google Gemini API.
 * This runs asynchronously in the background.
 *
 * @param {string} ticketId - The ID of the ticket
 * @param {function} broadcastSSE - Optional function to broadcast updates
 */
async function generateAISummary(ticketId, broadcastSSE) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_api_key_here') {
    console.log(`[AI] Skipping summary for ${ticketId} — no API key configured.`);
    return;
  }

  try {
    // 1. Fetch ticket details from DB
    const ticketRes = await pool.query('SELECT * FROM tickets WHERE ticket_id = $1', [ticketId]);
    if (ticketRes.rows.length === 0) return;
    const ticket = ticketRes.rows[0];

    const prompt = `You are a power grid control room AI assistant. A fault has just been detected in the electrical network.
    
Here is the raw telemetry data for the incident:
- Ticket ID: ${ticket.ticket_id}
- Fault Type: ${ticket.fault_type}
- Suspected Fault Span/Location: From pole ${ticket.fault_span_from || 'N/A'} to ${ticket.fault_span_to || 'N/A'}
- Affected Infrastructure: DT ID ${ticket.fault_dt_id || 'N/A'}, Feeder ${ticket.fault_feeder_id || 'N/A'}
- Impact: ${ticket.affected_poles_count} poles completely offline, approx. ${ticket.affected_households} households without power
- System Confidence: ${ticket.confidence} (${ticket.localization_type})

Write a concise, professional 2-sentence incident report and action plan for the repair crew. Do not use any formatting like bolding or bullet points, just simple text.`;

    // 2. Call Gemini API using built-in fetch
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 150
        }
      })
    });

    if (!response.ok) {
      console.error(`[AI] Gemini API error: ${response.status} ${response.statusText}`);
      return;
    }

    const data = await response.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (summary) {
      // 3. Save to database
      await pool.query('UPDATE tickets SET ai_summary = $1 WHERE ticket_id = $2', [summary, ticketId]);
      console.log(`[AI] Successfully generated summary for ${ticketId}`);

      // 4. Broadcast update to frontend via SSE
      if (broadcastSSE) {
        broadcastSSE('ticket_update', {
          ticket_id: ticketId,
          ai_summary: summary,
          action: 'summary_generated'
        });
      }
    }
  } catch (err) {
    console.error(`[AI] Error generating summary for ${ticketId}:`, err.message);
  }
}

module.exports = {
  generateAISummary
};
