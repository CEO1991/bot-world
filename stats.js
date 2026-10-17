/* Bot World statistics. Pure bookkeeping: never touches the PRNG or world physics,
 * so adding metrics can't change what happens in the world.
 * Sim rules call the hooks below; add new counters/hooks here as rules grow. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LIMITS = { events: 80, lifespans: 30, seriesPoints: 240, sampleTicks: 600, // 1 sample / simulated minute
                 seasonLog: 16, highlightGap: 216000, genMilestone: 5 };
  var MODES = ['seek', 'recall', 'wander', 'rest', 'near', 'avoid'];
  var SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
  var TRAITS = ['speed', 'vision', 'hunger', 'rest', 'size'];
  var Sim = null; // bound by sim.js (for maxEnergy etc.)
  function bind(api) { Sim = api; }
  function zero(keys) { var o = {}; keys.forEach(function (m) { o[m] = 0; }); return o; }
  function r1(x) { return Math.round(x * 10) / 10; }
  function r3(x) { return Math.round(x * 1000) / 1000; }

  function create() {
    var series = { interval: LIMITS.sampleTicks, t: [], alive: [], grass: [], energy: [], season: [] };
    TRAITS.forEach(function (k) { series[k] = []; });
    var bySeason = {}; SEASONS.forEach(function (n) { bySeason[n] = { births: 0, deaths: 0, eaten: 0, ticks: 0 }; });
    return {
      botsBorn: 0, births: { first: 0, resprout: 0, reproduction: 0 },
      deaths: { total: 0, byCause: { starvation: 0 } },     // future causes add keys here
      extinctions: 0, era: 1, maxGen: 1,
      grassSpawned: 0, grassEaten: 0,
      energy: { gained: 0, wasted: 0, spent: 0 },
      lifespan: { count: 0, totalTicks: 0, maxTicks: 0, maxName: null },
      peakAlive: 0,
      behavior: zero(MODES), food: { sight: 0, memory: 0, bump: 0 }, memoryForgotten: 0,
      bySeason: bySeason,
      season: { name: 'Spring', year: 0, births: 0, deaths: 0, eaten: 0, popStart: 2, popMin: 2, popMax: 2 },
      seasonLog: [],                                        // last finished seasons
      lineages: {},                                         // living lineages only: root id -> info
      oldestLineage: null,                                  // longest-lasting lineage seen (ended or alive)
      lastHighlight: {},
      lifespans: [], series: series, events: []
    };
  }
  function S(w) { return w.stats || (w.stats = create()); }

  function event(w, type, text, extra) {
    var e = { tick: w.tick, type: type, text: text };
    if (extra) for (var k in extra) e[k] = extra[k];
    var ev = S(w).events; ev.push(e); if (ev.length > LIMITS.events) ev.shift();
  }
  function highlight(w, key, text) {
    var s = S(w), last = s.lastHighlight[key];
    if (last !== undefined && w.tick - last < LIMITS.highlightGap) return;
    s.lastHighlight[key] = w.tick; event(w, 'behavior', text);
  }
  function label(b) { return b.name + ' g' + b.gen + ' #' + b.id; }
  function seasonName(w) { return SEASONS[Math.floor(w.tick / w.config.seasonTicks) % 4]; }

  var hooks = {
    birth: function (w, b, why) {
      var s = S(w), kind = b.parent ? 'reproduction' : (s.era > 1 ? 'resprout' : 'first');
      s.botsBorn++; s.births[kind]++; s.bySeason[seasonName(w)].births++; s.season.births++;
      b.eaten = 0; b.gained = 0; b.spent = 0; b.era = s.era;
      b.time = zero(MODES); b.found = { sight: 0, memory: 0, bump: 0 };
      if (w.bots.length > s.peakAlive) s.peakAlive = w.bots.length;
      if (w.bots.length > s.season.popMax) s.season.popMax = w.bots.length;
      var L = s.lineages[b.lineage];
      if (!L) L = s.lineages[b.lineage] = { root: b.lineage, name: b.name, era: s.era, born: w.tick, members: 0, alive: 0, maxGen: 1 };
      L.members++; L.alive++; if (b.gen > L.maxGen) L.maxGen = b.gen;
      if (b.gen > s.maxGen) {
        s.maxGen = b.gen;
        if (b.gen % LIMITS.genMilestone === 0) event(w, 'birth', 'Generation ' + b.gen + ' reached (' + label(b) + ')');
      }
      if (kind !== 'reproduction') event(w, 'birth', label(b) + ' was born (' + why + ')', { bot: b.id });
    },
    grassSpawn: function (w) { S(w).grassSpawned++; },
    eat: function (w, b, gained, wasted, how) {
      var s = S(w); s.grassEaten++; s.energy.gained += gained; s.energy.wasted += wasted;
      s.bySeason[seasonName(w)].eaten++; s.season.eaten++;
      b.eaten++; b.gained += gained;
      if (how) { s.food[how]++; b.found[how]++; }
    },
    forget: function (w) { S(w).memoryForgotten++; },
    modeChange: function (w, b, prev, mode) {
      if (mode === 'near') highlight(w, 'social:near', 'Food is plentiful: bots gather near each other');
      else if (mode === 'avoid') highlight(w, 'social:avoid', 'Food is scarce: bots keep their distance');
    },
    behavior: function (w, b) { var s = S(w); s.behavior[b.mode]++; b.time[b.mode]++; },
    spend: function (w, b, amount) { S(w).energy.spent += amount; b.spent += amount; },
    death: function (w, b, cause, fmt) {
      var s = S(w), age = w.tick - b.born;
      s.deaths.total++; s.deaths.byCause[cause] = (s.deaths.byCause[cause] || 0) + 1;
      s.bySeason[seasonName(w)].deaths++; s.season.deaths++;
      if (w.bots.length < s.season.popMin) s.season.popMin = w.bots.length;
      s.lifespan.count++; s.lifespan.totalTicks += age;
      if (age > s.lifespan.maxTicks) { s.lifespan.maxTicks = age; s.lifespan.maxName = label(b); }
      var T = {}; TRAITS.forEach(function (k) { T[k] = r3(b.traits[k]); });
      s.lifespans.push({ id: b.id, name: b.name, gen: b.gen, era: b.era, born: b.born, died: w.tick, cause: cause, kids: b.kids,
                         eaten: b.eaten, traits: T });
      if (s.lifespans.length > LIMITS.lifespans) s.lifespans.shift();
      var L = s.lineages[b.lineage];
      if (L) {
        L.alive--;
        var lasted = w.tick - L.born;
        if (!s.oldestLineage || lasted > s.oldestLineage.lasted) s.oldestLineage = { root: L.root, name: L.name, era: L.era, lasted: lasted, members: L.members, maxGen: L.maxGen };
        if (L.alive <= 0) {
          delete s.lineages[b.lineage];
          if (w.bots.length > 0) event(w, 'death', 'The ' + L.name + ' line died out after ' + fmt(lasted * w.config.tickMs) + ' (' + L.members + ' members, ' + L.maxGen + ' generations)');
        }
      }
      if (w.bots.length <= 2) event(w, 'death', label(b) + ' died of ' + cause + ' at age ' + fmt(age * w.config.tickMs) + ' (' + w.bots.length + ' left)', { bot: b.id, cause: cause, age: age });
    },
    extinction: function (w, fmt) {
      var s = S(w); s.extinctions++;
      event(w, 'extinction', 'Extinction #' + s.extinctions + ' in ' + seasonName(w) + ': era ' + s.era + ' ended after ' + fmt((w.tick - (s.eraStart || 0)) * w.config.tickMs));
    },
    newEra: function (w) {
      var s = S(w); s.era++; s.eraStart = w.tick;
      event(w, 'resprout', 'New life sprouted: era ' + s.era + ' begins');
    },
    season: function (w, info) {   // called at the first tick of each season
      var s = S(w), c = s.season, n = w.bots.length;
      c.popEnd = n;
      s.seasonLog.push(c); if (s.seasonLog.length > LIMITS.seasonLog) s.seasonLog.shift();
      event(w, 'season', c.name + ' ended: +' + c.births + ' born, -' + c.deaths + ' died, ' + c.eaten + ' eaten, population ' + c.popStart + ' -> ' + n +
            '. ' + info.name + ' begins' + (info.strength < 0.85 ? (info.index === 3 ? ' (mild)' : ' (lean)') : info.strength > 1.15 ? (info.index === 3 ? ' (harsh)' : ' (lush)') : ''));
      s.season = { name: info.name, year: info.year, births: 0, deaths: 0, eaten: 0, popStart: n, popMin: n, popMax: n };
    },
    tick: function (w) {
      var s = S(w);
      s.bySeason[seasonName(w)].ticks++;
      if (w.tick % LIMITS.sampleTicks !== 0) return;
      var se = s.series;
      if (w.tick % se.interval !== 0) return;
      var n = w.bots.length, e = 0, sums = zero(TRAITS);
      for (var i = 0; i < n; i++) {
        var b = w.bots[i]; e += b.energy / Sim.maxEnergy(b);
        for (var j = 0; j < TRAITS.length; j++) sums[TRAITS[j]] += b.traits[TRAITS[j]];
      }
      se.t.push(w.tick); se.alive.push(n); se.grass.push(w.grass.length);
      se.energy.push(n ? Math.round(100 * e / n) : 0);
      se.season.push(Math.floor(w.tick / w.config.seasonTicks) % 4);
      TRAITS.forEach(function (k) { se[k].push(n ? r3(sums[k] / n) : null); });
      if (se.t.length > LIMITS.seriesPoints) {              // downsample: halve resolution, keep aligned samples
        se.interval *= 2;
        var keep = se.t.map(function (t) { return t % se.interval === 0; });
        Object.keys(se).forEach(function (k) { if (k !== 'interval') se[k] = se[k].filter(function (_, j) { return keep[j]; }); });
      }
    }
  };

  // Rounds float counters before saving so the file stays small and readable (never touches sim state).
  function compact(w) {
    var s = w.stats;
    s.energy.gained = r1(s.energy.gained); s.energy.wasted = r1(s.energy.wasted); s.energy.spent = r1(s.energy.spent);
    w.bots.forEach(function (b) { b.gained = r1(b.gained); b.spent = r1(b.spent); });
    return w;
  }

  function oldestLiving(w) {
    var s = S(w), best = null;
    for (var k in s.lineages) { var L = s.lineages[k]; if (!best || L.born < best.born) best = L; }
    return best;
  }

  function summary(w) {
    var s = S(w), L = s.lifespan, tm = w.config.tickMs;
    return {
      ageMs: w.tick * tm, era: s.era, extinctions: s.extinctions, alive: w.bots.length, botsBorn: s.botsBorn, births: s.births,
      deaths: s.deaths, grassSpawned: s.grassSpawned, grassEaten: s.grassEaten, grassNow: w.grass.length, maxGen: s.maxGen,
      avgLifeMs: L.count ? L.totalTicks / L.count * tm : 0, maxLifeMs: L.maxTicks * tm, maxLifeName: L.maxName,
      energy: s.energy, peakAlive: s.peakAlive, behavior: s.behavior, food: s.food, memoryForgotten: s.memoryForgotten,
      bySeason: s.bySeason, oldestLiving: oldestLiving(w), oldestEver: s.oldestLineage, lineagesAlive: Object.keys(s.lineages).length
    };
  }

  return { LIMITS: LIMITS, MODES: MODES, SEASONS: SEASONS, bind: bind, create: create, hooks: hooks, event: event,
           compact: compact, summary: summary, label: label };
});
