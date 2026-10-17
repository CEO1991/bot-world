/* Bot World statistics. Pure bookkeeping: never touches the PRNG or world physics,
 * so adding metrics can't change what happens in the world.
 * Behaviour is measured from OUTCOMES (what bots actually do), not from code labels:
 *   chase  - when hungry and grass is visible: mean cos(angle between heading and grass)   (random = 0, perfect = 1)
 *   follow - mean cos(angle between own heading and nearest visible bot's heading)         (random = 0)
 *   herd   - random-baseline nearest-neighbour distance / actual one                      (random ~ 1, >1 = clustered)
 *   sprint - mean speed when food is visible minus mean speed when it isn't                (0 = no strategy)
 *   call   - |mean signal when food visible - mean signal otherwise|                        (0 = signal carries no food info)
 *   breed  - breeding rate of eligible bots in spring+summer / in autumn+winter             (1 = no seasonal timing) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LIMITS = { events: 80, lifespans: 30, seriesPoints: 240, sampleTicks: 600, seasonLog: 16, days: 30,
                 genMilestone: 10, patternGap: 216000, ema: 0.05, minSamples: 300, sustain: 30 }; // pattern must hold 30 sampled minutes
  var SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
  var TRAITS = ['speed', 'vision', 'size'];
  var METRICS = ['chase', 'follow', 'herd', 'sprint', 'call'];
  var PATTERNS = {   // threshold on the smoothed metric; text for the event
    chase:  { th: 0.5,  text: 'learned to chase food' },
    follow: { th: 0.35, text: 'started following each other' },
    herd:   { th: 1.6,  text: 'Herding emerged: bots cluster together' },
    sprint: { th: 0.25, text: 'learned to sprint for food and coast otherwise' },
    call:   { th: 0.5,  text: 'developed a food call (signal changes when food is seen)' },
    breed:  { th: 2.5,  text: 'Seasonal breeding emerged: bots breed in spring/summer, hold back in autumn/winter' }
  };
  var Sim = null;
  function bind(api) { Sim = api; }
  function zero(keys) { var o = {}; keys.forEach(function (m) { o[m] = 0; }); return o; }
  function r1(x) { return Math.round(x * 10) / 10; }
  function r3(x) { return x === null ? null : Math.round(x * 1000) / 1000; }
  function newAcc() { return { cs: 0, cn: 0, fs: 0, fn: 0, sf: 0, nf: 0, so: 0, no: 0, gf: 0, go: 0 }; }

  function create() {
    var series = { interval: LIMITS.sampleTicks, t: [], alive: [], grass: [], energy: [], season: [], food: [], div: [] };
    TRAITS.concat(METRICS).forEach(function (k) { series[k] = []; });
    var bySeason = {}, breed = {};
    SEASONS.forEach(function (n) { bySeason[n] = { births: 0, deaths: 0, eaten: 0, ticks: 0 }; breed[n] = { elig: 0, bred: 0 }; });
    return {
      botsBorn: 0, births: { first: 0, resprout: 0, reproduction: 0 },
      deaths: { total: 0, byCause: { starvation: 0 } },
      extinctions: 0, era: 1, maxGen: 1, grassSpawned: 0, grassEaten: 0,
      energy: { gained: 0, wasted: 0, spent: 0 },
      lifespan: { count: 0, totalTicks: 0, maxTicks: 0, maxName: null }, peakAlive: 0,
      bySeason: bySeason, breed: breed,
      season: { name: 'Spring', year: 0, births: 0, deaths: 0, eaten: 0, popStart: 2, popMin: 2, popMax: 2 }, seasonLog: [],
      lineages: {}, oldestLineage: null,
      win: newAcc(), winEaten: 0, winBotTicks: 0,        // current 1-minute window
      ema: { chase: null, follow: null, herd: null, sprint: null, call: null, breed: null }, emaN: 0,
      patterns: {},                                        // pattern -> { first, count, active, last, lineage }
      daily: [],                                           // one entry per simulated day
      lifespans: [], series: series, events: []
    };
  }
  function S(w) { return w.stats || (w.stats = create()); }
  function event(w, type, text, extra) {
    var e = { tick: w.tick, type: type, text: text };
    if (extra) for (var k in extra) e[k] = extra[k];
    var ev = S(w).events; ev.push(e); if (ev.length > LIMITS.events) ev.shift();
  }
  function label(b) { return b.name + ' g' + b.gen + ' #' + b.id; }
  function seasonName(w) { return SEASONS[Math.floor(w.tick / w.config.seasonTicks) % 4]; }
  function accAdd(a, E, grassAhead, follow, spd, sig) {
    if (grassAhead !== null) { a.sf += spd; a.nf++; a.gf += sig; if (E < 0.75) { a.cs += grassAhead; a.cn++; } }
    else { a.so += spd; a.no++; a.go += sig; }
    if (follow !== null) { a.fs += follow; a.fn++; }
  }
  function accValues(a) {
    return { chase: a.cn >= 20 ? a.cs / a.cn : null, follow: a.fn >= 20 ? a.fs / a.fn : null,
             sprint: a.nf >= 20 && a.no >= 20 ? a.sf / a.nf - a.so / a.no : null,
             call: a.nf >= 20 && a.no >= 20 ? Math.abs(a.gf / a.nf - a.go / a.no) : null };
  }
  function decay(a, k) { for (var key in a) a[key] *= k; }
  function breedRatio(s) {
    var B = s.breed, good = (B.Spring.bred + B.Summer.bred) / Math.max(1, B.Spring.elig + B.Summer.elig),
        bad = (B.Autumn.bred + B.Winter.bred) / Math.max(1, B.Autumn.elig + B.Winter.elig);
    if (B.Spring.elig + B.Summer.elig < 50 || B.Autumn.elig + B.Winter.elig < 50) return null;
    return Math.min(20, good / Math.max(bad, 0.01));
  }
  function detect(w, key, value, who) {   // hysteresis + rate limit so the log stays readable
    var s = S(w), P = PATTERNS[key], st = s.patterns[key] || (s.patterns[key] = { first: null, count: 0, active: false, last: null, lineage: null });
    if (value === null) return;
    st.above = value >= P.th ? (st.above || 0) + 1 : 0;
    if (!st.active && st.above >= LIMITS.sustain) {
      st.active = true; st.count++;
      if (st.first === null) st.first = w.tick;
      if (st.last === null || w.tick - st.last >= LIMITS.patternGap) {
        st.last = w.tick; st.lineage = who || null;
        event(w, 'pattern', (key === 'herd' || key === 'breed') ? P.text + (who ? ' (mostly the ' + who + ' line)' : '') : (who ? 'The ' + who + ' line ' : 'Bots ') + P.text);
      }
    } else if (st.active && value < P.th * 0.7) st.active = false;
  }

  var hooks = {
    birth: function (w, b, why) {
      var s = S(w), kind = b.parent ? 'reproduction' : (s.era > 1 ? 'resprout' : 'first');
      s.botsBorn++; s.births[kind]++; s.bySeason[seasonName(w)].births++; s.season.births++;
      if (kind === 'reproduction') s.breed[seasonName(w)].bred++;
      b.eaten = 0; b.gained = 0; b.spent = 0; b.era = s.era;
      if (w.bots.length > s.peakAlive) s.peakAlive = w.bots.length;
      if (w.bots.length > s.season.popMax) s.season.popMax = w.bots.length;
      var L = s.lineages[b.lineage];
      if (!L) L = s.lineages[b.lineage] = { root: b.lineage, name: b.name, era: s.era, born: w.tick, members: 0, alive: 0, maxGen: 1, births: 0, acc: newAcc(), m: {} };
      L.members++; L.alive++; if (b.parent) L.births++; if (b.gen > L.maxGen) L.maxGen = b.gen;
      if (b.gen > s.maxGen) { s.maxGen = b.gen; if (b.gen % LIMITS.genMilestone === 0) event(w, 'birth', 'Generation ' + b.gen + ' reached (' + label(b) + ')'); }
      if (kind !== 'reproduction') event(w, 'birth', label(b) + ' was born (' + why + ')', { bot: b.id });
    },
    grassSpawn: function (w) { S(w).grassSpawned++; },
    eat: function (w, b, gained, wasted) {
      var s = S(w); s.grassEaten++; s.winEaten++; s.energy.gained += gained; s.energy.wasted += wasted;
      s.bySeason[seasonName(w)].eaten++; s.season.eaten++; b.eaten++; b.gained += gained;
    },
    perceive: function (w, b, E, grassAhead, other, botAhead, spd) {
      var s = S(w), follow = other ? b.hx * other.hx + b.hy * other.hy : null;
      accAdd(s.win, E, grassAhead, follow, spd, b.sig);
      var L = s.lineages[b.lineage]; if (L) accAdd(L.acc, E, grassAhead, follow, spd, b.sig);
    },
    eligible: function (w) { S(w).breed[seasonName(w)].elig++; },
    spend: function (w, b, amount) { S(w).energy.spent += amount; b.spent += amount; },
    death: function (w, b, cause, fmt) {
      var s = S(w), age = w.tick - b.born;
      s.deaths.total++; s.deaths.byCause[cause] = (s.deaths.byCause[cause] || 0) + 1;
      s.bySeason[seasonName(w)].deaths++; s.season.deaths++;
      if (w.bots.length < s.season.popMin) s.season.popMin = w.bots.length;
      s.lifespan.count++; s.lifespan.totalTicks += age;
      if (age > s.lifespan.maxTicks) { s.lifespan.maxTicks = age; s.lifespan.maxName = label(b); }
      var T = {}; TRAITS.forEach(function (k) { T[k] = r3(b.traits[k]); });
      s.lifespans.push({ id: b.id, name: b.name, gen: b.gen, era: b.era, born: b.born, died: w.tick, cause: cause, kids: b.kids, eaten: b.eaten, traits: T });
      if (s.lifespans.length > LIMITS.lifespans) s.lifespans.shift();
      var L = s.lineages[b.lineage];
      if (L) {
        L.alive--;
        var lasted = w.tick - L.born;
        if (!s.oldestLineage || lasted > s.oldestLineage.lasted) s.oldestLineage = { root: L.root, name: L.name, era: L.era, lasted: lasted, members: L.members, maxGen: L.maxGen };
        if (L.alive <= 0) {
          delete s.lineages[b.lineage];
          if (w.bots.length > 0 && L.members >= 5) event(w, 'death', 'The ' + L.name + ' line died out after ' + fmt(lasted * w.config.tickMs) + ' (' + L.members + ' members, ' + L.maxGen + ' generations)');
        }
      }
      if (w.bots.length <= 1) event(w, 'death', label(b) + ' died of ' + cause + ' at age ' + fmt(age * w.config.tickMs) + ' (' + w.bots.length + ' left)', { bot: b.id, cause: cause, age: age });
    },
    extinction: function (w, fmt) {
      var s = S(w); s.extinctions++; var D = s.daily[s.daily.length - 1]; if (D) D.ext++;
      event(w, 'extinction', 'Extinction #' + s.extinctions + ' in ' + seasonName(w) + ': era ' + s.era + ' ended after ' + fmt((w.tick - (s.eraStart || 0)) * w.config.tickMs));
    },
    newEra: function (w) { var s = S(w); s.era++; s.eraStart = w.tick; event(w, 'resprout', 'New life sprouted: era ' + s.era + ' begins'); },
    season: function (w, info) {
      var s = S(w), c = s.season, n = w.bots.length;
      c.popEnd = n; s.seasonLog.push(c); if (s.seasonLog.length > LIMITS.seasonLog) s.seasonLog.shift();
      event(w, 'season', c.name + ' ended: +' + c.births + ' born, -' + c.deaths + ' died, population ' + c.popStart + ' -> ' + n + '. ' + info.name + ' begins' +
            (info.strength < 0.85 ? (info.index === 3 ? ' (mild)' : ' (lean)') : info.strength > 1.15 ? (info.index === 3 ? ' (harsh)' : ' (lush)') : ''));
      s.season = { name: info.name, year: info.year, births: 0, deaths: 0, eaten: 0, popStart: n, popMin: n, popMax: n };
      if (info.index === 0) for (var k in s.breed) { s.breed[k].elig *= 0.5; s.breed[k].bred *= 0.5; } // recent years count most
    },
    tick: function (w) {
      var s = S(w), n = w.bots.length;
      s.bySeason[seasonName(w)].ticks++; s.winBotTicks += n;
      if (w.tick % LIMITS.sampleTicks !== 0) return;
      // ---- one sample per simulated minute ----
      var v = accValues(s.win), herd = null, e = 0, sums = zero(TRAITS), div = null, i, j;
      var settled = w.bots.filter(function (q) { return w.tick - q.born >= 3000; }), ns = settled.length;
      if (ns >= 3) {
        var tot = 0;
        for (i = 0; i < ns; i++) { var a = settled[i], best = Infinity;
          for (j = 0; j < ns; j++) { if (i === j) continue; var dx = settled[j].x - a.x, dy = settled[j].y - a.y, d = dx * dx + dy * dy; if (d < best) best = d; }
          tot += Math.sqrt(best); }
        var Ar = w.config.width * w.config.height, Pr = 2 * (w.config.width + w.config.height);
        herd = (0.5 * Math.sqrt(Ar / ns) + (0.0514 + 0.041 / Math.sqrt(ns)) * Pr / ns) / (tot / ns); // Donnelly's edge-corrected random expectation
      }
      if (n >= 2) { var dsum = 0; for (i = 0; i < n; i++) { var A = w.bots[i].brain, B = w.bots[(i + 1) % n].brain, dd = 0;
          for (j = 0; j < A.length; j++) dd += Math.abs(A[j] - B[j]); dsum += dd / A.length / 1000; } div = dsum / n; }
      for (i = 0; i < n; i++) { var b = w.bots[i]; e += b.energy / Sim.maxEnergy(b); for (j = 0; j < TRAITS.length; j++) sums[TRAITS[j]] += b.traits[TRAITS[j]]; }
      var food = s.winBotTicks > 600 ? s.winEaten / s.winBotTicks * 36000 : null;
      v.herd = herd;
      // smoothed values for pattern detection
      var k = LIMITS.ema; s.emaN++;
      METRICS.forEach(function (m) { if (v[m] !== null) s.ema[m] = s.ema[m] === null ? v[m] : s.ema[m] + k * (v[m] - s.ema[m]); });
      s.ema.breed = breedRatio(s);
      // per-lineage smoothing (accumulators decay so recent behaviour dominates)
      var top = null;
      for (var key in s.lineages) { var L = s.lineages[key]; L.m = accValues(L.acc); decay(L.acc, 0.95); if (!top || L.alive > top.alive) top = L; }
      if (s.emaN * LIMITS.sampleTicks >= LIMITS.minSamples * 10) {
        ['chase', 'follow', 'sprint', 'call'].forEach(function (m) {
          var who = null, val = s.ema[m];
          for (var key2 in s.lineages) { var L2 = s.lineages[key2]; if (L2.alive >= 3 && L2.m[m] !== null && L2.m[m] >= PATTERNS[m].th && (!who || L2.alive > who.alive)) who = L2; }
          if (n >= 3) detect(w, m, val, who ? who.name : (top ? top.name : null));
        });
        if (n >= 4) detect(w, 'herd', s.ema.herd, top ? top.name : null);
        detect(w, 'breed', s.ema.breed, top ? top.name : null);
      }
      // daily aggregates (for day-1 vs day-7 comparisons)
      var day = Math.floor(w.tick / 864000), D = s.daily[s.daily.length - 1];
      if (!D || D.day !== day) { D = { day: day, cs: 0, cn: 0, fs: 0, fn: 0, hs: 0, hn: 0, eaten: 0, botTicks: 0, pop: 0, pn: 0, ext: 0 }; s.daily.push(D); if (s.daily.length > LIMITS.days) s.daily.shift(); }
      D.cs += s.win.cs; D.cn += s.win.cn; D.fs += s.win.fs; D.fn += s.win.fn; if (herd !== null) { D.hs += herd; D.hn++; }
      D.eaten += s.winEaten; D.botTicks += s.winBotTicks; D.pop += n; D.pn++;
      s.win = newAcc(); s.winEaten = 0; s.winBotTicks = 0;
      // series
      var se = s.series;
      if (w.tick % se.interval !== 0) return;
      se.t.push(w.tick); se.alive.push(n); se.grass.push(w.grass.length); se.energy.push(n ? Math.round(100 * e / n) : 0);
      se.season.push(Math.floor(w.tick / w.config.seasonTicks) % 4); se.food.push(food === null ? null : r1(food)); se.div.push(r3(div));
      TRAITS.forEach(function (t) { se[t].push(n ? r3(sums[t] / n) : null); });
      METRICS.forEach(function (m) { se[m].push(r3(s.ema[m])); });
      if (se.t.length > LIMITS.seriesPoints) {
        se.interval *= 2;
        var keep = se.t.map(function (t) { return t % se.interval === 0; });
        Object.keys(se).forEach(function (q) { if (q !== 'interval') se[q] = se[q].filter(function (_, x) { return keep[x]; }); });
      }
    }
  };

  // Only derived, recomputed-before-use values are rounded; running totals are saved exactly so that a world
  // resumed from a save produces exactly the same statistics as one that never stopped.
  function compact(w) {
    var s = w.stats;
    for (var k in s.lineages) { var L = s.lineages[k]; for (var m in L.m) L.m[m] = r3(L.m[m]); }
    return w;
  }
  function oldestLiving(w) { var s = S(w), best = null; for (var k in s.lineages) { var L = s.lineages[k]; if (!best || L.born < best.born) best = L; } return best; }
  function dayValues(D) {
    return { day: D.day, chase: D.cn ? D.cs / D.cn : null, follow: D.fn ? D.fs / D.fn : null, herd: D.hn ? D.hs / D.hn : null,
             food: D.botTicks ? D.eaten / D.botTicks * 36000 : null, pop: D.pn ? D.pop / D.pn : 0, ext: D.ext || 0 };
  }
  function summary(w) {
    var s = S(w), L = s.lifespan, tm = w.config.tickMs;
    return {
      ageMs: w.tick * tm, era: s.era, extinctions: s.extinctions, alive: w.bots.length, botsBorn: s.botsBorn, births: s.births,
      deaths: s.deaths, grassSpawned: s.grassSpawned, grassEaten: s.grassEaten, grassNow: w.grass.length, maxGen: s.maxGen,
      avgLifeMs: L.count ? L.totalTicks / L.count * tm : 0, maxLifeMs: L.maxTicks * tm, maxLifeName: L.maxName,
      energy: s.energy, peakAlive: s.peakAlive, bySeason: s.bySeason, oldestLiving: oldestLiving(w), oldestEver: s.oldestLineage,
      lineagesAlive: Object.keys(s.lineages).length, ema: s.ema, patterns: s.patterns, daily: s.daily.map(dayValues)
    };
  }
  return { LIMITS: LIMITS, SEASONS: SEASONS, METRICS: METRICS, PATTERNS: PATTERNS, bind: bind, create: create, hooks: hooks, event: event,
           compact: compact, summary: summary, label: label, dayValues: dayValues };
});
