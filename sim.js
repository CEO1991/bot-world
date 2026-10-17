/* Bot World simulation core. Shared by the browser (index.html) and Node (scripts/advance.js).
 * Deterministic: only + - * / sqrt, Math.floor/round/min/max/imul and the seeded PRNG are used in the step
 * (tanh is a rational approximation, angles use a precomputed table), so every JS engine produces the
 * same world from the same state. Rules are the functions in RULES. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stats.js'));
  else root.BotSim = factory(root.BotStats);
})(typeof self !== 'undefined' ? self : this, function (Stats) {
  'use strict';

  var CONFIG = {
    width: 1000, height: 625,
    tickMs: 100,               // 10 ticks per real second
    // energy model (per tick). sizeF = size / 14
    baseMaxEnergy: 200,        // max energy = 200 * sizeF^2
    drainBase: 0.01,           // * sizeF^2           (living cost)
    drainPerSpeed: 0.0075,     // * speed * sizeF     (moving cost; speed is chosen by the brain)
    drainPerVision: 0.00004,   // * vision            (seeing far costs energy)
    grassRadius: 9,
    grassEnergy: 25,
    seasonTicks: 72000,        // 2 simulated hours per season -> 8-hour year
    seasons: [
      { name: 'Spring', spawn: 0.02,  cap: 30 },
      { name: 'Summer', spawn: 0.03,  cap: 40 },
      { name: 'Autumn', spawn: 0.015, cap: 22 },
      { name: 'Winter', spawn: 0.012, cap: 16 }
    ],
    strengthMin: 0.7, strengthMax: 1.3,
    startGrass: 15,
    // brain
    thinkEvery: 5,             // each bot runs its brain every 5 ticks = 0.5 s (staggered)
    maxTurn: 0.5,              // heading change per think at full turn output
    // reproduction (the brain's "reproduce" output must be > 0 as well)
    maxPop: 30,
    reproEnergy: 0.6,          // needs >= 60% of max energy
    reproMinAge: 6000,         // 10 min old
    reproCooldown: 9000,       // 15 min between children
    reproCost: 0.45,           // parent pays 45% of its max energy...
    childEnergy: 0.35,         // ...child starts with 35% of its own max
    // mutation of brain weights (stored as integers in thousandths)
    mutRate: 0.08, mutSd: 0.25, bigMutChance: 0.04, bigMutSd: 0.6, wMax: 4,
    hallOfFame: 4,             // best genomes kept to seed re-sprouts
    resproutDelayTicks: 50,
    pairSize: 2
  };

  var TRAITS = ['speed', 'vision', 'size'];
  var DEFAULT_TRAITS = { speed: 4, vision: 150, size: 14 };
  var TRAIT_RULES = { speed: { sd: 0.25, min: 1, max: 8 }, vision: { sd: 10, min: 40, max: 320 }, size: { sd: 0.8, min: 8, max: 24 } };

  // Brain layout: inputs -> hidden (tanh) -> outputs (tanh). The last input is a constant bias.
  var INPUTS = ['energy', 'grassNear', 'grassSide', 'grassAhead', 'botNear', 'botSide', 'botAhead', 'botEnergy', 'botSignal',
                'crowd', 'seasonSin', 'seasonCos', 'abundance', 'age', 'memory', 'bias'];
  var OUTPUTS = ['turn', 'speed', 'reproduce', 'memory', 'signal'];
  var NI = INPUTS.length, NH = 7, NO = OUTPUTS.length;
  var NW = NI * NH + (NH + 1) * NO; // hidden has its own bias unit for outputs

  // Deterministic 64-direction table (own Taylor series; Math.sin/cos differ between engines).
  var DIRS = 64, DX = [], DY = [];
  (function () {
    var PI = 3.141592653589793;
    function sinT(x) { var t = x, s = x; for (var n = 1; n < 25; n++) { t = -t * x * x / ((2 * n) * (2 * n + 1)); s += t; } return s; }
    function cosT(x) { var t = 1, s = 1; for (var n = 1; n < 25; n++) { t = -t * x * x / ((2 * n - 1) * (2 * n)); s += t; } return s; }
    for (var i = 0; i < DIRS; i++) { var a = (i < DIRS / 2 ? i : i - DIRS) * 2 * PI / DIRS; DX.push(cosT(a)); DY.push(sinT(a)); }
  })();

  function rand(w) {   // mulberry32; state lives in world.rng
    var t = (w.rng = (w.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function randInt(w, lo, hi) { return lo + Math.floor(rand(w) * (hi - lo + 1)); }
  function gauss(w) { return (rand(w) + rand(w) + rand(w) - 1.5) * 2; } // ~N(0,1)-ish
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  // Rational tanh approximation (exact same result on every engine; error < 0.02).
  function tanh(x) { if (x > 3) return 1; if (x < -3) return -1; var x2 = x * x; return x * (27 + x2) / (27 + 9 * x2); }

  var VERSION = 6;
  var H = Stats.hooks;
  var PAIR = [{ name: 'Blue', hue: 195 }, { name: 'Orange', hue: 25 }];

  function sizeF(b) { return b.traits.size / 14; }
  function maxEnergy(b) { var f = sizeF(b); return CONFIG.baseMaxEnergy * f * f; }
  function radius(b) { return b.traits.size; }
  function drain(b) {
    var f = sizeF(b);
    return CONFIG.drainBase * f * f + CONFIG.drainPerSpeed * b.speed * f + CONFIG.drainPerVision * b.traits.vision;
  }

  function seasonInfo(w, tick) {
    var t = tick === undefined ? w.tick : tick, len = CONFIG.seasonTicks;
    var idx = Math.floor(t / len) % 4, year = Math.floor(t / (4 * len));
    var s = CONFIG.seasons[idx], k = w.yearStrength, m = idx === 3 ? 1 / k : k;
    return { index: idx, name: s.name, year: year, strength: k, spawn: s.spawn * m,
             cap: Math.max(1, Math.round(s.cap * m)), endsAt: (Math.floor(t / len) + 1) * len };
  }

  // ---- genomes ----
  function randomBrain(w) { var g = []; for (var i = 0; i < NW; i++) g.push(Math.round((rand(w) - 0.5) * 1000)); return g; } // weights in [-0.5, 0.5]
  function mutateBrain(w, g, strong) {
    var c = g.slice(), big = strong || rand(w) < CONFIG.bigMutChance, lim = CONFIG.wMax * 1000;
    for (var i = 0; i < c.length; i++) {
      if (big) c[i] = clamp(Math.round(c[i] + gauss(w) * CONFIG.bigMutSd * 1000 * 0.5), -lim, lim);
      else if (rand(w) < CONFIG.mutRate) c[i] = clamp(Math.round(c[i] + gauss(w) * CONFIG.mutSd * 1000), -lim, lim);
    }
    return { brain: c, big: big };
  }
  function mutateTraits(w, t) {
    var c = {};
    for (var i = 0; i < TRAITS.length; i++) { var k = TRAITS[i], r = TRAIT_RULES[k]; c[k] = Math.round(clamp(t[k] + gauss(w) * r.sd, r.min, r.max) * 1000) / 1000; }
    return c;
  }

  function makeBot(w, o) {
    var b = { id: w.nextId++, name: o.name, gen: o.gen || 1, parent: o.parent || null, lineage: o.lineage || null,
              hue: o.hue, traits: o.traits, brain: o.brain, x: o.x, y: o.y, px: o.x, py: o.y, hx: 0, hy: 0,
              energy: 0, born: w.tick, lastRepro: w.tick, kids: 0, speed: 0, want: 0, mem: 0, sig: 0 };
    if (!b.lineage) b.lineage = b.id;
    b.energy = o.energy === undefined ? maxEnergy(b) : o.energy;
    var d = randInt(w, 0, DIRS - 1); b.hx = DX[d]; b.hy = DY[d];
    b.speed = b.traits.speed * 0.5;
    w.bots.push(b); H.birth(w, b, o.why);
    return b;
  }
  function freshPair(w, why, randomPos) {
    var hof = w.hof || [];
    for (var i = 0; i < CONFIG.pairSize; i++) {
      var x = randomPos ? 30 + rand(w) * (CONFIG.width - 60) : (i === 0 ? 0.25 : 0.75) * CONFIG.width;
      var y = randomPos ? 30 + rand(w) * (CONFIG.height - 60) : CONFIG.height / 2;
      var src = hof.length ? hof[i % hof.length] : null, t = {}, k;
      if (src) {  // re-sprout from the hall of fame (mutated), so evolution isn't lost between eras
        makeBot(w, { name: src.name.split(' ')[0] + ' ' + (w.stats.era), hue: src.hue, traits: mutateTraits(w, src.traits),
                     brain: mutateBrain(w, src.brain, false).brain, x: x, y: y, why: why + ', descended from hall-of-fame #' + src.id });
      } else {
        var p = PAIR[i % PAIR.length];
        for (k in DEFAULT_TRAITS) t[k] = DEFAULT_TRAITS[k];
        makeBot(w, { name: p.name + (w.stats.era > 1 ? ' ' + w.stats.era : ''), hue: p.hue, traits: t, brain: randomBrain(w), x: x, y: y, why: why + ', random brain' });
      }
    }
  }
  function remember(w, b) {   // hall of fame: score = lifetime + 2h per child
    var score = (w.tick - b.born) + 72000 * b.kids, hof = w.hof;
    if (hof.length >= CONFIG.hallOfFame && score <= hof[hof.length - 1].score) return;
    hof.push({ id: b.id, name: b.name, gen: b.gen, hue: b.hue, score: score, kids: b.kids, lived: w.tick - b.born, traits: b.traits, brain: b.brain });
    hof.sort(function (a, c) { return c.score - a.score || a.id - c.id; });
    if (hof.length > CONFIG.hallOfFame) hof.length = CONFIG.hallOfFame;
  }

  function spawnGrass(w) {
    var r = CONFIG.grassRadius;
    w.grass.push({ id: w.nextId++, x: r + rand(w) * (CONFIG.width - 2 * r), y: r + rand(w) * (CONFIG.height - 2 * r), born: w.tick });
    H.grassSpawn(w);
  }

  function createWorld(seed, startTime) {
    var w = { version: VERSION, seed: seed >>> 0, rng: seed >>> 0, startTime: startTime, tick: 0, nextId: 1,
              bots: [], grass: [], hof: [], resproutAt: null, yearStrength: 1, year: 0, stats: Stats.create(), config: CONFIG };
    Stats.event(w, 'world', 'World created');
    freshPair(w, 'first pair', false);
    for (var i = 0; i < CONFIG.startGrass; i++) spawnGrass(w);
    return w;
  }

  // ---- brain: sense -> think -> act ----
  var IN = new Float64Array(NI), HID = new Float64Array(NH + 1), OUT = new Float64Array(NO);
  // Decoded weights (thousandths -> floats) cached per genome array; genomes are never modified in place.
  var CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;
  function weights(g) {
    var f = CACHE && CACHE.get(g); if (f) return f;
    f = new Float64Array(g.length); for (var i = 0; i < g.length; i++) f[i] = g[i] / 1000;
    if (CACHE) CACHE.set(g, f); return f;
  }
  function think(w, b, info) {
    var T = b.traits, vis2 = T.vision * T.vision, hx = b.hx, hy = b.hy, i, j;
    var g = null, gd = vis2;
    var V = T.vision, bx = b.x, by = b.y, G = w.grass, BS = w.bots;
    for (i = 0; i < G.length; i++) { var q = G[i], dx = q.x - bx; if (dx > V || dx < -V) continue;
      var dy = q.y - by, d = dx * dx + dy * dy; if (d <= gd) { gd = d; g = q; } }
    var o = null, od = vis2, crowd = 0;
    for (i = 0; i < BS.length; i++) {
      var p = BS[i]; if (p === b) continue;
      var ex = p.x - bx; if (ex > V || ex < -V) continue;
      var ey = p.y - by, e = ex * ex + ey * ey;
      if (e <= vis2) { crowd++; if (e < od) { od = e; o = p; } }
    }
    var mx = maxEnergy(b), E = b.energy / mx;
    IN[0] = E;
    if (g) { var gl = Math.sqrt(gd) || 1, gx = (g.x - b.x) / gl, gy = (g.y - b.y) / gl;
      IN[1] = 1 - gl / T.vision; IN[2] = hx * gy - hy * gx; IN[3] = hx * gx + hy * gy; }
    else { IN[1] = 0; IN[2] = 0; IN[3] = 0; }
    if (o) { var ol = Math.sqrt(od) || 1, ux = (o.x - b.x) / ol, uy = (o.y - b.y) / ol;
      IN[4] = 1 - ol / T.vision; IN[5] = hx * uy - hy * ux; IN[6] = hx * ux + hy * uy; IN[7] = o.energy / maxEnergy(o); IN[8] = o.sig; }
    else { IN[4] = 0; IN[5] = 0; IN[6] = 0; IN[7] = 0; IN[8] = 0; }
    IN[9] = crowd / 5;
    var ph = Math.floor((w.tick % (4 * CONFIG.seasonTicks)) * DIRS / (4 * CONFIG.seasonTicks));
    IN[10] = DY[ph]; IN[11] = DX[ph];
    IN[12] = w.grass.length / info.cap;
    IN[13] = Math.min(1, (w.tick - b.born) / 72000);
    IN[14] = b.mem; IN[15] = 1;
    var W = weights(b.brain), k = 0, s;
    for (j = 0; j < NH; j++) { s = 0; for (i = 0; i < NI; i++) s += IN[i] * W[k++]; HID[j] = tanh(s); }
    HID[NH] = 1;
    for (j = 0; j < NO; j++) { s = 0; for (i = 0; i <= NH; i++) s += HID[i] * W[k++]; OUT[j] = tanh(s); }
    // act
    var turn = OUT[0] * CONFIG.maxTurn;
    var nx = hx - hy * turn, ny = hy + hx * turn, nl = Math.sqrt(nx * nx + ny * ny);
    b.hx = nx / nl; b.hy = ny / nl;
    b.speed = T.speed * (OUT[1] + 1) / 2;
    b.want = OUT[2]; b.mem = OUT[3]; b.sig = OUT[4];
    H.perceive(w, b, E, g ? IN[3] : null, o, o ? IN[6] : null, (OUT[1] + 1) / 2, info);
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
    function brains(w) {
      var n = CONFIG.thinkEvery, info = seasonInfo(w);
      for (var i = 0; i < w.bots.length; i++) { var b = w.bots[i]; if ((w.tick + b.id) % n === 0) think(w, b, info); }
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
          var g = w.grass[j], dx = g.x - b.x; if (dx > reach || dx < -reach) continue;
          var dy = g.y - b.y;
          if (dx * dx + dy * dy < r2) {
            var before = b.energy;
            b.energy = Math.min(mx, b.energy + CONFIG.grassEnergy);
            H.eat(w, b, b.energy - before, CONFIG.grassEnergy - (b.energy - before));
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
        if (w.tick % CONFIG.thinkEvery !== 0) continue;      // eligibility checked once per think cycle
        H.eligible(w, b);
        if (b.want <= 0) continue;                          // the brain decides whether to breed now
        b.energy -= CONFIG.reproCost * mx; b.lastRepro = w.tick; b.kids++;
        var m = mutateBrain(w, b.brain, false), t = mutateTraits(w, b.traits);
        var hue = Math.round((b.hue + gauss(w) * 6 + 360) % 360);
        var a = randInt(w, 0, DIRS - 1), off = radius(b) + t.size + 4;
        var child = makeBot(w, { name: b.name, gen: b.gen + 1, parent: b.id, lineage: b.lineage, hue: hue, traits: t, brain: m.brain,
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
          remember(w, b);
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
  // Compact genome encoding for saves: each weight (-4000..4000) -> 2 chars of a 91-symbol alphabet.
  var ALPHA = ''; for (var c = 35; c < 127; c++) if (c !== 92) ALPHA += String.fromCharCode(c);
  function encodeBrain(g) { var out = ''; for (var i = 0; i < g.length; i++) { var v = g[i] + 4000; out += ALPHA[Math.floor(v / 91)] + ALPHA[v % 91]; } return out; }
  function decodeBrain(str) { var g = []; for (var i = 0; i < str.length; i += 2) g.push(ALPHA.indexOf(str[i]) * 91 + ALPHA.indexOf(str[i + 1]) - 4000); return g; }
  function serialize(w) {
    var copy = JSON.parse(JSON.stringify(w)); delete copy.config; Stats.compact(copy);
    copy.bots.forEach(function (b) { b.brain = encodeBrain(b.brain); delete b.px; delete b.py; }); // px/py are render-only
    copy.hof.forEach(function (h) { h.brain = encodeBrain(h.brain); });
    copy.savedAt = new Date(w.startTime + w.tick * CONFIG.tickMs).toISOString();
    return JSON.stringify(copy);
  }
  function deserialize(text) {
    var w = typeof text === 'string' ? JSON.parse(text) : text; w.config = CONFIG;
    if (w.version !== VERSION) return w;   // older saves are rejected by the caller; don't touch them
    w.bots.forEach(function (b) { if (typeof b.brain === 'string') b.brain = decodeBrain(b.brain); if (b.px === undefined) { b.px = b.x; b.py = b.y; } });
    w.hof.forEach(function (h) { if (typeof h.brain === 'string') h.brain = decodeBrain(h.brain); });
    return w;
  }

  var api = { VERSION: VERSION, CONFIG: CONFIG, RULES: RULES, TRAITS: TRAITS, TRAIT_RULES: TRAIT_RULES, DEFAULT_TRAITS: DEFAULT_TRAITS,
              INPUTS: INPUTS, OUTPUTS: OUTPUTS, NH: NH, NW: NW,
              createWorld: createWorld, step: step, advanceTo: advanceTo, tickAt: tickAt, serialize: serialize, deserialize: deserialize,
              Stats: Stats, seasonInfo: seasonInfo, maxEnergy: maxEnergy, radius: radius, drain: drain, tanh: tanh,
              formatDuration: formatDuration, DX: DX, DY: DY, DIRS: DIRS };
  Stats.bind(api);
  return api;
});
