// Advance the shared world to the current real time and save state.json.
// Used by .github/workflows/tick.yml (and can be run locally: node scripts/advance.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Sim = require('../sim.js');

const file = path.join(__dirname, '..', 'state.json');
const now = Date.now();
let world = fs.existsSync(file) ? Sim.deserialize(fs.readFileSync(file, 'utf8')) : null;
if (world && world.version !== Sim.VERSION) {
  console.log('State is version', world.version, '- rules changed, starting a new world for version', Sim.VERSION);
  world = null;
}
if (!world) {
  world = Sim.createWorld(crypto.randomBytes(4).readUInt32LE(0), now);
  console.log('Created new world, seed', world.seed);
}
const before = world.tick;
const t0 = Date.now();
Sim.advanceTo(world, now);
if (Sim.clockRate(world) !== Sim.CONFIG.clockRate) {
  // keep the existing world: ticks so far stay at the old rate, from here on the clock runs at the new rate
  console.log('Clock rate', Sim.clockRate(world), '->', Sim.CONFIG.clockRate, 'at tick', world.tick);
  Sim.setClockRate(world, Sim.CONFIG.clockRate);
  Sim.advanceTo(world, now);
}
// Optional owner fast-forward (workflow_dispatch input jump_sim_hours; empty/0 for scheduled and routine runs).
const jumpRaw = String(process.env.JUMP_SIM_HOURS || '0').trim();
const jumpHours = jumpRaw === '' ? 0 : Number(jumpRaw);
if (!isFinite(jumpHours) || jumpHours < 0 || jumpHours > 168) {
  console.error('jump_sim_hours must be a number from 0 to 168, got: ' + JSON.stringify(jumpRaw));
  process.exit(2);
}
if (jumpHours > 0) {
  const jt = Math.round(jumpHours * 36000);   // 36000 ticks per simulated hour
  console.log('Jumping ahead', jumpHours, 'simulated hours (' + jt + ' ticks)');
  Sim.addJump(world, jt);
  Sim.advanceTo(world, now);
}
fs.writeFileSync(file, Sim.serialize(world) + '\n');
console.log(`Advanced ${world.tick - before} ticks in ${Date.now() - t0} ms -> tick ${world.tick}, ` +
  `sim age ${Sim.formatDuration(world.tick * Sim.CONFIG.tickMs)} at ${Sim.clockRate(world)}x, bots ${world.bots.length}, grass ${world.natural}, dropped food ${world.dropped}`);
