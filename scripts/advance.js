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
fs.writeFileSync(file, Sim.serialize(world) + '\n');
console.log(`Advanced ${world.tick - before} ticks in ${Date.now() - t0} ms -> tick ${world.tick}, ` +
  `age ${Sim.formatDuration(world.tick * Sim.CONFIG.tickMs)}, bots ${world.bots.length}, grass ${world.natural}, dropped food ${world.dropped}`);
