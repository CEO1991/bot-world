/* Bot World simulation core. Shared by the browser (index.html) and Node (scripts/advance.js).
 * Deterministic: only + - * / sqrt, Math.floor/round/min/max/abs/imul and seeded PRNGs are used in the step
 * (tanh is a rational approximation, angles use a precomputed table), so every JS engine produces the
 * same world from the same state. Nothing here hard-codes behaviour: bots act only through their brain outputs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stats.js'));
  else root.BotSim = factory(root.BotStats);
})(typeof self !== 'undefined' ? self : this, function (Stats) {
  'use strict';

  var CONFIG = {
    width: 1000, height: 625, tile: 25,      // terrain grid 40 x 25 tiles
    tickMs: 100,               // one tick = 0.1 simulated seconds
    clockRate: 10,             // simulated seconds per real second for the shared world (new rate changes are recorded in w.clocks)
    // energy (per tick); sizeF = size / 14
    baseMaxEnergy: 200, drainBase: 0.008, drainPerThrust: 0.003, drainPerVision: 0.00004,
    climbCost: 0.6,            // energy per unit of elevation climbed (x sizeF^2); downhill refunds half
    coldCost: 0.015,            // extra drain per tick at full cold for a lone bot
    warmRadius: 45,            // bots whose edges are within this distance warm each other
    warmPerBot: 0.34,          // each close bot removes 34% of the cold cost (capped at 100%)
    seasonTemp: [0.75, 1, 0.6, 0], // spring, summer, autumn, winter (1 = warm, 0 = cold)
    // movement physics
    friction: 0.9, waterFriction: 0.75, turnPerTick: 0.08, wallBounce: 0.5, carrySlow: 0.12,
    // food
    grassRadius: 9, grassEnergy: 25, maxCarry: 2, maxDropped: 60,
    dropDecayTicks: 216000,    // dropped food rots after 6 simulated hours
    ownDropGrace: 100,         // a bot ignores food it just dropped for 10 s
    seasonTicks: 72000,
    seasons: [
      { name: 'Spring', spawn: 0.02,  cap: 30 },
      { name: 'Summer', spawn: 0.033, cap: 42 },
      { name: 'Autumn', spawn: 0.024, cap: 32 },
      { name: 'Winter', spawn: 0.012, cap: 14 }
    ],
    strengthMin: 0.7, strengthMax: 1.3, startGrass: 15,
    // signals
    signalRange: 250,
    // brain
    thinkEvery: 14,            // each bot thinks every 1.4 sim seconds (staggered; 0.14 real s at 10x); must stay even; forces apply every tick
    // reproduction (brain's reproduce output must be > 0 too)
    maxPop: 30, reproEnergy: 0.5, reproMinAge: 3000, reproCooldown: 9000, reproCost: 0.45, childEnergy: 0.5,
    mutRate: 0.08, mutSd: 0.25, bigMutChance: 0.04, bigMutSd: 0.6, wMax: 4,
    hallOfFame: 4, resproutDelayTicks: 50, pairSize: 2,
    resproutStrong: false,     // re-sprouts use a big mutation of the hall-of-fame brain
    resproutRandom: 1,         // BASELINE: one re-sprouted founder gets a fresh random brain (stops stale hall-of-fame traps)
    // ---- lifetime learning & heritage (switches exist for control experiments) ----
    learning: false,           // v11 rules: lifetime learning switched off
    inherit: false,            // children receive teach-fraction of the parent's learned deltas
    apprentice: false,         // children sense their parent and imitate it while young
    landmarkSense: true,       // bots sense family landmarks
    deltaUnit: 4000,           // learned deltas are ints: 4000 = 1.0 weight; bounded to +-1.0
    apprenticeTicks: 12000,    // childhood (imitation possible): first 20 sim minutes
    imitateRadius: 120, imitateRate: 0.03, parentRange: 400,
    landmarkMax: 3, landmarkRange: 400, landmarkDecay: 144000, landmarkRefresh: 30, landmarkMinGap: 80, landmarkCooldown: 6000, landmarkCost: 5,
    // ---- caves (fixed per world, from the terrain seed) ----
    caves: true,               // caves exist and can be sensed (control: false)
    caveBenefit: true,         // shelter works (control: false = caves are just places)
    caveSense: true,           // bots sense caves (direction, closeness, crowding)
    caveRadius: 28, caveCapacity: 4, caveRange: 400,
    caveRest: 0.4,             // resting drain (base + vision) inside a cave is 40% of normal; no cold drain at all
    caveDecayMul: 8,           // food dropped inside a cave rots 8x slower (48 h instead of 6 h)
    // ---- winter cave moss: a little low-energy food regrows inside caves in autumn and winter ----
    moss: true,                // control: false
    mossEnergy: 12,            // vs 25 for grass
    mossRate: [0, 0, 0.0008, 0.0016],   // chance per tick per cave (spring, summer, autumn, winter)
    mossCap: 3                 // at most 3 moss patches lying in a cave
  };

  var TRAITS = ['speed', 'vision', 'size'];
  var DEFAULT_TRAITS = { speed: 4, vision: 150, size: 14 };
  var TRAIT_RULES = { speed: { sd: 0.25, min: 1, max: 8 }, vision: { sd: 10, min: 40, max: 320 }, size: { sd: 0.8, min: 8, max: 24 },
                     learn: { sd: 0.01, min: 0, max: 0.3 }, teach: { sd: 0.03, min: 0, max: 0.5 } };

  var ALL_INPUTS = ['energy', 'grassNear', 'grassSide', 'grassAhead', 'botNear', 'botSide', 'botAhead', 'botEnergy', 'botKin',
                'crowd', 'seasonSin', 'seasonCos', 'abundance', 'age', 'memory', 'warmth',
                'onWater', 'elevation', 'fertilityAhead', 'slopeAhead', 'carrying',
                'signalSide', 'signalAhead', 'signal1', 'signal2', 'speed',
                'markSide', 'markAhead', 'markNear', 'foreignMark', 'parentSide', 'parentAhead', 'parentNear', 'parentAlive',
                'caveSide', 'caveAhead', 'caveNear', 'inCave', 'caveCrowd', 'bias'];
  // Trimmed (v11 rules): kin, foreign-flag, carrying and the four parent senses are computed nowhere in the brain.
  // They were removed because teaching/apprenticeship are gone and measurement showed the rest barely changed any action.
  var REMOVED = { botKin: 1, foreignMark: 1, carrying: 1, parentSide: 1, parentAhead: 1, parentNear: 1, parentAlive: 1 };
  var INPUTS = ALL_INPUTS.filter(function (k) { return !REMOVED[k]; }), MAP = INPUTS.map(function (k) { return ALL_INPUTS.indexOf(k); });
  var FIN = new Float64Array(ALL_INPUTS.length);
  var OUTPUTS = ['turn', 'thrust', 'reproduce', 'memory', 'signal1', 'signal2', 'pickUp', 'drop', 'eatCarried', 'mark'];
  var NI = INPUTS.length, NH = 8, NO = OUTPUTS.length;
  var NW = NI * NH + (NH + 1) * NO, ND = (NH + 1) * NO;   // ND = size of the plastic (learned) layer

  // Deterministic 64-direction table.
  var DIRS = 64, DX = [], DY = [];
  (function () {
    var PI = 3.141592653589793;
    function sinT(x) { var t = x, s = x; for (var n = 1; n < 25; n++) { t = -t * x * x / ((2 * n) * (2 * n + 1)); s += t; } return s; }
    function cosT(x) { var t = 1, s = 1; for (var n = 1; n < 25; n++) { t = -t * x * x / ((2 * n - 1) * (2 * n)); s += t; } return s; }
    for (var i = 0; i < DIRS; i++) { var a = (i < DIRS / 2 ? i : i - DIRS) * 2 * PI / DIRS; DX.push(cosT(a)); DY.push(sinT(a)); }
  })();

  function mulberry(state) {
    var t = (state + 0x6D2B79F5) >>> 0, r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return { state: t, value: ((r ^ (r >>> 14)) >>> 0) / 4294967296 };
  }
  function rand(w) { var m = mulberry(w.rng); w.rng = m.state; return m.value; }
  function randInt(w, lo, hi) { return lo + Math.floor(rand(w) * (hi - lo + 1)); }
  function gauss(w) { return (rand(w) + rand(w) + rand(w) - 1.5) * 2; }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function tanh(x) { if (x > 3) return 1; if (x < -3) return -1; var x2 = x * x; return x * (27 + x2) / (27 + 9 * x2); }

  var VERSION = 11;
  var H = Stats.hooks;
  var PAIR = [{ name: 'Blue', hue: 195 }, { name: 'Orange', hue: 25 }];

  // ---------------- runtime caches (never saved; rebuilt from the save) ----------------
  var RT = typeof WeakMap === 'function' ? new WeakMap() : null, RT_FALLBACK = null;
  function rt(w) {
    var r = RT ? RT.get(w) : (RT_FALLBACK && RT_FALLBACK.w === w ? RT_FALLBACK : null);
    if (r) return r;
    r = { w: w, terrain: terrainFor(w.terrainSeed), food: null, bots: null, occ: [0, 0, 0, 0, 0, 0] };
    r.food = foodGridBuild(w);
    if (RT) RT.set(w, r); else RT_FALLBACK = r;
    return r;
  }

  // ---------------- terrain (fixed per world, derived from terrainSeed) ----------------
  var TERRAIN_CACHE = {};
  function terrainFor(seed) {
    if (TERRAIN_CACHE[seed]) return TERRAIN_CACHE[seed];
    var TW = CONFIG.width / CONFIG.tile, TH = CONFIG.height / CONFIG.tile, N = TW * TH, st = seed >>> 0;
    function r() { var m = mulberry(st); st = m.state; return m.value; }
    // elevation: two octaves of value noise, bilinear (only + - * /)
    var elev = new Float64Array(N), i, x, y;
    function octave(cells, amp) {
      var gw = cells + 1, gh = Math.ceil(cells * TH / TW) + 1, grid = [];
      for (i = 0; i < gw * gh; i++) grid.push(r());
      for (y = 0; y < TH; y++) for (x = 0; x < TW; x++) {
        var fx = x / TW * cells, fy = y / TH * (gh - 1), ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        var a = grid[iy * gw + ix], b = grid[iy * gw + ix + 1], c = grid[(iy + 1) * gw + ix], d = grid[(iy + 1) * gw + ix + 1];
        tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
        elev[y * TW + x] += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
      }
    }
    octave(4, 0.7); octave(10, 0.3);
    var water = new Uint8Array(N);
    function carve(px, py, dx, dy, steps) {   // a river wanders downhill-ish across the map
      for (var s = 0; s < steps; s++) {
        if (px < 0 || py < 0 || px >= TW || py >= TH) return;
        water[py * TW + px] = 1;
        var side = dx === 0 ? 1 : 0;           // widen the river to 2 tiles
        var qx = px + side, qy = py + (1 - side); if (qx < TW && qy < TH) water[qy * TW + qx] = 1;
        var best = 0, bv = Infinity;
        for (var o = -1; o <= 1; o++) {
          var nx = px + dx + (dx === 0 ? o : 0), ny = py + dy + (dy === 0 ? o : 0);
          if (nx < 0 || ny < 0 || nx >= TW || ny >= TH) continue;
          var v = elev[ny * TW + nx] + r() * 0.25;
          if (v < bv) { bv = v; best = o; }
        }
        px += dx + (dx === 0 ? best : 0); py += dy + (dy === 0 ? best : 0);
      }
    }
    carve(Math.floor(TW * (0.25 + r() * 0.5)), 0, 0, 1, TH + 5);
    if (r() < 0.7) carve(0, Math.floor(TH * (0.2 + r() * 0.6)), 1, 0, Math.floor(TW * (0.4 + r() * 0.6)));
    for (i = 0; i < N; i++) if (water[i]) elev[i] = Math.min(elev[i], 0.2);
    // distance to water (tiles, Chebyshev) and fertility
    var dist = new Uint8Array(N), fert = new Float64Array(N), total = 0, cum = new Float64Array(N), bank = new Uint8Array(N), bankTiles = 0, landTiles = 0;
    for (i = 0; i < N; i++) dist[i] = water[i] ? 0 : 99;
    for (var pass = 0; pass < 6; pass++) for (y = 0; y < TH; y++) for (x = 0; x < TW; x++) {
      var k = y * TW + x; if (dist[k] === 0) continue; var m = dist[k];
      for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
        var xx = x + ox, yy = y + oy; if (xx < 0 || yy < 0 || xx >= TW || yy >= TH) continue;
        var dd = dist[yy * TW + xx] + 1; if (dd < m) m = dd;
      }
      dist[k] = m;
    }
    for (i = 0; i < N; i++) {
      var f = water[i] ? 0 : dist[i] === 1 ? 1 : dist[i] === 2 ? 0.7 : dist[i] === 3 ? 0.4 : elev[i] > 0.62 ? 0.05 : 0.15;
      fert[i] = f; total += f; cum[i] = total;
      if (!water[i]) { landTiles++; if (dist[i] <= 2) { bank[i] = 1; bankTiles++; } }
    }
    // caves: 3-5 small shelters, mostly in the hills, some at the edge of the plains (generated after everything else,
    // so the rest of the terrain is unchanged for a given seed)
    var caves = [], nc = 3 + Math.floor(r() * 3), hill = [], edge = [];
    for (i = 0; i < N; i++) { x = i % TW; y = (i - x) / TW;
      if (water[i] || dist[i] <= 1 || x < 1 || y < 1 || x >= TW - 1 || y >= TH - 1) continue;
      if (elev[i] >= 0.6) hill.push(i); else if (elev[i] >= 0.45) edge.push(i); }
    for (var tries = 0; tries < 200 && caves.length < nc; tries++) {
      var pool = (r() < 0.75 && hill.length) || !edge.length ? hill : edge; if (!pool.length) break;
      var ti = pool[Math.floor(r() * pool.length)], cxp = (ti % TW + 0.5) * CONFIG.tile, cyp = (Math.floor(ti / TW) + 0.5) * CONFIG.tile, ok = true;
      for (var q = 0; q < caves.length; q++) { var ddx = caves[q].x - cxp, ddy = caves[q].y - cyp; if (ddx * ddx + ddy * ddy < 160 * 160) ok = false; }
      if (ok) caves.push({ x: cxp, y: cyp, hill: elev[ti] >= 0.6 ? 1 : 0 });
    }
    var T = { TW: TW, TH: TH, elev: elev, water: water, fert: fert, cum: cum, total: total, dist: dist, bank: bank, bankFrac: bankTiles / Math.max(1, landTiles), caves: caves };
    TERRAIN_CACHE[seed] = T; return T;
  }
  function cavesOf(T) { return CONFIG.caves ? T.caves : NO_CAVES; }
  var NO_CAVES = [];
  function caveAt(C, x, y) { var R2 = CONFIG.caveRadius * CONFIG.caveRadius; for (var i = 0; i < C.length; i++) { var dx = C[i].x - x, dy = C[i].y - y; if (dx * dx + dy * dy < R2) return i; } return -1; }
  function tileAt(T, x, y) {
    var tx = Math.floor(x / CONFIG.tile), ty = Math.floor(y / CONFIG.tile);
    if (tx < 0) tx = 0; if (ty < 0) ty = 0; if (tx >= T.TW) tx = T.TW - 1; if (ty >= T.TH) ty = T.TH - 1;
    return ty * T.TW + tx;
  }

  // ---------------- food spatial grid (ground items) ----------------
  var CELL = 50, GW = Math.ceil(CONFIG.width / CELL), GH = Math.ceil(CONFIG.height / CELL);
  var HEAD = new Int32Array(GW * GH), NEXT = new Int32Array(64), CI = new Int32Array(64), FWD_X = [0, 1, -1, 0, 1], FWD_Y = [0, 0, 1, 1, 1];
  function cellOf(x, y) { var cx = Math.floor(x / CELL), cy = Math.floor(y / CELL); if (cx < 0) cx = 0; if (cy < 0) cy = 0; if (cx >= GW) cx = GW - 1; if (cy >= GH) cy = GH - 1; return cy * GW + cx; }
  function foodGridBuild(w) { var g = []; for (var i = 0; i < GW * GH; i++) g.push([]); for (i = 0; i < w.grass.length; i++) g[cellOf(w.grass[i].x, w.grass[i].y)].push(w.grass[i]); return g; }
  function addFood(w, f) { w.grass.push(f); rt(w).food[cellOf(f.x, f.y)].push(f); if (f.drop) w.dropped++; else if (f.moss) w.mossN++; else w.natural++; }
  function removeFood(w, f) {
    var c = rt(w).food[cellOf(f.x, f.y)]; c.splice(c.indexOf(f), 1);
    w.grass.splice(w.grass.indexOf(f), 1); if (f.drop) w.dropped--; else if (f.moss) w.mossN--; else w.natural--;
  }

  // ---------------- bodies ----------------
  function sizeF(b) { return b.traits.size / 14; }
  function maxEnergy(b) { var f = sizeF(b); return CONFIG.baseMaxEnergy * f * f; }
  function radius(b) { return b.traits.size; }
  function temperature(w, T, b) {   // environment warmth at the bot (0 cold .. 1 warm)
    var k = tileAt(T, b.x, b.y), t = CONFIG.seasonTemp[Math.floor(w.tick / CONFIG.seasonTicks) % 4];
    if (T.water[k]) t -= 0.15; t -= 0.15 * Math.max(0, T.elev[k] - 0.5);
    return clamp(t, 0, 1);
  }
  function seasonInfo(w, tick) {
    var t = tick === undefined ? w.tick : tick, len = CONFIG.seasonTicks;
    var idx = Math.floor(t / len) % 4, year = Math.floor(t / (4 * len));
    var s = CONFIG.seasons[idx], k = w.yearStrength, m = idx === 3 ? 1 / k : k;
    return { index: idx, name: s.name, year: year, strength: k, spawn: s.spawn * m,
             cap: Math.max(1, Math.round(s.cap * m)), endsAt: (Math.floor(t / len) + 1) * len, temp: CONFIG.seasonTemp[idx] };
  }

  var SC = { w: null, key: -1, ys: 0, v: null };
  function seasonCached(w) {   // seasonInfo only changes at season boundaries / new years: reuse it (read-only)
    var key = Math.floor(w.tick / CONFIG.seasonTicks);
    if (SC.w !== w || SC.key !== key || SC.ys !== w.yearStrength) { SC.w = w; SC.key = key; SC.ys = w.yearStrength; SC.v = seasonInfo(w); }
    return SC.v;
  }

  // ---------------- genomes ----------------
  // new random brains start with weak links from the cave senses (newest inputs), so evolution decides whether caves matter
  var WEAK_IN = {}; ['caveSide', 'caveAhead', 'caveNear', 'inCave', 'caveCrowd'].forEach(function (k) { if (INPUTS.indexOf(k) >= 0) WEAK_IN[INPUTS.indexOf(k)] = 1; });
  function randomBrain(w) { var g = []; for (var i = 0; i < NW; i++) { var v = (rand(w) - 0.5) * 1000; if (i < NI * NH && WEAK_IN[i % NI]) v *= 0.1; g.push(Math.round(v)); } return g; }
  function fitBrain(w, g) {   // pads (small random weights) or trims a genome of another size, e.g. from an older layout
    if (g.length === NW) return g;
    var c = g.slice(0, NW); while (c.length < NW) c.push(Math.round((rand(w) - 0.5) * 200)); return c;
  }
  function mutateBrain(w, g, strong) {
    var c = fitBrain(w, g).slice(), big = strong || rand(w) < CONFIG.bigMutChance, lim = CONFIG.wMax * 1000;
    for (var i = 0; i < c.length; i++) {
      if (big) c[i] = clamp(Math.round(c[i] + gauss(w) * CONFIG.bigMutSd * 500), -lim, lim);
      else if (rand(w) < CONFIG.mutRate) c[i] = clamp(Math.round(c[i] + gauss(w) * CONFIG.mutSd * 1000), -lim, lim);
    }
    return { brain: c, big: big };
  }
  function mutateTraits(w, t) {
    var c = {};
    for (var i = 0; i < TRAITS.length; i++) { var k = TRAITS[i], r = TRAIT_RULES[k]; c[k] = Math.round(clamp(t[k] + gauss(w) * r.sd, r.min, r.max) * 1000) / 1000; }
    return c;
  }
  var WCACHE = typeof WeakMap === 'function' ? new WeakMap() : null;
  function weights(g) {
    var f = WCACHE && WCACHE.get(g); if (f) return f;
    f = new Float64Array(g.length); for (var i = 0; i < g.length; i++) f[i] = g[i] / 1000;
    if (WCACHE) WCACHE.set(g, f); return f;
  }

  // Every bot object gets the same fields in the same order (fresh, born or loaded), so JS engines keep one fast shape.
  function canonBot(o) {
    var t = o.traits;
    return { id: o.id, name: o.name, gen: o.gen, parent: o.parent, lineage: o.lineage, hue: o.hue,
             traits: { speed: t.speed, vision: t.vision, size: t.size }, brain: o.brain,
             x: o.x, y: o.y, px: o.px === undefined ? o.x : o.px, py: o.py === undefined ? o.y : o.py, hx: o.hx, hy: o.hy, vx: o.vx, vy: o.vy,
             energy: o.energy, born: o.born, lastRepro: o.lastRepro, kids: o.kids, th: o.th, tu: o.tu, want: o.want, mem: o.mem, s1: o.s1, s2: o.s2,
             pick: o.pick, drop: o.drop, eatC: o.eatC, carry: o.carry, warm: o.warm, bx: o.bx, by: o.by, k0: o.k0 === undefined ? -1 : o.k0,
             D: o.D || zeros(ND), ph: o.ph || zeros(NH + 1), po: o.po || zeros(NO), rw: o.rw || 0, rb: o.rb || 0, lastMark: o.lastMark === undefined ? -1e9 : o.lastMark,
             eaten: o.eaten || 0, gained: o.gained || 0, spent: o.spent || 0, era: o.era || 0, hr: o.hr || [0, 0, 0, 0, 0], shared: o.shared || 0, cached: o.cached || 0,
             e1: o.e1 || 0, e2: o.e2 || 0, inh: o.inh || 0, apN: o.apN || 0, apS: o.apS || 0, y15: o.y15 || 0, imit: o.imit || 0,
             cv: o.cv === undefined ? -1 : o.cv, sh: o.sh || 0, wt: o.wt || 0, cwt: o.cwt || 0 };
  }
  function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a;
  }
  function makeBot(w, o) {
    var b = canonBot({ id: w.nextId++, name: o.name, gen: o.gen || 1, parent: o.parent || null, lineage: o.lineage || null,
              hue: o.hue, traits: o.traits, brain: o.brain, x: o.x, y: o.y, px: o.x, py: o.y, hx: 0, hy: 0, vx: 0, vy: 0,
              energy: 0, born: w.tick, lastRepro: w.tick, kids: 0, th: 0, tu: 0, want: 0, mem: 0, s1: 0, s2: 0,
              pick: 0, drop: 0, eatC: 0, carry: [], warm: 0, bx: o.x, by: o.y, D: o.D });
    if (!b.lineage) b.lineage = b.id;
    b.energy = o.energy === undefined ? maxEnergy(b) : o.energy;
    var d = randInt(w, 0, DIRS - 1); b.hx = DX[d]; b.hy = DY[d];
    w.bots.push(b); H.birth(w, b, o.why);
    return b;
  }
  function landSpot(w) {   // random position not in water
    var T = rt(w).terrain;
    for (var k = 0; k < 20; k++) { var x = 30 + rand(w) * (CONFIG.width - 60), y = 30 + rand(w) * (CONFIG.height - 60); if (!T.water[tileAt(T, x, y)]) return [x, y]; }
    return [x, y];
  }
  function freshPair(w, why) {
    var hof = w.hof || [];
    for (var i = 0; i < CONFIG.pairSize; i++) {
      var p = landSpot(w), src = hof.length && i >= CONFIG.resproutRandom ? hof[i % hof.length] : null, t = {}, k;
      if (src) {
        makeBot(w, { name: src.name.split(' ')[0] + ' ' + (w.stats.era), hue: src.hue, traits: mutateTraits(w, src.traits),
                     brain: mutateBrain(w, src.brain, CONFIG.resproutStrong).brain, x: p[0], y: p[1], why: why + ', descended from hall-of-fame #' + src.id });
      } else {
        var q = PAIR[i % PAIR.length];
        for (k in DEFAULT_TRAITS) t[k] = DEFAULT_TRAITS[k];
        makeBot(w, { name: q.name + (w.stats.era > 1 ? ' ' + w.stats.era : ''), hue: q.hue, traits: t, brain: randomBrain(w), x: p[0], y: p[1], why: why + ', random brain' });
      }
    }
  }
  function remember(w, b) {
    var score = (w.tick - b.born) + 72000 * b.kids, hof = w.hof;
    if (hof.length >= CONFIG.hallOfFame && score <= hof[hof.length - 1].score) return;
    hof.push({ id: b.id, name: b.name, gen: b.gen, hue: b.hue, score: score, kids: b.kids, lived: w.tick - b.born, traits: b.traits, brain: b.brain });
    hof.sort(function (a, c) { return c.score - a.score || a.id - c.id; });
    if (hof.length > CONFIG.hallOfFame) hof.length = CONFIG.hallOfFame;
  }

  function spawnGrass(w) {   // weighted by fertility
    var T = rt(w).terrain, target = rand(w) * T.total, lo = 0, hi = T.cum.length - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (T.cum[mid] < target) lo = mid + 1; else hi = mid; }
    var tx = lo % T.TW, ty = Math.floor(lo / T.TW), r = CONFIG.grassRadius;
    var x = clamp((tx + rand(w)) * CONFIG.tile, r, CONFIG.width - r), y = clamp((ty + rand(w)) * CONFIG.tile, r, CONFIG.height - r);
    if (caveAt(cavesOf(T), x, y) >= 0) return;   // nothing grows inside a cave
    addFood(w, { id: w.nextId++, x: x, y: y, born: w.tick });
    H.grassSpawn(w);
  }

  function createWorld(seed, startTime) {
    var w = { version: VERSION, seed: seed >>> 0, rng: seed >>> 0, terrainSeed: (seed ^ 0x9E3779B9) >>> 0, startTime: startTime, clocks: [{ t0: startTime, tick0: 0, rate: CONFIG.clockRate }], jumpTicks: 0, tick: 0, nextId: 1,
              bots: [], grass: [], landmarks: [], natural: 0, dropped: 0, mossN: 0, hof: [], resproutAt: null, yearStrength: 1, year: 0, stats: Stats.create(), config: CONFIG };
    Stats.event(w, 'world', 'World created');
    for (var i = 0; i < CONFIG.startGrass; i++) spawnGrass(w);
    freshPair(w, 'first pair');
    return w;
  }

  // ---------------- brain: sense -> think ----------------
  var NZ = new Int32Array(NI), PERC = { E: 0, grassAhead: null, other: null, temp: 0, bank: 0, tile: 0, warm: 0, par: null, parD: 0, young: false, age: 0, adults: 0, adultsNear: 0, ownD: null };
  var IN = new Float64Array(NI), HID = new Float64Array(NH + 1), OUT = new Float64Array(NO);
  function think(w, b, info, T) {
    var Tr = b.traits, V = Tr.vision, vis2 = V * V, hx = b.hx, hy = b.hy, bx = b.x, by = b.y, i, j;
    var G = w.grass, g = null, gd = vis2;
    for (i = 0; i < G.length; i++) { var q = G[i], dx = q.x - bx; if (dx > V || dx < -V) continue;
      var dy = q.y - by, d = dx * dx + dy * dy; if (d <= gd) { gd = d; g = q; } }
    var BS = w.bots, o = null, od = vis2, crowd = 0, warmN = 0, sb = null, sbest = 0, SR = CONFIG.signalRange, R = radius(b), par = null;
    var age = w.tick - b.born, young = age < CONFIG.apprenticeTicks, IR2 = CONFIG.imitateRadius * CONFIG.imitateRadius, adultsNear = 0, adults = 0;
    for (i = 0; i < BS.length; i++) {
      var p = BS[i]; if (p === b) continue;
      if (p.id === b.parent) par = p;
      if (young && p.id !== b.parent && w.tick - p.born >= CONFIG.apprenticeTicks) { adults++; var ax = p.x - bx, ay = p.y - by; if (ax * ax + ay * ay < IR2) adultsNear++; }
      var ex = p.x - bx; if (ex > SR + V || ex < -SR - V) continue;
      var ey = p.y - by, e = ex * ex + ey * ey;
      if (e <= vis2) { crowd++; if (e < od) { od = e; o = p; } }
      var wr = CONFIG.warmRadius + R + p.traits.size; if (e < wr * wr) warmN++;
      if (e < SR * SR) { var sa = Math.abs(p.s1) + Math.abs(p.s2); if (sa > sbest) { var strength = sa * (1 - Math.sqrt(e) / SR); if (strength > sbest) { sbest = strength; sb = p; } } }
    }
    b.warm = Math.min(1, warmN * CONFIG.warmPerBot);
    var mx = maxEnergy(b), E = b.energy / mx, k0 = tileAt(T, bx, by), ahead = tileAt(T, bx + hx * 40, by + hy * 40);
    FIN[0] = E;
    if (g) { var gl = Math.sqrt(gd) || 1, gx = (g.x - bx) / gl, gy = (g.y - by) / gl; FIN[1] = 1 - gl / V; FIN[2] = hx * gy - hy * gx; FIN[3] = hx * gx + hy * gy; }
    else { FIN[1] = 0; FIN[2] = 0; FIN[3] = 0; }
    if (o) { var ol = Math.sqrt(od) || 1, ux = (o.x - bx) / ol, uy = (o.y - by) / ol;
      FIN[4] = 1 - ol / V; FIN[5] = hx * uy - hy * ux; FIN[6] = hx * ux + hy * uy; FIN[7] = o.energy / maxEnergy(o); FIN[8] = o.lineage === b.lineage ? 1 : 0; }
    else { FIN[4] = 0; FIN[5] = 0; FIN[6] = 0; FIN[7] = 0; FIN[8] = 0; }
    FIN[9] = crowd / 5;
    var ph = Math.floor((w.tick % (4 * CONFIG.seasonTicks)) * DIRS / (4 * CONFIG.seasonTicks));
    FIN[10] = DY[ph]; FIN[11] = DX[ph];
    FIN[12] = w.natural / info.cap;
    FIN[13] = Math.min(1, (w.tick - b.born) / 72000);
    FIN[14] = b.mem;
    var temp = b.sh ? 1 : temperature(w, T, b); FIN[15] = Math.min(1, temp + (1 - temp) * b.warm);
    FIN[16] = T.water[k0]; FIN[17] = T.elev[k0]; FIN[18] = T.fert[ahead]; FIN[19] = (T.elev[ahead] - T.elev[k0]) * 4;
    FIN[20] = b.carry.length / CONFIG.maxCarry;
    if (sb) { var sl = Math.sqrt((sb.x - bx) * (sb.x - bx) + (sb.y - by) * (sb.y - by)) || 1, sx = (sb.x - bx) / sl, sy = (sb.y - by) / sl;
      FIN[21] = hx * sy - hy * sx; FIN[22] = hx * sx + hy * sy; FIN[23] = sb.s1; FIN[24] = sb.s2; }
    else { FIN[21] = 0; FIN[22] = 0; FIN[23] = 0; FIN[24] = 0; }
    FIN[25] = Math.sqrt(b.vx * b.vx + b.vy * b.vy) / Tr.speed;
    // family landmarks: nearest own-lineage marker (direction + closeness) and closeness of the nearest foreign one
    var LM = w.landmarks, own = null, ownD = Infinity, forD = Infinity, LR = CONFIG.landmarkRange;
    for (i = 0; i < LM.length; i++) { var L = LM[i], lx = L.x - bx, ly = L.y - by, ld = lx * lx + ly * ly;
      if (L.lin === b.lineage) { if (ld < ownD) { ownD = ld; own = L; } } else if (ld < forD) forD = ld; }
    if (own) ownD = Math.sqrt(ownD);
    if (CONFIG.landmarkSense && own && ownD < LR) { var ol2 = ownD || 1, mx2 = (own.x - bx) / ol2, my2 = (own.y - by) / ol2;
      FIN[26] = hx * my2 - hy * mx2; FIN[27] = hx * mx2 + hy * my2; FIN[28] = 1 - ownD / LR; }
    else { FIN[26] = 0; FIN[27] = 0; FIN[28] = 0; }
    FIN[29] = CONFIG.landmarkSense && forD < LR * LR ? 1 - Math.sqrt(forD) / LR : 0;
    // parent (only while it is alive and within range)
    var parD = Infinity;
    if (par) { var pxd = par.x - bx, pyd = par.y - by; parD = Math.sqrt(pxd * pxd + pyd * pyd); }
    if (CONFIG.apprentice && par && parD < CONFIG.parentRange) { var pl = parD || 1, qx = (par.x - bx) / pl, qy = (par.y - by) / pl;
      FIN[30] = hx * qy - hy * qx; FIN[31] = hx * qx + hy * qy; FIN[32] = 1 - parD / CONFIG.parentRange; FIN[33] = 1; }
    else { FIN[30] = 0; FIN[31] = 0; FIN[32] = 0; FIN[33] = 0; }
    // caves: nearest one (direction, closeness), inside flag, crowding of the nearest cave
    var CV = cavesOf(T), cb = -1, cd = Infinity, CR = CONFIG.caveRange;
    for (i = 0; i < CV.length; i++) { var cxd = CV[i].x - bx, cyd = CV[i].y - by, c2 = cxd * cxd + cyd * cyd; if (c2 < cd) { cd = c2; cb = i; } }
    if (CONFIG.caveSense && cb >= 0 && cd < CR * CR) { cd = Math.sqrt(cd); var cl = cd || 1, kx = (CV[cb].x - bx) / cl, ky = (CV[cb].y - by) / cl;
      FIN[34] = cd < 1 ? 0 : hx * ky - hy * kx; FIN[35] = cd < 1 ? 0 : hx * kx + hy * ky; FIN[36] = 1 - cd / CR; FIN[38] = rt(w).occ[cb] / CONFIG.caveCapacity; }
    else { FIN[34] = 0; FIN[35] = 0; FIN[36] = 0; FIN[38] = 0; }
    FIN[37] = b.cv >= 0 ? 1 : 0;
    FIN[39] = 1;
    for (i = 0; i < NI; i++) IN[i] = FIN[MAP[i]];   // the brain sees only the active inputs
    var W = weights(b.brain), k = 0, s;
    var nz = 0; for (i = 0; i < NI; i++) if (IN[i] !== 0) NZ[nz++] = i;   // skip zero inputs (adding 0 changes nothing)
    for (j = 0; j < NH; j++) { s = 0; var base = j * NI; for (i = 0; i < nz; i++) s += IN[NZ[i]] * W[base + NZ[i]]; HID[j] = tanh(s); }
    k = NH * NI;
    HID[NH] = 1;
    var D = b.D, DU = 1 / CONFIG.deltaUnit, dk = 0;   // output layer = genes + learned deltas
    for (j = 0; j < NO; j++) { s = 0; for (i = 0; i <= NH; i++) s += HID[i] * (W[k++] + D[dk++] * DU); OUT[j] = tanh(s); }
    if (CONFIG.learning) learnStep(w, b, par, parD, young);
    b.tu = OUT[0]; b.th = OUT[1] > 0 ? OUT[1] : OUT[1] * 0.3; b.want = OUT[2]; b.mem = OUT[3]; b.s1 = OUT[4]; b.s2 = OUT[5];
    b.pick = OUT[6]; b.drop = OUT[7]; b.eatC = OUT[8];
    landmarkStep(w, b, own, ownD, T);
    PERC.E = E; PERC.grassAhead = g ? FIN[3] : null; PERC.other = o; PERC.temp = temp; PERC.bank = T.bank[k0]; PERC.tile = k0; PERC.warm = FIN[15];
    PERC.par = par; PERC.parD = parD; PERC.young = young; PERC.age = age; PERC.adults = adults; PERC.adultsNear = adultsNear; PERC.ownD = own ? ownD : null;
    H.perceive(w, b, PERC);
  }

  // ---- lifetime learning: reward-modulated Hebbian update of the plastic layer ----
  // reward = energy gained from food since the last think minus cold/climbing losses (in grass units), relative to the
  // bot's own running average; the update strengthens/weakens the hidden->output links that were active before the reward.
  function learnStep(w, b, par, parD, young) {
    var D = b.D, U = CONFIG.deltaUnit, i, j, k, v;
    if (CONFIG.learning) {
      var r = b.rw / CONFIG.grassEnergy, adv = r - b.rb, lr = b.traits.learn;
      b.rb += 0.05 * (r - b.rb); b.rw = 0;
      if (lr > 0 && adv !== 0) {
        var g = lr * adv * U;
        for (j = 0, k = 0; j < NO; j++) { var pj = b.po[j] * g; if (pj === 0) { k += NH + 1; continue; }
          for (i = 0; i <= NH; i++, k++) { v = D[k] + Math.round(pj * b.ph[i]); D[k] = v > U ? U : v < -U ? -U : v; } }
      }
      // apprenticeship: while young and close to a living parent, nudge own actions toward the parent's last actions
      if (CONFIG.apprentice && young && par && parD < CONFIG.imitateRadius) {
        var amt = 0;
        for (var q = 0; q < IMITATE.length; q++) { j = IMITATE[q]; var err = par.po[j] - OUT[j]; amt += Math.abs(err);
          var gj = CONFIG.imitateRate * err * U;
          for (i = 0, k = j * (NH + 1); i <= NH; i++, k++) { v = D[k] + Math.round(gj * HID[i]); D[k] = v > U ? U : v < -U ? -U : v; } }
        H.imitate(w, b, amt);
      }
    }
    for (i = 0; i <= NH; i++) b.ph[i] = Math.round(HID[i] * 100) / 100;   // remembered (rounded) for the next update
    for (j = 0; j < NO; j++) b.po[j] = Math.round(OUT[j] * 100) / 100;
  }
  var IMITATE = [0, 1, 6, 7, 8];   // turn, thrust, pick up, drop, eat carried

  // ---- family landmarks: a lineage marks places (max 3, oldest replaced); visits refresh, neglect makes them fade ----
  function landmarkStep(w, b, own, ownD, T) {
    if (own && ownD < CONFIG.landmarkRefresh + radius(b)) { if (w.tick - own.seen > 600) H.landmarkVisit(w, b, own); own.seen = w.tick; }
    if (OUT[9] <= 0.8 || w.tick - b.lastMark < CONFIG.landmarkCooldown || (own && ownD < CONFIG.landmarkMinGap)) return;
    var LM = w.landmarks, mine = [], i;
    for (i = 0; i < LM.length; i++) if (LM[i].lin === b.lineage) mine.push(LM[i]);
    if (mine.length >= CONFIG.landmarkMax) { var old = mine[0]; for (i = 1; i < mine.length; i++) if (mine[i].placed < old.placed) old = mine[i]; LM.splice(LM.indexOf(old), 1); }
    var L = { lin: b.lineage, hue: b.hue, by: b.id, x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, placed: w.tick, seen: w.tick };
    LM.push(L); b.lastMark = w.tick; b.energy -= CONFIG.landmarkCost;   // marking costs a little energy
    H.landmark(w, b, L, T.fert[tileAt(T, L.x, L.y)], T.bank[tileAt(T, L.x, L.y)], caveNear(cavesOf(T), L.x, L.y));
  }

  function caveNear(C, x, y) { var R = CONFIG.caveRadius + 40; for (var i = 0; i < C.length; i++) { var dx = C[i].x - x, dy = C[i].y - y; if (dx * dx + dy * dy < R * R) return 1; } return 0; }
  function eatItem(w, b, item, how) {
    var before = b.energy, mx = maxEnergy(b), en = item.moss ? CONFIG.mossEnergy : CONFIG.grassEnergy;
    b.energy = Math.min(mx, b.energy + en);
    b.rw += b.energy - before;
    H.eat(w, b, b.energy - before, en - (b.energy - before), item, how);
  }

  // ---------------- rules ----------------
  var RULES = [
    function seasons(w) {
      var y = Math.floor(w.tick / (4 * CONFIG.seasonTicks));
      if (y !== w.year) { w.year = y; w.yearStrength = CONFIG.strengthMin + rand(w) * (CONFIG.strengthMax - CONFIG.strengthMin); }
      if (w.tick % CONFIG.seasonTicks === 0) H.season(w, seasonInfo(w));
    },
    function growGrass(w) {
      if (w.tick % 600 === 0 && w.landmarks.length) {   // neglected landmarks fade
        for (var m = w.landmarks.length - 1; m >= 0; m--) if (w.tick - w.landmarks[m].seen > CONFIG.landmarkDecay) { H.landmarkGone(w, w.landmarks[m]); w.landmarks.splice(m, 1); }
      }
      var s = seasonCached(w);
      if (rand(w) < s.spawn && w.natural < s.cap) spawnGrass(w);
      var mr = CONFIG.mossRate[s.index];
      if (CONFIG.moss && mr > 0) {   // moss regrows slowly inside caves (only on the ground, capped per cave)
        var CV = cavesOf(rt(w).terrain);
        for (var c = 0; c < CV.length; c++) {
          if (rand(w) >= mr) continue;
          var have = 0; for (var q = 0; q < w.grass.length; q++) if (w.grass[q].moss && !w.grass[q].drop && w.grass[q].mc === c) have++;
          if (have >= CONFIG.mossCap) continue;
          var a = randInt(w, 0, DIRS - 1), rr = rand(w) * (CONFIG.caveRadius - 10);
          addFood(w, { id: w.nextId++, x: CV[c].x + DX[a] * rr, y: CV[c].y + DY[a] * rr, born: w.tick, moss: 1, mc: c });
          H.mossGrow(w);
        }
      }
      if (w.tick % 600 === 0 && w.dropped > 0) {          // dropped food slowly rots
        for (var i = w.grass.length - 1; i >= 0; i--) { var f = w.grass[i]; if (f.drop && w.tick >= f.rotAt) { removeFood(w, f); H.rot(w, f); } }
      }
    },
    function resprout(w) {
      if (w.bots.length > 0 || w.resproutAt === null || w.tick < w.resproutAt) return;
      w.resproutAt = null; H.newEra(w); freshPair(w, 'new life after extinction');
    },
    function caves(w) {   // who is inside which cave; only the first `caveCapacity` occupants (oldest first) are sheltered
      var C = cavesOf(rt(w).terrain), occ = rt(w).occ, BS = w.bots, i;
      for (i = 0; i < occ.length; i++) occ[i] = 0;
      for (i = 0; i < BS.length; i++) { var b = BS[i], c = C.length ? caveAt(C, b.x, b.y) : -1; b.cv = c; b.sh = 0;
        if (c >= 0) { occ[c]++; if (CONFIG.caveBenefit && occ[c] <= CONFIG.caveCapacity) b.sh = 1; } }
    },
    function brains(w) {
      var n = CONFIG.thinkEvery, info = null, T = null;
      for (var i = 0; i < w.bots.length; i++) { var b = w.bots[i]; if ((w.tick + b.id) % n === 0) { if (!info) { info = seasonCached(w); T = rt(w).terrain; } think(w, b, info, T); } }
    },
    function physics(w) {
      var T = rt(w).terrain, W = CONFIG.width, Hh = CONFIG.height, BS = w.bots, i, j;
      var TP = CONFIG.turnPerTick, FR = CONFIG.friction, WFR = CONFIG.waterFriction, CS = CONFIG.carrySlow, WB = CONFIG.wallBounce, TL = CONFIG.tile, TW = T.TW, TH = T.TH, WAT = T.water;
      for (i = 0; i < BS.length; i++) {
        var b = BS[i], R = b.traits.size, sp = b.traits.speed, x = b.x, y = b.y, hx = b.hx, hy = b.hy;
        b.px = x; b.py = y;
        // turning force and thrust (inertia + friction)
        if (b.tu !== 0) { var t = b.tu * TP, nx = hx - hy * t, ny = hy + hx * t, nl = Math.sqrt(nx * nx + ny * ny); hx = nx / nl; hy = ny / nl; }
        var tx = Math.floor(x / TL), ty = Math.floor(y / TL); if (tx >= TW) tx = TW - 1; if (ty >= TH) ty = TH - 1; if (tx < 0) tx = 0; if (ty < 0) ty = 0;
        var k0 = ty * TW + tx, fr = WAT[k0] || b.cv >= 0 ? WFR : FR;   // water and narrow caves slow movement
        var acc = sp * (1 - FR) * b.th * (1 - CS * b.carry.length);
        var vx = (b.vx + hx * acc) * fr, vy = (b.vy + hy * acc) * fr;
        x += vx; y += vy;
        // walls: bounce the velocity and turn the body away (a bot pushing into a wall glances off it)
        if (x < R) { x = R; vx = -vx * WB; if (hx < 0) hx = -hx; }
        if (x > W - R) { x = W - R; vx = -vx * WB; if (hx > 0) hx = -hx; }
        if (y < R) { y = R; vy = -vy * WB; if (hy < 0) hy = -hy; }
        if (y > Hh - R) { y = Hh - R; vy = -vy * WB; if (hy > 0) hy = -hy; }
        b.x = x; b.y = y; b.vx = vx; b.vy = vy; b.hx = hx; b.hy = hy; b.k0 = k0;
      }
      // soft collisions between bots (spatial grid as linked lists in reusable typed arrays); every 2nd tick is enough
      var n = BS.length; if (n < 2 || (w.tick & 1)) return;
      if (NEXT.length < n) NEXT = new Int32Array(n * 2);
      HEAD.fill(-1);
      if (CI.length < n) CI = new Int32Array(n * 2);
      for (i = 0; i < n; i++) { var c = cellOf(BS[i].x, BS[i].y); CI[i] = c; NEXT[i] = HEAD[c]; HEAD[c] = i; }
      for (i = 0; i < n; i++) {
        var a = BS[i], cx = CI[i] % GW, cy = (CI[i] - cx) / GW, ra = a.traits.size;   // the cell it was filed under
        for (var q = 0; q < 5; q++) {   // own cell (pairs once) + 4 forward neighbours: every nearby pair is seen exactly once
          var gx = cx + FWD_X[q], gy = cy + FWD_Y[q]; if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) continue;
          for (j = HEAD[gy * GW + gx]; j !== -1; j = NEXT[j]) {
            if (q === 0 && j <= i) continue;
            var o = BS[j], dx = o.x - a.x, dy = o.y - a.y, d2 = dx * dx + dy * dy, rr = ra + o.traits.size;
            if (d2 >= rr * rr || d2 === 0) continue;
            var d = Math.sqrt(d2), ux = dx / d, uy = dy / d, push = (rr - d) * 0.5;
            a.x -= ux * push; a.y -= uy * push; o.x += ux * push; o.y += uy * push;
            var rv = (o.vx - a.vx) * ux + (o.vy - a.vy) * uy;
            if (rv < 0) { var imp = rv * 0.5; a.vx += ux * imp; a.vy += uy * imp; o.vx -= ux * imp; o.vy -= uy * imp; }
          }
        }
      }
    },
    function energyUse(w) {
      var T = rt(w).terrain, si = Math.floor(w.tick / CONFIG.seasonTicks) % 4, cold = (1 - CONFIG.seasonTemp[si]) * (si === 3 ? 1 / w.yearStrength : 1); // harsh years have colder winters
      for (var i = 0; i < w.bots.length; i++) {
        var b = w.bots[i], f = sizeF(b), f2 = f * f, k1 = tileAt(T, b.x, b.y);
        var cost = (CONFIG.drainBase * f2 + CONFIG.drainPerVision * b.traits.vision) * (b.sh ? CONFIG.caveRest : 1) + CONFIG.drainPerThrust * Math.abs(b.th) * b.traits.speed * f;
        var dh = T.elev[k1] - T.elev[b.k0 < 0 ? k1 : b.k0];
        var climb = dh > 0 ? CONFIG.climbCost * dh * f2 : CONFIG.climbCost * 0.5 * dh * f2;
        var c = cold + (T.water[k1] ? 0.15 : 0); if (c > 1.5) c = 1.5;
        var heat = b.sh ? 0 : CONFIG.coldCost * c * (1 - b.warm) * f2;
        cost = Math.max(0, cost + climb) + heat;
        var d = Math.min(cost, b.energy); b.energy -= cost; b.rw -= heat + (climb > 0 ? climb : 0); H.spend(w, b, d, heat, climb);
      }
    },
    function food(w) {   // touching food: pick it up (if the brain wants to and has room) or eat it (if not full)
      var FG = rt(w).food, BS = w.bots, gr = CONFIG.grassRadius;
      for (var i = 0; i < BS.length; i++) {
        if ((w.tick + BS[i].id) & 1) continue;   // each bot handles touch/eat/drop every 2nd tick (think ticks included: thinkEvery is even)
        var b = BS[i], reach = radius(b) + gr, r2 = reach * reach, mx = maxEnergy(b);
        var x0 = Math.max(0, Math.floor((b.x - reach) / CELL)), x1 = Math.min(GW - 1, Math.floor((b.x + reach) / CELL));
        var y0 = Math.max(0, Math.floor((b.y - reach) / CELL)), y1 = Math.min(GH - 1, Math.floor((b.y + reach) / CELL));
        for (var gy = y0; gy <= y1; gy++) for (var gx = x0; gx <= x1; gx++) {
          var cell = FG[gy * GW + gx];
          for (var j = cell.length - 1; j >= 0; j--) {
            var f = cell[j]; if (j >= cell.length) continue;
            var dx = f.x - b.x, dy = f.y - b.y; if (dx * dx + dy * dy >= r2) continue;
            if (f.drop && f.dropper === b.id && w.tick - f.dropTick < CONFIG.ownDropGrace) continue;
            if (b.pick > 0.5 && b.carry.length < CONFIG.maxCarry) {
              removeFood(w, f); b.carry.push({ id: f.id, born: f.born, picked: w.tick, dropper: f.dropper || null, dropLin: f.dropLin || null, dropTick: f.dropTick || null, corpse: f.corpse || 0, cave: f.cave || 0, moss: f.moss || 0 });
              H.pickup(w, b, f);
            } else if (b.energy < mx - 1) { removeFood(w, f); eatItem(w, b, f, f.drop ? 'ground-drop' : 'ground'); }
          }
        }
        // eat from what it carries
        if (b.eatC > 0 && b.carry.length && b.energy <= mx - CONFIG.grassEnergy * 0.5) { var it = b.carry.shift(); eatItem(w, b, it, 'carried'); }
        // drop something
        if (b.drop > 0.5 && b.carry.length && w.dropped < CONFIG.maxDropped && (w.tick + b.id) % CONFIG.thinkEvery === 0) {
          var c2 = b.carry.shift();
          var fx = clamp(b.x - b.hx * (radius(b) + gr + 2), gr, CONFIG.width - gr), fy = clamp(b.y - b.hy * (radius(b) + gr + 2), gr, CONFIG.height - gr);
          var inC = caveAt(cavesOf(rt(w).terrain), fx, fy);   // food left inside a cave keeps much longer
          var dropped = { id: c2.id, x: fx, y: fy, born: c2.born, drop: 1, dropper: b.id, dropLin: b.lineage, dropTick: w.tick,
                          rotAt: w.tick + CONFIG.dropDecayTicks * (inC >= 0 ? CONFIG.caveDecayMul : 1), picked: c2.picked, cave: inC >= 0 ? inC + 1 : 0, moss: c2.moss || 0 };
          addFood(w, dropped); H.dropped(w, b, dropped);
        }
      }
    },
    function reproduce(w) {
      var n = w.bots.length;
      for (var i = 0; i < n && w.bots.length < CONFIG.maxPop; i++) {
        var b = w.bots[i], mx = maxEnergy(b);
        if ((w.tick + b.id) % CONFIG.thinkEvery !== 0) continue;
        if (b.energy < CONFIG.reproEnergy * mx || w.tick - b.born < CONFIG.reproMinAge || w.tick - b.lastRepro < CONFIG.reproCooldown) continue;
        H.eligible(w, b);
        if (b.want <= 0) continue;
        b.energy -= CONFIG.reproCost * mx; b.lastRepro = w.tick; b.kids++;
        var m = mutateBrain(w, b.brain, false), t = mutateTraits(w, b.traits);
        var hue = Math.round((b.hue + gauss(w) * 6 + 360) % 360);
        var a = randInt(w, 0, DIRS - 1), off = radius(b) + t.size + 4;
        var inh = zeros(ND);
        var child = makeBot(w, { name: b.name, gen: b.gen + 1, parent: b.id, lineage: b.lineage, hue: hue, traits: t, brain: m.brain, D: inh,
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
          for (var c = 0; c < b.carry.length; c++) {        // carried food falls to the ground
            var it = b.carry[c], gr = CONFIG.grassRadius;
            if (w.dropped < CONFIG.maxDropped) addFood(w, { id: it.id, x: clamp(b.x, gr, CONFIG.width - gr), y: clamp(b.y, gr, CONFIG.height - gr), born: it.born, drop: 1, dropper: b.id, dropLin: b.lineage, dropTick: w.tick, rotAt: w.tick + CONFIG.dropDecayTicks, picked: it.picked, corpse: 1, moss: it.moss || 0 });
          }
          remember(w, b);
          H.death(w, b, 'starvation', formatDuration);
          if (w.bots.length === 0) { H.extinction(w, formatDuration); w.resproutAt = w.tick + CONFIG.resproutDelayTicks; }
        }
      }
    }
  ];

  function step(w) { w.tick++; for (var i = 0; i < RULES.length; i++) RULES[i](w); H.tick(w, rt(w).terrain); }
  // ---- world clock: real time -> tick. Rate changes are recorded as segments {t0 (real ms), tick0, rate};
  // before the first segment the world ran at 1x from startTime. Only + - * / floor, so every engine agrees.
  function clockSeg(w, timeMs) {
    var c = w.clocks, seg = null;
    if (c) for (var i = c.length - 1; i >= 0; i--) if (timeMs >= c[i].t0) { seg = c[i]; break; }
    return seg || { t0: w.startTime, tick0: 0, rate: 1 };
  }
  // world tick = base tick (from real time and the clock segments) + jumpTicks (owner fast-forwards, cumulative)
  function tickAtF(w, timeMs) { var s = clockSeg(w, timeMs); return s.tick0 + (timeMs - s.t0) * s.rate / CONFIG.tickMs + (w.jumpTicks || 0); }
  function tickAt(w, timeMs) { return Math.floor(tickAtF(w, timeMs)); }
  function timeOfTick(w, tick) {   // real ms at which the shared world reaches this tick
    var c = w.clocks, seg = null; tick -= w.jumpTicks || 0;
    if (c) for (var i = c.length - 1; i >= 0; i--) if (tick >= c[i].tick0) { seg = c[i]; break; }
    seg = seg || { t0: w.startTime, tick0: 0, rate: 1 };
    return seg.t0 + (tick - seg.tick0) * CONFIG.tickMs / seg.rate;
  }
  function clockRate(w) { return w.clocks && w.clocks.length ? w.clocks[w.clocks.length - 1].rate : 1; }
  function setClockRate(w, rate) {   // from the world's current tick on, run at `rate`; earlier ticks keep their old timing
    var t0 = timeOfTick(w, w.tick);
    if (!w.clocks) w.clocks = [];
    w.clocks.push({ t0: t0, tick0: w.tick - (w.jumpTicks || 0), rate: rate });
    Stats.event(w, 'world', 'World clock now runs at ' + rate + 'x real time');
  }
  function addJump(w, ticks) {   // permanently move the shared world ahead (the caller then advances it)
    w.jumpTicks = (w.jumpTicks || 0) + ticks;
    Stats.event(w, 'world', 'The owner fast-forwarded the world by ' + formatDuration(ticks * CONFIG.tickMs));
  }
  function advanceToTick(w, tick, maxSteps) {
    var n = 0;
    while (w.tick < tick && (maxSteps === undefined || n < maxSteps)) { step(w); n++; }
    return tick - w.tick;
  }
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
  var ALPHA = ''; for (var ch = 35; ch < 127; ch++) if (ch !== 92) ALPHA += String.fromCharCode(ch);
  function encodeBrain(g) { var out = ''; for (var i = 0; i < g.length; i++) { var v = g[i] + 4000; out += ALPHA[Math.floor(v / 91)] + ALPHA[v % 91]; } return out; }
  function decodeBrain(str) { var g = []; for (var i = 0; i < str.length; i += 2) g.push(ALPHA.indexOf(str[i]) * 91 + ALPHA.indexOf(str[i + 1]) - 4000); return g; }
  function serialize(w) {
    var copy = JSON.parse(JSON.stringify(w)); delete copy.config; Stats.compact(copy);
    copy.bots.forEach(function (b) { b.brain = encodeBrain(b.brain); delete b.D; delete b.ph; delete b.po; delete b.px; delete b.py; delete b.k0; });
    copy.hof.forEach(function (h) { h.brain = encodeBrain(h.brain); });
    copy.savedAt = new Date(timeOfTick(w, w.tick)).toISOString();
    return JSON.stringify(copy);
  }
  function deserialize(text) {
    var w = typeof text === 'string' ? JSON.parse(text) : text; w.config = CONFIG;
    if (w.version !== VERSION) return w;
    w.bots = w.bots.map(function (b) { if (typeof b.brain === 'string') b.brain = decodeBrain(b.brain); if (typeof b.D === 'string') b.D = decodeBrain(b.D); return canonBot(b); });
    w.hof.forEach(function (h) { if (typeof h.brain === 'string') h.brain = decodeBrain(h.brain); });
    return w;
  }
  function terrain(w) { return rt(w).terrain; }

  var api = { VERSION: VERSION, CONFIG: CONFIG, RULES: RULES, TRAITS: TRAITS, TRAIT_RULES: TRAIT_RULES, DEFAULT_TRAITS: DEFAULT_TRAITS,
              INPUTS: INPUTS, OUTPUTS: OUTPUTS, NH: NH, NW: NW, ND: ND, createWorld: createWorld, step: step, advanceTo: advanceTo, advanceToTick: advanceToTick, tickAt: tickAt, tickAtF: tickAtF, timeOfTick: timeOfTick, clockRate: clockRate, setClockRate: setClockRate, addJump: addJump,
              serialize: serialize, deserialize: deserialize, Stats: Stats, seasonInfo: seasonInfo, maxEnergy: maxEnergy, radius: radius,
              terrain: terrain, tileAt: tileAt, cavesOf: cavesOf, caveOcc: function (w) { return rt(w).occ; }, temperature: temperature, tanh: tanh, formatDuration: formatDuration, DX: DX, DY: DY, DIRS: DIRS };
  Stats.bind(api);
  return api;
});
