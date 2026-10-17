/* Bot World statistics. Pure bookkeeping: never touches the PRNG or world physics,
 * so adding metrics can't change what happens in the world.
 * Sim rules call the hooks below; add new counters/hooks here as rules grow. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LIMITS = { events: 120, lifespans: 100, seriesPoints: 240, sampleTicks: 600, // 1 sample / simulated minute
                 highlightGap: 216000 }; // same kind of behaviour highlight at most once per 6 simulated hours
  var MODES = ['seek', 'recall', 'wander', 'rest', 'near', 'avoid'];
  function zeroModes() { var o = {}; MODES.forEach(function (m) { o[m] = 0; }); return o; }

  function create() {
    return {
      botsBorn: 0,
      deaths: { total: 0, byCause: { starvation: 0 } },   // future causes add keys here
      extinctions: 0, era: 1,
      grassSpawned: 0, grassEaten: 0,
      energy: { gained: 0, wasted: 0, spent: 0 },          // wasted = food eaten while nearly full
      lifespan: { count: 0, totalTicks: 0, maxTicks: 0, maxName: null },
      peakAlive: 0,
      behavior: zeroModes(),                                // bot-ticks spent in each behaviour
      food: { sight: 0, memory: 0, bump: 0 },               // how eaten grass was found (memory = recalled spot, then seen)
      memoryForgotten: 0,                                   // arrived at remembered spot, nothing there
      lastHighlight: {},
      lifespans: [],                                        // recent dead bots, newest last
      series: { interval: LIMITS.sampleTicks, t: [], alive: [], grass: [], energy: [] },
      events: []
    };
  }
  function r1(x) { return Math.round(x * 10) / 10; }
  function S(w) { return w.stats || (w.stats = create()); }

  function event(w, type, text, extra) {
    var e = { tick: w.tick, type: type, text: text };
    if (extra) for (var k in extra) e[k] = extra[k];
    var ev = S(w).events; ev.push(e); if (ev.length > LIMITS.events) ev.shift();
  }

  // Rate-limited event for behaviour highlights so the log isn't flooded.
  function highlight(w, key, text, gap) {
    var s = S(w), last = s.lastHighlight[key];
    if (last !== undefined && w.tick - last < (gap || LIMITS.highlightGap)) return;
    s.lastHighlight[key] = w.tick; event(w, 'behavior', text);
  }

  // Per-bot counters live on the bot itself (b.eaten, b.gained, b.spent) so they're visible while alive.
  var hooks = {
    birth: function (w, b, why) {
      var s = S(w); s.botsBorn++; b.eaten = 0; b.gained = 0; b.spent = 0; b.era = s.era;
      b.time = zeroModes(); b.found = { sight: 0, memory: 0, bump: 0 };
      if (w.bots.length > s.peakAlive) s.peakAlive = w.bots.length;
      event(w, 'birth', b.name + ' was born (' + why + ')', { bot: b.id });
    },
    grassSpawn: function (w) { S(w).grassSpawned++; },
    eat: function (w, b, gained, wasted, how) {
      var s = S(w); s.grassEaten++; s.energy.gained += gained; s.energy.wasted += wasted;
      b.eaten++; b.gained += gained;
      if (how) { s.food[how]++; b.found[how]++; }
      var n = b.found.memory;                               // milestones only, so the log isn't flooded
      if (how === 'memory' && (n === 1 || n === 10 || n === 100 || n === 1000))
        event(w, 'behavior', b.name + (n === 1 ? ' used its memory to find food for the first time' : ' has found food from memory ' + n + ' times'));
    },
    forget: function (w, b) { S(w).memoryForgotten++; },
    behavior: function (w, b, prev, mode) {
      var s = S(w); s.behavior[mode]++; b.time[mode]++;
      if (mode !== prev && (mode === 'near' || mode === 'avoid')) {
        highlight(w, 'social:' + mode, mode === 'near' ? 'Food is plentiful: ' + b.name + ' drifts toward company'
                                                         : 'Food is scarce: ' + b.name + ' keeps its distance');
      }
      if (b.energy < w.config.maxEnergy * 0.1 && !b.lowWarned) { b.lowWarned = true; event(w, 'behavior', b.name + ' is close to starving (' + mode + ')'); }
    },
    spend: function (w, b, amount) { S(w).energy.spent += amount; b.spent += amount; },
    death: function (w, b, cause, fmt) {
      var s = S(w), age = w.tick - b.born;
      s.deaths.total++; s.deaths.byCause[cause] = (s.deaths.byCause[cause] || 0) + 1;
      s.lifespan.count++; s.lifespan.totalTicks += age;
      if (age > s.lifespan.maxTicks) { s.lifespan.maxTicks = age; s.lifespan.maxName = b.name; }
      s.lifespans.push({ id: b.id, name: b.name, era: b.era, born: b.born, died: w.tick, cause: cause,
                         eaten: b.eaten, gained: r1(b.gained), spent: r1(b.spent), time: b.time, found: b.found });
      if (s.lifespans.length > LIMITS.lifespans) s.lifespans.shift();
      event(w, 'death', b.name + ' died of ' + cause + ' at age ' + fmt(age * w.config.tickMs) + ' (ate ' + b.eaten + ')', { bot: b.id, cause: cause, age: age });
    },
    extinction: function (w, fmt) {
      var s = S(w); s.extinctions++;
      event(w, 'extinction', 'Extinction #' + s.extinctions + ': era ' + s.era + ' ended after ' + fmt((w.tick - (s.eraStart || 0)) * w.config.tickMs));
    },
    newEra: function (w) {
      var s = S(w); s.era++; s.eraStart = w.tick;
      event(w, 'resprout', 'New life sprouted: era ' + s.era + ' begins');
    },
    tick: function (w) {
      if (w.tick % LIMITS.sampleTicks !== 0) return;
      var s = S(w), se = s.series;
      if (w.tick % se.interval !== 0) return;
      var tot = 0; for (var i = 0; i < w.bots.length; i++) tot += w.bots[i].energy;
      se.t.push(w.tick); se.alive.push(w.bots.length); se.grass.push(w.grass.length);
      se.energy.push(w.bots.length ? r1(tot / w.bots.length) : 0);
      if (se.t.length > LIMITS.seriesPoints) {          // downsample: halve resolution
        se.interval *= 2;                                   // keep only samples aligned to the new interval
        var keep = se.t.map(function (t) { return t % se.interval === 0; });
        ['t', 'alive', 'grass', 'energy'].forEach(function (k) { se[k] = se[k].filter(function (_, j) { return keep[j]; }); });
      }
    }
  };

  // Rounds float counters before saving so the file stays small and readable.
  function compact(s) {
    s.energy.gained = r1(s.energy.gained); s.energy.wasted = r1(s.energy.wasted); s.energy.spent = r1(s.energy.spent);
    return s;
  }

  function summary(w) {
    var s = S(w), L = s.lifespan, tm = w.config.tickMs;
    return {
      ageMs: w.tick * tm, era: s.era, extinctions: s.extinctions, alive: w.bots.length, botsBorn: s.botsBorn,
      deaths: s.deaths, grassSpawned: s.grassSpawned, grassEaten: s.grassEaten, grassNow: w.grass.length,
      avgLifeMs: L.count ? L.totalTicks / L.count * tm : 0, maxLifeMs: L.maxTicks * tm, maxLifeName: L.maxName,
      energy: s.energy, peakAlive: s.peakAlive, behavior: s.behavior, food: s.food, memoryForgotten: s.memoryForgotten
    };
  }

  return { LIMITS: LIMITS, MODES: MODES, create: create, hooks: hooks, event: event, compact: compact, summary: summary };
});
