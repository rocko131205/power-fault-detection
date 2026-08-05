# Deployment Guide

This document explains how to get the Propel Power Fault Detection System running from scratch.

## Prerequisites
*   Docker (v24.0 or higher recommended)
*   Docker Compose (v2.20 or higher)
*   Git

## Quick Start (Local Deployment)

Run these exact commands in order:

```bash
# 1. Clone the repository
git clone https://github.com/rocko131205/power-fault-detection.git
cd propel-power

# 2. Set up environment variables
cp .env.example .env

# 3. Start the system
docker compose up -d --build
```

## Environment Variables

All configuration is handled by a single `.env` file at the root of the project.

| Variable | Description | Required | Default |
| :--- | :--- | :--- | :--- |
| `DB_HOST` | Hostname for the Postgres database | Yes | `db` |
| `DB_PORT` | Port for the Postgres database | Yes | `5432` |
| `DB_NAME` | Name of the database | Yes | `propel` |
| `DB_USER` | Database username | Yes | `propel` |
| `DB_PASSWORD` | Database password | Yes | `propel123` |
| `PORT` | Port the backend API listens on | Yes | `3001` |
| `GEMINI_API_KEY` | Google Gemini API key for AI summaries | No | *Empty* |

## Verifying the Deployment

1.  Open your browser and navigate to `http://localhost:3000`.
2.  You should immediately see the dark-themed control room dashboard.
3.  The map in the center should be heavily populated with hundreds of green dots (the synthetic network seeded on startup).
4.  Open the **Simulator** on the bottom right and inject a fault to ensure the backend localization engine is running.

## Troubleshooting

Here are failure modes you might encounter and how to fix them:

### 1. Port Conflicts (Address already in use)
*   **Symptom:** `Error starting userland proxy: listen tcp4 0.0.0.0:5432: bind: address already in use`
*   **Fix:** You already have a local instance of PostgreSQL running on your machine. Either stop your local Postgres service, or change the mapped port in `docker-compose.yml` (e.g., `"5433:5432"`).

### 2. Database Race Condition (Backend crashing on boot)
*   **Symptom:** The backend container logs show `ECONNREFUSED` or `relation "poles" does not exist`.
*   **Fix:** The backend tried to run the seed script before Postgres was fully initialized. We fixed this by adding a `healthcheck` in `docker-compose.yml` (using `pg_isready`), but if it happens on a very slow machine, simply restart the backend: `docker compose restart backend`.

### 3. Docker Volume Stale Data
*   **Symptom:** You changed `schema.sql`, but the database isn't reflecting the changes after running `docker compose up`.
*   **Fix:** Docker preserves database volumes across restarts. You must wipe the volume to trigger a fresh initialization:
    ```bash
    docker compose down -v
    docker compose up -d
    ```

## Reset to Clean State

To completely wipe the database and start fresh with a new synthetic network:

```bash
# Local (Docker)
docker compose down -v        # removes containers AND the database volume
docker compose up -d --build  # rebuilds and re-seeds from scratch
```

For the Railway deployment, click **Redeploy** on the backend service. The seed script runs on every container boot and drops/recreates all tables automatically.
