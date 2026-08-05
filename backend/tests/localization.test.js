/**
 * Localization Algorithm — Unit Tests
 *
 * Tests the pure functions that form the core of the fault localization engine.
 * Uses Node's built-in test runner (no external dependencies).
 *
 * Run with: npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../src/services/localization');
const { buildTree, findFaultBoundaries, detectDeadSensors, isPoleDark } = _internal;

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Build a minimal pole object for testing.
 */
function makePole(id, { parent = null, seq = null, energized = true, hasDevice = true, status = 'online' } = {}) {
  return {
    pole_id: id,
    parent_pole_id: parent,
    seq_on_line: seq,
    has_device: hasDevice,
    energized,
    device_status: status,
    lat: 12.97,
    lon: 77.59,
  };
}

// ─── isPoleDark ──────────────────────────────────────────────────────────────

describe('isPoleDark', () => {
  it('returns false for a live pole with a device', () => {
    const pole = makePole('P-001', { energized: true, status: 'online' });
    assert.strictEqual(isPoleDark(pole), false);
  });

  it('returns true for a de-energized pole', () => {
    const pole = makePole('P-001', { energized: false });
    assert.strictEqual(isPoleDark(pole), true);
  });

  it('returns true for an overdue pole', () => {
    const pole = makePole('P-001', { status: 'overdue' });
    assert.strictEqual(isPoleDark(pole), true);
  });

  it('returns null for a pole with no device (unknown state)', () => {
    const pole = makePole('P-001', { hasDevice: false });
    assert.strictEqual(isPoleDark(pole), null);
  });

  it('returns null for a pole with a dead modem (offline status)', () => {
    const pole = makePole('P-001', { status: 'offline' });
    assert.strictEqual(isPoleDark(pole), null);
  });
});

// ─── buildTree ───────────────────────────────────────────────────────────────

describe('buildTree', () => {
  it('builds a simple linear tree: DT → P1 → P2 → P3', () => {
    const poles = [
      makePole('P-001', { parent: 'DT-01', seq: 1 }),
      makePole('P-002', { parent: 'P-001', seq: 2 }),
      makePole('P-003', { parent: 'P-002', seq: 3 }),
    ];

    const { roots, nodeMap } = buildTree(poles);
    assert.strictEqual(roots.length, 1, 'Should have exactly 1 root');
    assert.strictEqual(roots[0].pole_id, 'P-001');
    assert.strictEqual(nodeMap['P-001'].children.length, 1);
    assert.strictEqual(nodeMap['P-001'].children[0].pole_id, 'P-002');
    assert.strictEqual(nodeMap['P-002'].children[0].pole_id, 'P-003');
  });

  it('builds a branching tree: P1 → P2, P1 → P3', () => {
    const poles = [
      makePole('P-001', { parent: 'DT-01', seq: 1 }),
      makePole('P-002', { parent: 'P-001', seq: 2 }),
      makePole('P-003', { parent: 'P-001', seq: 3 }),
    ];

    const { roots, nodeMap } = buildTree(poles);
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(nodeMap['P-001'].children.length, 2);
  });
});

// ─── findFaultBoundaries ─────────────────────────────────────────────────────

describe('findFaultBoundaries', () => {
  it('detects a span fault: P1 live → P2 dark → P3 dark', () => {
    const poles = [
      makePole('P-001', { parent: 'DT-01', seq: 1, energized: true }),
      makePole('P-002', { parent: 'P-001', seq: 2, energized: false }),
      makePole('P-003', { parent: 'P-002', seq: 3, energized: false }),
    ];

    const { roots } = buildTree(poles);
    const faults = findFaultBoundaries(roots);

    assert.strictEqual(faults.length, 1, 'Should detect exactly 1 fault');
    assert.strictEqual(faults[0].from_pole, 'P-001', 'Fault starts after P-001');
    assert.strictEqual(faults[0].to_pole, 'P-002', 'Fault begins at P-002');
    assert.deepStrictEqual(faults[0].affected_poles, ['P-002', 'P-003']);
  });

  it('detects two independent faults on separate branches', () => {
    // Tree:  P1 (live) → P2 (live) → P3 (dark)
    //        P1 (live) → P4 (dark) → P5 (dark)
    const poles = [
      makePole('P-001', { parent: 'DT-01', seq: 1, energized: true }),
      makePole('P-002', { parent: 'P-001', seq: 2, energized: true }),
      makePole('P-003', { parent: 'P-002', seq: 3, energized: false }),
      makePole('P-004', { parent: 'P-001', seq: 4, energized: false }),
      makePole('P-005', { parent: 'P-004', seq: 5, energized: false }),
    ];

    const { roots } = buildTree(poles);
    const faults = findFaultBoundaries(roots);

    assert.strictEqual(faults.length, 2, 'Should detect 2 separate faults');
  });

  it('reports zero faults when all poles are live', () => {
    const poles = [
      makePole('P-001', { parent: 'DT-01', seq: 1, energized: true }),
      makePole('P-002', { parent: 'P-001', seq: 2, energized: true }),
      makePole('P-003', { parent: 'P-002', seq: 3, energized: true }),
    ];

    const { roots } = buildTree(poles);
    const faults = findFaultBoundaries(roots);

    assert.strictEqual(faults.length, 0);
  });
});

// ─── detectDeadSensors ───────────────────────────────────────────────────────

describe('detectDeadSensors', () => {
  it('identifies a dead sensor: P2 dark but P3 (child) is live', () => {
    // If P2 is dark but P3 (which gets power THROUGH P2) is live,
    // then P2 MUST have power — its sensor is just broken.
    const poles = [
      makePole('P-001', { parent: 'DT-01', seq: 1, energized: true }),
      makePole('P-002', { parent: 'P-001', seq: 2, energized: false }),
      makePole('P-003', { parent: 'P-002', seq: 3, energized: true }),
    ];

    const { roots } = buildTree(poles);
    const deadSensors = detectDeadSensors(roots);

    assert.strictEqual(deadSensors.length, 1);
    assert.strictEqual(deadSensors[0], 'P-002');
  });

  it('does NOT flag a pole as dead sensor if ALL children are also dark', () => {
    // P2 dark, P3 dark — this is a real fault, not a dead sensor
    const poles = [
      makePole('P-001', { parent: 'DT-01', seq: 1, energized: true }),
      makePole('P-002', { parent: 'P-001', seq: 2, energized: false }),
      makePole('P-003', { parent: 'P-002', seq: 3, energized: false }),
    ];

    const { roots } = buildTree(poles);
    const deadSensors = detectDeadSensors(roots);

    assert.strictEqual(deadSensors.length, 0, 'Should NOT flag as dead sensor');
  });

  it('returns empty when all poles are live', () => {
    const poles = [
      makePole('P-001', { parent: 'DT-01', seq: 1, energized: true }),
      makePole('P-002', { parent: 'P-001', seq: 2, energized: true }),
    ];

    const { roots } = buildTree(poles);
    const deadSensors = detectDeadSensors(roots);

    assert.strictEqual(deadSensors.length, 0);
  });
});
