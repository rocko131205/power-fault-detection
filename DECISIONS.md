# Decisions Log

### Aug 5 - Added Gemini AI Summaries (Instead of OpenAI)
*   **What we chose:** Used Google Gemini 2.5 Flash via native `fetch` over OpenAI GPT-4.
*   **What we rejected:** Bringing in the heavy `@google/genai` or `openai` SDK dependencies.
*   **Why:** Gemini 2.5 Flash is incredibly fast, which is critical for real-time incident generation. Using native `fetch` kept the docker image size small and reduced dependency hell. 

### Aug 5 - Implemented Single Root `.env`
*   **What we chose:** Put one `.env` file at the root next to `docker-compose.yml`.
*   **What we rejected:** Having separate `.env` files inside `frontend/` and `backend/`.
*   **Why:** Docker Compose handles injecting root environment variables into containers seamlessly. Multiple `.env` files lead to synchronization bugs (e.g., frontend trying to connect to a different database port than backend).

### Aug 4 - React Frontend with Leaflet
*   **What we chose:** Leaflet.js over Google Maps.
*   **What we rejected:** Google Maps API.
*   **Why:** Leaflet requires no billing accounts or API keys, meaning the evaluator can run this repository instantly. It also handles thousands of DOM-based vector markers very well for grid topology.

### Aug 3 - Server-Sent Events (SSE) over WebSockets
*   **What we chose:** SSE for real-time dashboard updates.
*   **What we rejected:** WebSockets / Socket.io.
*   **Why:** The communication is entirely unidirectional (Backend -> Frontend). The UI never streams high-frequency data back to the server. SSE natively reconnects over standard HTTP, bypassing complex proxy configurations often required by WebSockets.

### Aug 3 - PostgreSQL and Relational Modeling
*   **What we chose:** PostgreSQL.
*   **What we rejected:** MongoDB / NoSQL.
*   **Why:** Power grids are rigid, relational structures. To find a fault, we constantly need to query "Find all poles whose parent is X and sort by distance". SQL handles hierarchical topology inherently better than document stores.

---

## What we would do with two more weeks
If given more time, we would implement the following:
1.  **Spatial Indexing (PostGIS):** Currently, our UI pulls all poles to render the map. With 100,000 poles, this would crash the browser. We would implement PostGIS to only serve vectors that intersect with the user's current map bounding box.
2.  **Weather Correlation:** Integrating a live weather API to automatically tag tickets with "High Probability of Lightning Strike" if localized storms match the fault timestamp.

## What is currently wrong or fragile
1.  **Seed Script Memory:** The synthetic network generation script (`seed.js`) does a lot of array manipulation in memory before doing bulk inserts. If we wanted to simulate a network of 1 million poles, the script would OOM (Out of Memory) crash Node.js. It needs to be rewritten into streaming inserts.
