/* Bot World simulation core. Shared by the browser (index.html) and Node (scripts/advance.js).
 * Deterministic: only + - * / sqrt and Math.imul are used in the step, so every JS engine
 * produces the same world from the same state. Add new rules as functions in RULES below. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
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
    grassSpawnChance: 0.0045, // per tick -> ~1 clump every 22 s
    maxGrass: 25,
    startGrass: 15,
    maxEvents: 50
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

  function log(w, text) {
    w.events.push({ tick: w.tick, text: text });
    if (w.events.length > CONFIG.maxEvents) w.events.shift();
  }

  function spawnGrass(w) {
    var r = CONFIG.grassRadius;
    w.grass.push({ id: w.nextId++, x: r + rand(w) * (CONFIG.width - 2 * r), y: r + rand(w) * (CONFIG.height - 2 * r), born: w.tick });
  }

  function createWorld(seed, startTime) {
    var w = { version: 2, seed: seed >>> 0, rng: seed >>> 0, startTime: startTime, tick: 0, nextId: 1,
              bots: [], grass: [], events: [], config: CONFIG };
    var specs = [{ name: 'Blue', color: '#6cf', x: 200 }, { name: 'Orange', color: '#f96', x: 600 }];
    specs.forEach(function (s) {
      w.bots.push({ id: w.nextId++, name: s.name, color: s.color, x: s.x, y: 250, px: s.x, py: 250,
                    dir: randInt(w, 0, DIRS - 1), turn: randInt(w, 30, 120), energy: CONFIG.maxEnergy, born: 0, eaten: 0 });
    });
    for (var i = 0; i < CONFIG.startGrass; i++) spawnGrass(w);
    log(w, 'World created with ' + w.bots.length + ' bots');
    return w;
  }

  // ---- Rules: each is fn(world). Run in order every tick. Add mutation/reproduction here later. ----
  var RULES = [
    function growGrass(w) {
      if (rand(w) < CONFIG.grassSpawnChance && w.grass.length < CONFIG.maxGrass) spawnGrass(w);
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
      for (var i = 0; i < w.bots.length; i++) w.bots[i].energy -= CONFIG.drainPerTick;
    },
    function eatGrass(w) {
      var reach = CONFIG.botRadius + CONFIG.grassRadius, r2 = reach * reach;
      for (var i = 0; i < w.bots.length; i++) {
        var b = w.bots[i];
        for (var j = w.grass.length - 1; j >= 0; j--) {
          var g = w.grass[j], dx = g.x - b.x, dy = g.y - b.y;
          if (dx * dx + dy * dy < r2) {
            b.energy = Math.min(CONFIG.maxEnergy, b.energy + CONFIG.grassEnergy);
            b.eaten++;
            w.grass.splice(j, 1);
          }
        }
      }
    },
    function starve(w) {
      for (var i = w.bots.length - 1; i >= 0; i--) {
        if (w.bots[i].energy <= 0) {
          var b = w.bots[i];
          log(w, b.name + ' starved after ' + formatDuration((w.tick - b.born) * CONFIG.tickMs) + ' (ate ' + b.eaten + ' clumps)');
          w.bots.splice(i, 1);
          if (w.bots.length === 0) log(w, 'All bots are gone. Grass keeps growing.');
        }
      }
    }
  ];

  function step(w) { w.tick++; for (var i = 0; i < RULES.length; i++) RULES[i](w); }

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
    var copy = JSON.parse(JSON.stringify(w)); delete copy.config;
    copy.savedAt = new Date(w.startTime + w.tick * CONFIG.tickMs).toISOString();
    return JSON.stringify(copy);
  }
  function deserialize(text) { var w = typeof text === 'string' ? JSON.parse(text) : text; w.config = CONFIG; return w; }

  return { CONFIG: CONFIG, RULES: RULES, createWorld: createWorld, step: step, advanceTo: advanceTo, tickAt: tickAt,
           serialize: serialize, deserialize: deserialize, formatDuration: formatDuration, DX: DX, DY: DY, DIRS: DIRS };
});
