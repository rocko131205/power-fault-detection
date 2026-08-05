# Propel Power Fault Detection System

Welcome to the Propel Power Fault Detection System! This is a full-stack, real-time control room dashboard designed to detect, localize, and manage power grid faults using simulated smart-pole telemetry.

> **🔗 Live Demo URL:** `https://kspd-dashboard.up.railway.app/`
> **🎥 Video Walkthrough:** `https://drive.google.com/file/d/1ilfB5FBjkho3c-htRnXRuPiVKnXqhqrC/view?usp=sharing`

## 🚀 Quick Start (Docker)

This project is fully containerized so you don't need to install any databases or node modules on your host machine.

1. **Add your API Key (Optional):**
   Open the `.env` file in the root directory and add your Google Gemini API key to enable AI Incident Summaries.
   ```env
   GEMINI_API_KEY=your_key_here
   ```
2. **Start the System:**
   Run the following command in your terminal from the root folder:
   ```bash
   docker compose up -d --build
   ```
3. **Open the Dashboard:**
   Navigate to [http://localhost:3000](http://localhost:3000) in your web browser.

---

## 🏗️ Project Structure & File Explanations

Here is a breakdown of every single file and folder in the project and how they relate to each other:

### 1. Root Level (Infrastructure)
*   `docker-compose.yml`: The orchestrator. It tells Docker to spin up 3 isolated environments (Database, Backend, Frontend) and connects them via a virtual network.
*   `.env`: The global environment file. Docker Compose reads this file and passes these variables (like `DB_PASSWORD` or `GEMINI_API_KEY`) *into* the isolated containers. We put this at the root so there is a single source of truth, avoiding the confusion of multiple `.env` files scattered around.

### 2. `/backend` (The Brain)
This is an Express.js server that ingests telemetry, runs the localization algorithm, and talks to the UI.
*   `Dockerfile`: The instructions to build the backend container (installs Node.js, runs `npm install`, and starts the server).
*   `src/index.js`: The main entry point. Starts the Express server and the background loops (like the heartbeat monitor).
*   `src/config.js`: Loads variables from the Docker environment and exports them for the rest of the backend to use safely.
*   `src/db/pool.js`: Sets up the connection to the PostgreSQL database.
*   `src/db/schema.sql`: Contains all the SQL commands to create our tables (substations, feeders, transformers, poles, tickets, etc.).
*   `src/db/seed.js`: A massive script that runs *once* when the container boots. It automatically generates a realistic synthetic power grid (feeders, transformers, and 500+ poles with physical GPS coordinates) and saves it to the database so we have data to test with.
*   `src/services/localization.js`: **The Core Algorithm.** This file scans the database for "dark" poles and uses physics/topology rules to figure out if it's a wire break (span), a blown transformer (DT), or a feeder trip.
*   `src/services/ai.js`: Sends the localized fault data to Google Gemini to generate a human-readable incident report.
*   `src/routes/telemetry.js`: The API endpoint where "smart poles" send their data. Includes filtering for duplicate/stale messages.
*   `src/routes/tickets.js`: API endpoints for the frontend to fetch fault tickets and update their status (e.g., "Crew Assigned").
*   `src/routes/simulator.js`: Endpoints used specifically by the UI Simulator to inject fake faults (kill power to poles) or inject noise.

### 3. `/frontend` (The Control Room UI)
A React.js application bundled with Vite.
*   `Dockerfile`: Builds the React app and serves it using NGINX (a highly efficient web server).
*   `src/main.jsx`: The React entry point.
*   `src/App.jsx`: The main layout containing the Sidebar, the Map, and the Simulator. Also contains the SSE (Server-Sent Events) listener that updates the UI in real-time without refreshing the page.
*   `src/App.css`: All the styling for the dark-themed dashboard.
*   `src/components/FaultMap.jsx`: The Leaflet.js map component. It takes the GPS coordinates of the poles and fault locations and plots them on an interactive map.

---

## 🎯 What We Built vs. What We Skipped

The original assignment brief mentioned that we did not need to implement *every* constraint perfectly. Here is what we actively implemented vs what we skipped to keep the project scoped reasonably:

**What we Implemented (The Core Mechanics):**
1. **Span, DT, and Feeder Localization:** The algorithm successfully traverses the parent-child relationships in the grid to isolate exact faults.
2. **Dead Sensor Noise Filtering:** If a pole loses comms but its child pole still has power, we ignore the dark pole as a "dead sensor" rather than declaring a blackout.
3. **Stale/Duplicate Message Filtering:** Handled via sequence numbers in the telemetry route.
4. **Auto-Verification:** If a crew marks a ticket as "Repaired", but telemetry says the poles are still dark, the system rejects the resolution.
5. **AI Summarization:** Real-time LLM incident reports.

**What we Skipped (As permitted by the brief):**
1. **Load Shedding Schedules:** While we built the data structure for load shedding (planned outages), we did not build a complex cron-job system to actively toggle planned outages on and off.
2. **Advanced Weather Correlation:** We skipped integrating a 3rd party live weather API to correlate faults with lightning strikes or storms.
3. **Authentication:** There is no login screen for operators. We assumed a trusted internal network for this prototype.

---

## 🎮 How to use the Final UI

Once you open `http://localhost:3000`:
1. **The Map (Center):** You will see a map plotted with green dots (healthy poles). 
2. **The Simulator (Bottom Right):** Click the "Simulator" button. You can select a fault type (e.g., Span wire break) and a target (e.g., DT-001). Click **Inject Fault**.
3. **Watch the Magic:**
   * The backend instantly kills power to the affected poles based on physics.
   * The algorithm localizes it.
   * A ticket pops up on your **Left Sidebar**.
   * The map markers turn **Red** in real-time.
4. **Ticket Management:** Click the ticket on the left. A panel slides up from the bottom showing the AI summary and the exact number of affected households. Click "Dispatch Crew", and then finally click "Simulate Repair" to restore the grid!
