/* Bot World simulation core. Shared by the browser (index.html) and Node (scripts/advance.js).
 * Deterministic: only + - * / sqrt and Math.imul are used in the step, so every JS engine
 * produces the same world from the same state. Add new rules as functions in RULES below. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stats.js'));
  else root.BotSim = factory(root.BotStats);
})(typeof self !== 'undefined' ? self : this, function (Stats) {
  'use strict';

  var CONFIG = {
    width: 800, height: 500,
    tickMs: 100,             // 10 ticks per real second
    botRadius: 18,
    botSpeed: 4,             // px per tick (40 px/s)
    maxEnergy: 200,
    drainPerTick: 0.04,      // 0.4 energy/s -> 500 s (8m20s) from full to empty without food
    grassRadius: 9,
    grassEnergy: 25,
    grassSpawnChance: 0.008,  // per tick -> ~1 clump every 12.5 s (while below maxGrass)
    maxGrass: 5,              // scarce food cap: makes even a lone bot able to starve
    startGrass: 5,
    resproutDelayTicks: 50,  // 5 s after extinction a new pair sprouts
    pairSize: 2
  };

  // Deterministic 64-direction table (own Taylor series; Math.sin/cos differ between engines).
  var DIRS = 64, DX = [], DY = [];
  (function () {
    var PI = 3.141592653589793;
    function sinT(x) { var t = x, s = x; for (var n = 1; n < 25; n++) { t = -t * x * x / ((2 * n) * (2 * n + 1)); s += t; } return s; }
    function cosT(x) { var t = 1, s = 1; for (var n = 1; n < 25; n++) { t = -t * x * x / ((2 * n - 1) * (2 * n)); s += t; } return s; }
    for (var i = 0; i < DIRS; i++) { var a = (i < DIRS / 2 ? i : i - DIRS) * 2 * PI / DIRS; DX.push(cosT(a)); DY.push(sinT(a)); }
  })();

  // mulberry32 PRNG; its state lives in world.rng so the run is resumable.
  function rand(w) {
    var t = (w.rng = (w.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function randInt(w, lo, hi) { return lo + Math.floor(rand(w) * (hi - lo + 1)); }

  var VERSION = 3; // bump when rules/tuning change in a way that makes old saves incompatible
  var H = Stats.hooks;
  var PAIR = [{ name: 'Blue', color: '#6cf' }, { name: 'Orange', color: '#f96' }];

  function makeBot(w, spec, x, y, why) {
    var b = { id: w.nextId++, name: spec.name + (w.stats.era > 1 ? ' ' + w.stats.era : ''), color: spec.color,
              x: x, y: y, px: x, py: y, dir: randInt(w, 0, DIRS - 1), turn: randInt(w, 30, 120),
              energy: CONFIG.maxEnergy, born: w.tick };
    w.bots.push(b); H.birth(w, b, why); return b;
  }

  function spawnGrass(w) {
    var r = CONFIG.grassRadius;
    w.grass.push({ id: w.nextId++, x: r + rand(w) * (CONFIG.width - 2 * r), y: r + rand(w) * (CONFIG.height - 2 * r), born: w.tick });
    H.grassSpawn(w);
  }

  function createWorld(seed, startTime) {
    var w = { version: VERSION, seed: seed >>> 0, rng: seed >>> 0, startTime: startTime, tick: 0, nextId: 1,
              bots: [], grass: [], resproutAt: null, stats: Stats.create(), config: CONFIG };
    Stats.event(w, 'world', 'World created');
    makeBot(w, PAIR[0], 200, 250, 'first pair');
    makeBot(w, PAIR[1], 600, 250, 'first pair');
    for (var i = 0; i < CONFIG.startGrass; i++) spawnGrass(w);
    return w;
  }

  // ---- Rules: each is fn(world). Run in order every tick. Add mutation/reproduction here later. ----
  var RULES = [
    function growGrass(w) {
      if (rand(w) < CONFIG.grassSpawnChance && w.grass.length < CONFIG.maxGrass) spawnGrass(w);
    },
    function resprout(w) {
      if (w.bots.length > 0 || w.resproutAt === null || w.tick < w.resproutAt) return;
      w.resproutAt = null;
      H.newEra(w);
      var R = CONFIG.botRadius;
      for (var i = 0; i < CONFIG.pairSize; i++)
        makeBot(w, PAIR[i % PAIR.length], R + rand(w) * (CONFIG.width - 2 * R), R + rand(w) * (CONFIG.height - 2 * R), 'new life after extinction');
    },
    function wander(w) {
      var R = CONFIG.botRadius, W = CONFIG.width, H = CONFIG.height;
      for (var i = 0; i < w.bots.length; i++) {
        var b = w.bots[i];
        b.px = b.x; b.py = b.y;
        if (--b.turn <= 0) { b.dir = (b.dir + randInt(w, -8, 8) + DIRS) % DIRS; b.turn = randInt(w, 30, 120); }
        b.x += DX[b.dir] * CONFIG.botSpeed; b.y += DY[b.dir] * CONFIG.botSpeed;
        if (b.x < R) { b.x = R; b.dir = (DIRS / 2 - b.dir + DIRS) % DIRS; }
        if (b.x > W - R) { b.x = W - R; b.dir = (DIRS / 2 - b.dir + DIRS) % DIRS; }
        if (b.y < R) { b.y = R; b.dir = (DIRS - b.dir) % DIRS; }
        if (b.y > H - R) { b.y = H - R; b.dir = (DIRS - b.dir) % DIRS; }
      }
    },
    function drainEnergy(w) {
      for (var i = 0; i < w.bots.length; i++) {
        var b = w.bots[i], d = Math.min(CONFIG.drainPerTick, b.energy);
        b.energy -= CONFIG.drainPerTick; H.spend(w, b, d);
      }
    },
    function eatGrass(w) {
      var reach = CONFIG.botRadius + CONFIG.grassRadius, r2 = reach * reach;
      for (var i = 0; i < w.bots.length; i++) {
        var b = w.bots[i];
        for (var j = w.grass.length - 1; j >= 0; j--) {
          var g = w.grass[j], dx = g.x - b.x, dy = g.y - b.y;
          if (dx * dx + dy * dy < r2) {
            var before = b.energy;
            b.energy = Math.min(CONFIG.maxEnergy, b.energy + CONFIG.grassEnergy);
            H.eat(w, b, b.energy - before, CONFIG.grassEnergy - (b.energy - before));
            w.grass.splice(j, 1);
          }
        }
      }
    },
    function starve(w) {
      for (var i = w.bots.length - 1; i >= 0; i--) {
        if (w.bots[i].energy <= 0) {
          var b = w.bots[i];
          w.bots.splice(i, 1);
          H.death(w, b, 'starvation', formatDuration);
          if (w.bots.length === 0) { H.extinction(w, formatDuration); w.resproutAt = w.tick + CONFIG.resproutDelayTicks; }
        }
      }
    }
  ];

  function step(w) { w.tick++; for (var i = 0; i < RULES.length; i++) RULES[i](w); H.tick(w); }

  function tickAt(w, timeMs) { return Math.floor((timeMs - w.startTime) / CONFIG.tickMs); }

  // Advance to the tick for real time `timeMs`. maxSteps (optional) limits work per call.
  function advanceTo(w, timeMs, maxSteps) {
    var target = tickAt(w, timeMs), n = 0;
    while (w.tick < target && (maxSteps === undefined || n < maxSteps)) { step(w); n++; }
    return target - w.tick; // ticks still remaining
  }

  function formatDuration(ms) {
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + 'd ' + h + 'h ' + m + 'm';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm ' + (s % 60) + 's';
  }

  function serialize(w) {
    var copy = JSON.parse(JSON.stringify(w)); delete copy.config; Stats.compact(copy.stats);
    copy.savedAt = new Date(w.startTime + w.tick * CONFIG.tickMs).toISOString();
    return JSON.stringify(copy);
  }
  function deserialize(text) { var w = typeof text === 'string' ? JSON.parse(text) : text; w.config = CONFIG; return w; }

  return { VERSION: VERSION, CONFIG: CONFIG, RULES: RULES, createWorld: createWorld, step: step, advanceTo: advanceTo, tickAt: tickAt,
           serialize: serialize, deserialize: deserialize, Stats: Stats, formatDuration: formatDuration, DX: DX, DY: DY, DIRS: DIRS };
});
