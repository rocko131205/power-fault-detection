# AI Workflow Log

This document outlines how I used AI tools during the development of the Propel Power Fault Detection System.

## Tools Used
*   **Cursor / Claude 3.5 Sonnet:** Used as my primary pair-programming assistant. I used it heavily for writing boilerplate, scaffolding the React frontend layout, and generating the synthetic network seed script.
*   **Google Gemini 2.5 Flash:** Used directly within the application codebase (Phase 4) to generate incident summaries from raw telemetry data.

## Wholesale Delegation vs. Manual Implementation

**Wholesale Delegation:**
I completely delegated the CSS styling (dark mode, glassmorphism UI) and the generation of the `seed.js` script to the AI. I described the mathematical logic I wanted for the synthetic grid (5 feeders, 50 transformers, 500 poles with GPS coordinates distributed realistically), and let the AI generate the looping logic and `pg` pool inserts. I also delegated writing the Dockerfiles and `docker-compose.yml`.

**Manual Implementation:**
I drew a hard line at the **Localization Engine** (`backend/src/services/localization.js`). Because this is the "technical heart" of the assignment, I mapped out the topological traversal logic on paper first. While the AI helped type out the SQL queries and `Promise.all` blocks, the actual architectural decisions (e.g., checking if `child_poles` are energized to filter out dead sensors) were entirely manually directed by me.

## When the AI was Wrong

1.  **The Dead-Sensor Loophole:** Initially, I asked the AI to write a function that "groups dark poles by DT and creates a ticket if a pole is dark." The AI blindly created a ticket for every single dark pole. It failed to account for the electrical topology. I had to discard the AI's logic, rewrite the algorithm to start from the Feeder -> DT -> Pole, and manually teach it the concept of a "dead sensor" (a dark pole whose children still have power).
2.  **Docker Environment Variables:** The AI confidently told me to create a `backend/.env` file and use `require('dotenv').config()` inside my Dockerized Node application. However, because we were using `docker-compose`, it was much cleaner to map the variables from a single root `.env` file directly into the container environment. I had to strip out the `dotenv` package and refactor the `docker-compose.yml` to rely on the host's environment injection instead.
3.  **Z-Index Stacking Context:** In the frontend, the AI suggested giving the sidebar a `z-index` of 10 to make it appear over the map. However, this caused the Leaflet map (which has deep internal z-indexes of 400+) to render *over* the ticket detail panels. I had to manually debug the CSS, isolate the `.map-container` into its own stacking context (`z-index: 0`), and bump the `.detail-panel` to `z-index: 1000`.

## Code Generation Estimate
Roughly **75%** of the final codebase was typed by the AI, while **100%** of the architectural decisions, constraints, and business logic were manually directed by me.

## Best Prompt Examples
The most effective prompt I used was for generating the synthetic network seed script, because it constrained the AI to output exactly what I needed without hallucinating:

> *"I need a Node.js script using the 'pg' library to seed a PostgreSQL database. The schema has 'feeders', 'transformers', and 'poles'. Generate exactly 5 feeders. For each feeder, generate between 5 and 10 transformers. For each transformer, generate between 5 and 20 poles. The poles MUST have a 'distance_from_dt' incrementing by 30 meters. Calculate fake latitude and longitude coordinates for these poles starting from a base coordinate of [12.9716, 77.5946] (Bangalore) and walking randomly. Do not use an ORM, just raw SQL parameterized queries."*
