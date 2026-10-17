/* Bot World simulation core. Shared by the browser (index.html) and Node (scripts/advance.js).
 * Deterministic: only + - * / sqrt, Math.floor/min/max/imul and the seeded PRNG are used in the step,
 * so every JS engine produces the same world from the same state. Rules are the functions in RULES. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stats.js'));
  else root.BotSim = factory(root.BotStats);
})(typeof self !== 'undefined' ? self : this, function (Stats) {
  'use strict';

  var CONFIG = {
    width: 1000, height: 625,
    tickMs: 100,               // 10 ticks per real second
    // energy model (per tick). sizeF = size / 14
    baseMaxEnergy: 200,        // max energy = 200 * sizeF^2 (bigger bodies store more)
    drainBase: 0.01,           // * sizeF^2           (living cost)
    drainPerSpeed: 0.0075,     // * speed * sizeF     (moving cost)
    drainPerVision: 0.00004,   // * vision            (seeing far costs energy: 150px -> 0.006)
    restSpeedFactor: 0.4,      // resting bots move at 40% of their speed
    grassRadius: 9,
    grassEnergy: 25,
    // seasons: cycle = spring, summer, autumn, winter, each seasonTicks long
    seasonTicks: 72000,        // 2 simulated hours per season -> 8-hour year
    seasons: [
      { name: 'Spring', spawn: 0.02,  cap: 30 },
      { name: 'Summer', spawn: 0.03,  cap: 40 },
      { name: 'Autumn', spawn: 0.012, cap: 20 },
      { name: 'Winter', spawn: 0.006, cap: 12 }
    ],
    strengthMin: 0.7, strengthMax: 1.3, // each year's seeded strength: good seasons x s, winter / s
    startGrass: 15,
    // behaviour
    plentyLevel: 0.75, scarceLevel: 0.35, // grass / current cap
    nearDist: 110, avoidDist: 200, socialPull: 0.12,
    decideEvery: 3,            // a bot re-decides every 3 ticks (staggered) to keep catch-up fast
    // reproduction
    maxPop: 30,
    reproEnergy: 0.85,         // needs >= 85% of max energy
    reproMinAge: 6000,         // 10 min old
    reproCooldown: 9000,       // 15 min between children
    reproCost: 0.55,           // parent pays 55% of its max energy...
    childEnergy: 0.4,          // ...child starts with 40% of its own max (the rest is lost)
    resproutDelayTicks: 50,
    pairSize: 2
  };

  var DEFAULT_TRAITS = { speed: 4, vision: 150, hunger: 0.6, rest: 0.85, size: 14 };
  var TRAIT_RULES = { // mutation sigma and clamp range
    speed:  { sd: 0.25, min: 1,    max: 8 },
    vision: { sd: 10,   min: 40,   max: 320 },
    hunger: { sd: 0.04, min: 0.2,  max: 0.9 },
    rest:   { sd: 0.04, min: 0.3,  max: 1.0 },
    size:   { sd: 0.8,  min: 8,    max: 24 }
  };
  var TRAITS = ['speed', 'vision', 'hunger', 'rest', 'size'];

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
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  var VERSION = 5; // bump when rules/tuning change in a way that makes old saves incompatible
  var H = Stats.hooks;
  var PAIR = [{ name: 'Blue', hue: 195 }, { name: 'Orange', hue: 25 }];

  // ---- body / energy model derived from traits ----
  function sizeF(b) { return b.traits.size / 14; }
  function maxEnergy(b) { var f = sizeF(b); return CONFIG.baseMaxEnergy * f * f; }
  function radius(b) { return b.traits.size; }
  function drain(b) {
    var f = sizeF(b);
    return CONFIG.drainBase * f * f + CONFIG.drainPerSpeed * b.speed * f + CONFIG.drainPerVision * b.traits.vision;
  }

  // ---- seasons ----
  function seasonInfo(w, tick) {
    var t = tick === undefined ? w.tick : tick, len = CONFIG.seasonTicks;
    var idx = Math.floor(t / len) % 4, year = Math.floor(t / (4 * len));
    var s = CONFIG.seasons[idx], k = w.yearStrength;
    var m = idx === 3 ? 1 / k : k;
    return { index: idx, name: s.name, year: year, strength: k, spawn: s.spawn * m,
             cap: Math.max(1, Math.round(s.cap * m)), endsAt: (Math.floor(t / len) + 1) * len };
  }

  function makeBot(w, o) {
    var b = { id: w.nextId++, name: o.name, gen: o.gen || 1, parent: o.parent || null, lineage: o.lineage || null,
              hue: o.hue, traits: o.traits, x: o.x, y: o.y, px: o.x, py: o.y, hx: 0, hy: 0, turn: randInt(w, 30, 120),
              energy: 0, born: w.tick, lastRepro: w.tick, kids: 0, mode: 'rest', speed: 0,
              target: null, mem: null, viaMemory: false };
    if (!b.lineage) b.lineage = b.id;
    b.speed = b.traits.speed * CONFIG.restSpeedFactor;
    b.energy = o.energy === undefined ? maxEnergy(b) : o.energy;
    var d = randInt(w, 0, DIRS - 1); b.hx = DX[d]; b.hy = DY[d];
    w.bots.push(b); H.birth(w, b, o.why);
    return b;
  }
  function freshPair(w, why, randomPos) {
    for (var i = 0; i < CONFIG.pairSize; i++) {
      var p = PAIR[i % PAIR.length], t = {}, k;
      for (k in DEFAULT_TRAITS) t[k] = DEFAULT_TRAITS[k];
      var x = randomPos ? 30 + rand(w) * (CONFIG.width - 60) : (i === 0 ? 0.25 : 0.75) * CONFIG.width;
      var y = randomPos ? 30 + rand(w) * (CONFIG.height - 60) : CONFIG.height / 2;
      makeBot(w, { name: p.name + (w.stats.era > 1 ? ' ' + w.stats.era : ''), hue: p.hue, traits: t, x: x, y: y, why: why });
    }
  }

  function spawnGrass(w) {
    var r = CONFIG.grassRadius;
    w.grass.push({ id: w.nextId++, x: r + rand(w) * (CONFIG.width - 2 * r), y: r + rand(w) * (CONFIG.height - 2 * r), born: w.tick });
    H.grassSpawn(w);
  }

  function createWorld(seed, startTime) {
    var w = { version: VERSION, seed: seed >>> 0, rng: seed >>> 0, startTime: startTime, tick: 0, nextId: 1,
              bots: [], grass: [], resproutAt: null, yearStrength: 1, year: 0, stats: Stats.create(), config: CONFIG };
    Stats.event(w, 'world', 'World created');
    freshPair(w, 'first pair', false);
    for (var i = 0; i < CONFIG.startGrass; i++) spawnGrass(w);
    return w;
  }

  // ---- Behaviour: a small priority system per bot ----
  // hungry: seek visible grass > recall remembered food spot > wander
  // fed:    social with nearest neighbour (near when food plentiful / avoid when scarce) > rest (energy high) > wander
  function unit(b, dx, dy) { var l = Math.sqrt(dx * dx + dy * dy); if (l > 1e-9) { b.hx = dx / l; b.hy = dy / l; } }
  function steer(b, dx, dy, k) { var l = Math.sqrt(dx * dx + dy * dy); if (l < 1e-9) return; unit(b, b.hx + k * dx / l, b.hy + k * dy / l); }
  function wanderTurn(w, b) {
    if (--b.turn > 0) return;
    var k = (randInt(w, -8, 8) + DIRS) % DIRS, c = DX[k], s = DY[k];
    unit(b, b.hx * c - b.hy * s, b.hx * s + b.hy * c);
    b.turn = randInt(w, 30, 120);
  }
  function foodMood(w) {
    var f = w.grass.length / seasonInfo(w).cap;
    return f >= CONFIG.plentyLevel ? 'plenty' : f <= CONFIG.scarceLevel ? 'scarce' : 'normal';
  }
  function nearestGrass(w, b, radius) {
    var best = null, bd = radius * radius;
    for (var j = 0; j < w.grass.length; j++) {
      var g = w.grass[j], dx = g.x - b.x, dy = g.y - b.y, d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = g; }
    }
    return best;
  }
  function decide(w, b, mood) {
    var E = b.energy / maxEnergy(b), prev = b.mode, mode, T = b.traits, speed = T.speed;
    if (E < T.hunger) {
      var g = nearestGrass(w, b, T.vision);
      if (g) {
        if (prev === 'recall') b.viaMemory = true; else if (prev !== 'seek') b.viaMemory = false;
        mode = 'seek'; b.target = g.id; unit(b, g.x - b.x, g.y - b.y);
      } else if (b.mem) {
        var mx = b.mem.x - b.x, my = b.mem.y - b.y;
        if (mx * mx + my * my < 20 * 20) { b.mem = null; mode = 'wander'; H.forget(w, b); }
        else { mode = 'recall'; unit(b, mx, my); }
        b.target = null;
      } else { mode = 'wander'; b.target = null; }
    } else {
      b.target = null; b.viaMemory = false;
      var other = null, od = Infinity;
      if (mood !== 'normal') for (var i = 0; i < w.bots.length; i++) {
        var o = w.bots[i]; if (o === b) continue;
        var ddx = o.x - b.x, ddy = o.y - b.y, dd = ddx * ddx + ddy * ddy;
        if (dd < od) { od = dd; other = o; }
      }
      var dist = Math.sqrt(od);
      if (other && mood === 'plenty' && dist > CONFIG.nearDist) { mode = 'near'; steer(b, other.x - b.x, other.y - b.y, CONFIG.socialPull * CONFIG.decideEvery); }
      else if (other && mood === 'scarce' && dist < CONFIG.avoidDist) { mode = 'avoid'; steer(b, b.x - other.x, b.y - other.y, CONFIG.socialPull * CONFIG.decideEvery); }
      else if (E > T.rest) { mode = 'rest'; speed = T.speed * CONFIG.restSpeedFactor; }
      else mode = 'wander';
    }
    b.mode = mode; b.speed = speed;
    if (mode !== prev) H.modeChange(w, b, prev, mode);
  }

  function mutate(w, t) {
    var c = {};
    for (var i = 0; i < TRAITS.length; i++) {
      var k = TRAITS[i], r = TRAIT_RULES[k];
      var n = (rand(w) + rand(w) + rand(w) - 1.5) * 2;     // ~N(0,1)-ish, deterministic
      c[k] = Math.round(clamp(t[k] + n * r.sd, r.min, r.max) * 1000) / 1000; // rounded: keeps saves small
    }
    if (c.rest < c.hunger + 0.05) c.rest = Math.min(1, c.hunger + 0.05);
    return c;
  }

  // ---- Rules: each is fn(world), run in order every tick. ----
  var RULES = [
    function seasons(w) {
      var y = Math.floor(w.tick / (4 * CONFIG.seasonTicks));
      if (y !== w.year) { w.year = y; w.yearStrength = CONFIG.strengthMin + rand(w) * (CONFIG.strengthMax - CONFIG.strengthMin); }
      if (w.tick % CONFIG.seasonTicks === 0) H.season(w, seasonInfo(w));
    },
    function growGrass(w) {
      var s = seasonInfo(w);
      if (rand(w) < s.spawn && w.grass.length < s.cap) spawnGrass(w);
    },
    function resprout(w) {
      if (w.bots.length > 0 || w.resproutAt === null || w.tick < w.resproutAt) return;
      w.resproutAt = null;
      H.newEra(w);
      freshPair(w, 'new life after extinction', true);
    },
    function behave(w) {
      var mood = foodMood(w), n = CONFIG.decideEvery;
      for (var i = 0; i < w.bots.length; i++) {
        var b = w.bots[i];
        wanderTurn(w, b);                                   // keeps RNG use independent of mode
        if ((w.tick + b.id) % n === 0) decide(w, b, mood);
        H.behavior(w, b);
      }
    },
    function move(w) {
      var W = CONFIG.width, Hh = CONFIG.height;
      for (var i = 0; i < w.bots.length; i++) {
        var b = w.bots[i], R = radius(b);
        b.px = b.x; b.py = b.y;
        b.x += b.hx * b.speed; b.y += b.hy * b.speed;
        if (b.x < R) { b.x = R; b.hx = -b.hx; }
        if (b.x > W - R) { b.x = W - R; b.hx = -b.hx; }
        if (b.y < R) { b.y = R; b.hy = -b.hy; }
        if (b.y > Hh - R) { b.y = Hh - R; b.hy = -b.hy; }
      }
    },
    function drainEnergy(w) {
      for (var i = 0; i < w.bots.length; i++) {
        var b = w.bots[i], cost = drain(b), d = Math.min(cost, b.energy);
        b.energy -= cost; H.spend(w, b, d);
      }
    },
    function eatGrass(w) {
      for (var i = 0; i < w.bots.length; i++) {
        var b = w.bots[i], reach = radius(b) + CONFIG.grassRadius, r2 = reach * reach, mx = maxEnergy(b);
        for (var j = w.grass.length - 1; j >= 0; j--) {
          var g = w.grass[j], dx = g.x - b.x, dy = g.y - b.y;
          if (dx * dx + dy * dy < r2) {
            var before = b.energy;
            b.energy = Math.min(mx, b.energy + CONFIG.grassEnergy);
            var how = b.target === g.id && b.mode === 'seek' ? (b.viaMemory ? 'memory' : 'sight') : 'bump';
            H.eat(w, b, b.energy - before, CONFIG.grassEnergy - (b.energy - before), how);
            b.mem = { x: g.x, y: g.y };
            b.target = null; b.viaMemory = false;
            w.grass.splice(j, 1);
          }
        }
      }
    },
    function reproduce(w) {
      var n = w.bots.length;
      for (var i = 0; i < n && w.bots.length < CONFIG.maxPop; i++) {
        var b = w.bots[i], mx = maxEnergy(b);
        if (b.energy < CONFIG.reproEnergy * mx || w.tick - b.born < CONFIG.reproMinAge || w.tick - b.lastRepro < CONFIG.reproCooldown) continue;
        b.energy -= CONFIG.reproCost * mx; b.lastRepro = w.tick; b.kids++;
        var t = mutate(w, b.traits), hue = Math.round((b.hue + (rand(w) - 0.5) * 16 + 360) % 360);
        var a = randInt(w, 0, DIRS - 1), off = radius(b) + t.size + 4;
        var child = makeBot(w, { name: b.name, gen: b.gen + 1, parent: b.id, lineage: b.lineage, hue: hue, traits: t,
                                 x: clamp(b.x + DX[a] * off, t.size, CONFIG.width - t.size), y: clamp(b.y + DY[a] * off, t.size, CONFIG.height - t.size),
                                 why: 'child of #' + b.id, energy: 0 });
        child.energy = CONFIG.childEnergy * maxEnergy(child);
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
  function advanceTo(w, timeMs, maxSteps) {
    var target = tickAt(w, timeMs), n = 0;
    while (w.tick < target && (maxSteps === undefined || n < maxSteps)) { step(w); n++; }
    return target - w.tick;
  }

  function formatDuration(ms) {
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + 'd ' + h + 'h ' + m + 'm';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm ' + (s % 60) + 's';
  }

  function serialize(w) {
    var copy = JSON.parse(JSON.stringify(w)); delete copy.config; Stats.compact(copy);
    copy.savedAt = new Date(w.startTime + w.tick * CONFIG.tickMs).toISOString();
    return JSON.stringify(copy);
  }
  function deserialize(text) { var w = typeof text === 'string' ? JSON.parse(text) : text; w.config = CONFIG; return w; }

  var api = { VERSION: VERSION, CONFIG: CONFIG, RULES: RULES, TRAITS: TRAITS, TRAIT_RULES: TRAIT_RULES, DEFAULT_TRAITS: DEFAULT_TRAITS,
              createWorld: createWorld, step: step, advanceTo: advanceTo, tickAt: tickAt, serialize: serialize, deserialize: deserialize,
              Stats: Stats, foodMood: foodMood, seasonInfo: seasonInfo, maxEnergy: maxEnergy, radius: radius, drain: drain,
              formatDuration: formatDuration, DX: DX, DY: DY, DIRS: DIRS, MODES: Stats.MODES };
  Stats.bind(api);
  return api;
});
