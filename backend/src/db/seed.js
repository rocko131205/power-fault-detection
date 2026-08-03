/**
 * Seed Script — Generates a realistic synthetic power distribution network.
 *
 * Produces:
 *   4 substations, ~30 feeders, ~50 DTs, ~3500 poles
 *   with all the assignment's constraints baked in:
 *     - 60% of DTs missing topology
 *     - 9% of poles without devices
 *     - 8% of devices on firmware 1.2.x
 *     - 3% of poles missing pincode
 *     - A few scheduled outages
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// ─── Constants ───────────────────────────────────────────────────────────────

// Bangalore city center as base coordinates
const BASE_LAT = 12.9716;
const BASE_LON = 77.5946;

const NUM_SUBSTATIONS = 4;
const FEEDERS_PER_SUBSTATION = [7, 8, 8, 8]; // total 31
const DTS_PER_FEEDER_MIN = 1;
const DTS_PER_FEEDER_MAX = 3;
const POLES_PER_DT_MIN = 20;
const POLES_PER_DT_MAX = 120;
const BRANCH_PROBABILITY = 0.15;
const MAX_BRANCHES_PER_LINE = 4;
const BRANCH_LENGTH_MIN = 3;
const BRANCH_LENGTH_MAX = 15;

const TOPOLOGY_MISSING_RATE = 0.60;
const NO_DEVICE_RATE = 0.09;
const OLD_FIRMWARE_RATE = 0.08;
const MISSING_PINCODE_RATE = 0.03;

const PINCODES = [
  '560001', '560002', '560003', '560004', '560008',
  '560009', '560010', '560011', '560016', '560017',
  '560018', '560019', '560020', '560021', '560025',
  '560027', '560029', '560030', '560032', '560033',
  '560034', '560036', '560037', '560038', '560040',
  '560041', '560043', '560045', '560046', '560047',
  '560048', '560050', '560051', '560053', '560054',
  '560055', '560056', '560058', '560060', '560062',
  '560064', '560066', '560068', '560069', '560070',
  '560071', '560073', '560076', '560078', '560079',
];

const WARDS = [];
for (let i = 1; i <= 100; i++) {
  WARDS.push(`W-${String(i).padStart(3, '0')}`);
}

const POLE_TYPES = [
  'LT-9m-PCC', 'LT-9m-PCC', 'LT-9m-PCC', 'LT-9m-PCC', // most common
  'LT-8m-Steel', 'LT-8m-Steel',
  'LT-11m-PCC',
  'LT-8m-Wood',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

let poleCounter = 0;
let deviceCounter = 0;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a GPS point offset from a base point.
 * ~0.0001 degrees ≈ 11 meters at Bangalore's latitude.
 */
function offsetCoord(baseLat, baseLon, distMeters, angleDeg) {
  const angleRad = (angleDeg * Math.PI) / 180;
  const latOffset = (distMeters * Math.cos(angleRad)) / 111320;
  const lonOffset = (distMeters * Math.sin(angleRad)) / (111320 * Math.cos((baseLat * Math.PI) / 180));
  return {
    lat: parseFloat((baseLat + latOffset).toFixed(6)),
    lon: parseFloat((baseLon + lonOffset).toFixed(6)),
  };
}

function generatePoleId() {
  poleCounter++;
  return `P-${String(poleCounter).padStart(6, '0')}`;
}

function generateDeviceId(substationId, dtId, poleNum) {
  deviceCounter++;
  return `KSPDB-${substationId}-${dtId}-${String(deviceCounter).padStart(4, '0')}`;
}

// ─── Generator ───────────────────────────────────────────────────────────────

function generateNetwork() {
  const substations = [];
  const feeders = [];
  const transformers = [];
  const poles = [];
  const deviceStates = [];

  // Spread substations around the city
  const substationOffsets = [
    { lat: 0.02, lon: -0.02 },
    { lat: 0.02, lon: 0.02 },
    { lat: -0.02, lon: -0.02 },
    { lat: -0.02, lon: 0.02 },
  ];

  for (let s = 0; s < NUM_SUBSTATIONS; s++) {
    const ssId = `SS-${String(s + 1).padStart(2, '0')}`;
    const ssLat = BASE_LAT + substationOffsets[s].lat;
    const ssLon = BASE_LON + substationOffsets[s].lon;

    substations.push({
      substation_id: ssId,
      name: `Substation ${s + 1}`,
      lat: parseFloat(ssLat.toFixed(6)),
      lon: parseFloat(ssLon.toFixed(6)),
    });

    // Generate feeders for this substation
    const numFeeders = FEEDERS_PER_SUBSTATION[s];
    for (let f = 0; f < numFeeders; f++) {
      const feederId = `F-${String(s + 1).padStart(2, '0')}-${String(f + 1).padStart(2, '0')}`;
      feeders.push({
        feeder_id: feederId,
        substation_id: ssId,
        name: `Feeder ${feederId}`,
      });

      // Generate DTs for this feeder
      const numDTs = rand(DTS_PER_FEEDER_MIN, DTS_PER_FEEDER_MAX);
      for (let d = 0; d < numDTs; d++) {
        const dtId = `D-${String(s + 1).padStart(2, '0')}${String(f + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
        
        // Place DT near its substation with some random spread
        const dtOffset = offsetCoord(ssLat, ssLon, rand(200, 2000), rand(0, 359));
        const hasTopology = Math.random() > TOPOLOGY_MISSING_RATE;

        const ward = randomChoice(WARDS);
        const pincode = randomChoice(PINCODES);
        const householdsPerDT = rand(80, 500);

        transformers.push({
          dt_id: dtId,
          feeder_id: feederId,
          lat: dtOffset.lat,
          lon: dtOffset.lon,
          capacity_kva: randomChoice([100, 250, 250, 250, 500]),
          households_served: householdsPerDT,
          has_topology: hasTopology,
        });

        // Generate poles for this DT as a tree (main line + branches)
        const mainLineLength = rand(POLES_PER_DT_MIN, POLES_PER_DT_MAX);
        const mainAngle = rand(0, 359); // direction the line runs
        const poleSpacing = rand(30, 50); // meters between poles

        const dtPoles = [];
        let branchCount = 0;

        // Main line
        for (let p = 0; p < mainLineLength; p++) {
          const poleCoord = offsetCoord(dtOffset.lat, dtOffset.lon, poleSpacing * (p + 1), mainAngle + rand(-5, 5));
          const poleId = generatePoleId();
          const hasDevice = Math.random() > NO_DEVICE_RATE;
          const isOldFirmware = Math.random() < OLD_FIRMWARE_RATE;
          const hasPincode = Math.random() > MISSING_PINCODE_RATE;

          const parentPoleId = p === 0 ? null : dtPoles[p - 1].pole_id;
          const deviceId = hasDevice ? generateDeviceId(ssId, dtId, p) : null;

          const pole = {
            pole_id: poleId,
            lat: poleCoord.lat,
            lon: poleCoord.lon,
            feeder_id: feederId,
            dt_id: dtId,
            seq_on_line: hasTopology ? p + 1 : null,
            parent_pole_id: hasTopology ? (p === 0 ? dtId : parentPoleId) : null,
            pole_type: randomChoice(POLE_TYPES),
            ward: ward,
            pincode: hasPincode ? pincode : null,
            device_id: deviceId,
            has_device: hasDevice,
          };

          dtPoles.push(pole);
          poles.push(pole);

          // Device state
          if (hasDevice) {
            deviceStates.push({
              pole_id: poleId,
              device_id: deviceId,
              firmware: isOldFirmware ? '1.2.1' : '1.4.2',
              battery_mv: rand(3200, 3800),
              rssi: rand(-105, -70),
            });
          }

          // Possibly start a branch
          if (p > 3 && branchCount < MAX_BRANCHES_PER_LINE && Math.random() < BRANCH_PROBABILITY) {
            branchCount++;
            const branchLen = rand(BRANCH_LENGTH_MIN, BRANCH_LENGTH_MAX);
            const branchAngle = mainAngle + randomChoice([-90, -60, 60, 90]) + rand(-10, 10);

            for (let b = 0; b < branchLen; b++) {
              const bCoord = offsetCoord(poleCoord.lat, poleCoord.lon, poleSpacing * (b + 1), branchAngle + rand(-3, 3));
              const bPoleId = generatePoleId();
              const bHasDevice = Math.random() > NO_DEVICE_RATE;
              const bIsOldFw = Math.random() < OLD_FIRMWARE_RATE;
              const bHasPincode = Math.random() > MISSING_PINCODE_RATE;

              const bParentId = b === 0 ? poleId : dtPoles[dtPoles.length - 1].pole_id;
              const bDeviceId = bHasDevice ? generateDeviceId(ssId, dtId, b) : null;

              // For branches, seq_on_line is tricky — we continue numbering from mainline
              const bSeq = hasTopology ? mainLineLength + (branchCount - 1) * BRANCH_LENGTH_MAX + b + 1 : null;

              const bPole = {
                pole_id: bPoleId,
                lat: bCoord.lat,
                lon: bCoord.lon,
                feeder_id: feederId,
                dt_id: dtId,
                seq_on_line: hasTopology ? bSeq : null,
                parent_pole_id: hasTopology ? bParentId : null,
                pole_type: randomChoice(POLE_TYPES),
                ward: ward,
                pincode: bHasPincode ? pincode : null,
                device_id: bDeviceId,
                has_device: bHasDevice,
              };

              dtPoles.push(bPole);
              poles.push(bPole);

              if (bHasDevice) {
                deviceStates.push({
                  pole_id: bPoleId,
                  device_id: bDeviceId,
                  firmware: bIsOldFw ? '1.2.1' : '1.4.2',
                  battery_mv: rand(3200, 3800),
                  rssi: rand(-105, -70),
                });
              }
            }
          }
        }
      }
    }
  }

  // Generate a few scheduled outages
  const now = new Date();
  const scheduledOutages = [];
  for (let i = 0; i < 5; i++) {
    const startOffset = rand(1, 24) * 60 * 60 * 1000;
    const duration = rand(1, 3) * 60 * 60 * 1000;
    const start = new Date(now.getTime() + startOffset);
    const end = new Date(start.getTime() + duration);
    const isFeeder = Math.random() > 0.5;

    scheduledOutages.push({
      id: `SO-${now.toISOString().slice(0, 10)}-${String(i + 1).padStart(3, '0')}`,
      scope: isFeeder ? 'feeder' : 'dt',
      target_id: isFeeder ? randomChoice(feeders).feeder_id : randomChoice(transformers).dt_id,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      reason: randomChoice([
        'Planned maintenance - jumper replacement',
        'Load shedding',
        'Transformer oil replacement',
        'Line stringing work',
        'Tree trimming near HT line',
      ]),
    });
  }

  return { substations, feeders, transformers, poles, deviceStates, scheduledOutages };
}

// ─── Database insertion ──────────────────────────────────────────────────────

async function seed() {
  const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
  });

  const client = await pool.connect();

  try {
    console.log('🌱 Starting seed...');
    console.log('📡 Generating synthetic network...');

    const data = generateNetwork();

    console.log(`   Substations: ${data.substations.length}`);
    console.log(`   Feeders: ${data.feeders.length}`);
    console.log(`   Transformers: ${data.transformers.length}`);
    console.log(`   Poles: ${data.poles.length}`);
    console.log(`   Devices: ${data.deviceStates.length}`);
    console.log(`   Scheduled outages: ${data.scheduledOutages.length}`);

    // Run schema first
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    await client.query(schemaSql);
    console.log('✅ Schema created');

    // Clear existing data
    await client.query('BEGIN');
    await client.query('DELETE FROM ticket_affected_poles');
    await client.query('DELETE FROM tickets');
    await client.query('DELETE FROM telemetry_log');
    await client.query('DELETE FROM device_state');
    await client.query('DELETE FROM scheduled_outages');
    await client.query('DELETE FROM poles');
    await client.query('DELETE FROM transformers');
    await client.query('DELETE FROM feeders');
    await client.query('DELETE FROM substations');

    // Insert substations
    for (const s of data.substations) {
      await client.query(
        `INSERT INTO substations (substation_id, name, lat, lon) VALUES ($1, $2, $3, $4)`,
        [s.substation_id, s.name, s.lat, s.lon]
      );
    }
    console.log('✅ Substations inserted');

    // Insert feeders
    for (const f of data.feeders) {
      await client.query(
        `INSERT INTO feeders (feeder_id, substation_id, name) VALUES ($1, $2, $3)`,
        [f.feeder_id, f.substation_id, f.name]
      );
    }
    console.log('✅ Feeders inserted');

    // Insert transformers
    for (const t of data.transformers) {
      await client.query(
        `INSERT INTO transformers (dt_id, feeder_id, lat, lon, capacity_kva, households_served, has_topology)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [t.dt_id, t.feeder_id, t.lat, t.lon, t.capacity_kva, t.households_served, t.has_topology]
      );
    }
    console.log('✅ Transformers inserted');

    // Insert poles in batches
    const BATCH_SIZE = 500;
    for (let i = 0; i < data.poles.length; i += BATCH_SIZE) {
      const batch = data.poles.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (const p of batch) {
        values.push(
          `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
        );
        params.push(
          p.pole_id, p.lat, p.lon, p.feeder_id, p.dt_id,
          p.seq_on_line, p.parent_pole_id, p.pole_type,
          p.ward, p.pincode, p.device_id, p.has_device
        );
      }

      await client.query(
        `INSERT INTO poles (pole_id, lat, lon, feeder_id, dt_id, seq_on_line, parent_pole_id, pole_type, ward, pincode, device_id, has_device)
         VALUES ${values.join(', ')}`,
        params
      );
    }
    console.log('✅ Poles inserted');

    // Insert device states in batches
    for (let i = 0; i < data.deviceStates.length; i += BATCH_SIZE) {
      const batch = data.deviceStates.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];
      let paramIdx = 1;

      for (const d of batch) {
        values.push(
          `($${paramIdx++}, $${paramIdx++}, NOW(), $${paramIdx++}, TRUE, 'online', $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
        );
        params.push(d.pole_id, d.device_id, 0, d.firmware, d.battery_mv, d.rssi);
      }

      await client.query(
        `INSERT INTO device_state (pole_id, device_id, last_seen_at, last_seq, energized, status, firmware, battery_mv, rssi)
         VALUES ${values.join(', ')}`,
        params
      );
    }
    console.log('✅ Device states inserted');

    // Insert scheduled outages
    for (const so of data.scheduledOutages) {
      await client.query(
        `INSERT INTO scheduled_outages (id, scope, target_id, start_time, end_time, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [so.id, so.scope, so.target_id, so.start_time, so.end_time, so.reason]
      );
    }
    console.log('✅ Scheduled outages inserted');

    await client.query('COMMIT');

    // Print summary stats
    const topologyDTs = data.transformers.filter(t => t.has_topology).length;
    const noTopologyDTs = data.transformers.filter(t => !t.has_topology).length;
    const polesWithDevice = data.poles.filter(p => p.has_device).length;
    const polesNoDevice = data.poles.filter(p => !p.has_device).length;
    const oldFw = data.deviceStates.filter(d => d.firmware.startsWith('1.2')).length;
    const missingPincode = data.poles.filter(p => !p.pincode).length;

    console.log('\n📊 Network Statistics:');
    console.log(`   DTs with topology:    ${topologyDTs} (${((topologyDTs / data.transformers.length) * 100).toFixed(1)}%)`);
    console.log(`   DTs without topology: ${noTopologyDTs} (${((noTopologyDTs / data.transformers.length) * 100).toFixed(1)}%)`);
    console.log(`   Poles with device:    ${polesWithDevice} (${((polesWithDevice / data.poles.length) * 100).toFixed(1)}%)`);
    console.log(`   Poles without device: ${polesNoDevice} (${((polesNoDevice / data.poles.length) * 100).toFixed(1)}%)`);
    console.log(`   Firmware 1.2.x:       ${oldFw} (${((oldFw / data.deviceStates.length) * 100).toFixed(1)}%)`);
    console.log(`   Missing pincode:      ${missingPincode} (${((missingPincode / data.poles.length) * 100).toFixed(1)}%)`);
    console.log('\n✅ Seed complete!\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  seed().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { seed, generateNetwork };
