/* Bot World statistics. Pure bookkeeping: never touches the PRNG or world physics,
 * so adding metrics can't change what happens in the world.
 * Sim rules call the hooks below; add new counters/hooks here as rules grow. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LIMITS = { events: 120, lifespans: 100, seriesPoints: 240, sampleTicks: 600 }; // 1 sample / simulated minute

  function create() {
    return {
      botsBorn: 0,
      deaths: { total: 0, byCause: { starvation: 0 } },   // future causes add keys here
      extinctions: 0, era: 1,
      grassSpawned: 0, grassEaten: 0,
      energy: { gained: 0, wasted: 0, spent: 0 },          // wasted = food eaten while nearly full
      lifespan: { count: 0, totalTicks: 0, maxTicks: 0, maxName: null },
      peakAlive: 0,
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

  // Per-bot counters live on the bot itself (b.eaten, b.gained, b.spent) so they're visible while alive.
  var hooks = {
    birth: function (w, b, why) {
      var s = S(w); s.botsBorn++; b.eaten = 0; b.gained = 0; b.spent = 0; b.era = s.era;
      if (w.bots.length > s.peakAlive) s.peakAlive = w.bots.length;
      event(w, 'birth', b.name + ' was born (' + why + ')', { bot: b.id });
    },
    grassSpawn: function (w) { S(w).grassSpawned++; },
    eat: function (w, b, gained, wasted) {
      var s = S(w); s.grassEaten++; s.energy.gained += gained; s.energy.wasted += wasted;
      b.eaten++; b.gained += gained;
    },
    spend: function (w, b, amount) { S(w).energy.spent += amount; b.spent += amount; },
    death: function (w, b, cause, fmt) {
      var s = S(w), age = w.tick - b.born;
      s.deaths.total++; s.deaths.byCause[cause] = (s.deaths.byCause[cause] || 0) + 1;
      s.lifespan.count++; s.lifespan.totalTicks += age;
      if (age > s.lifespan.maxTicks) { s.lifespan.maxTicks = age; s.lifespan.maxName = b.name; }
      s.lifespans.push({ id: b.id, name: b.name, era: b.era, born: b.born, died: w.tick, cause: cause,
                         eaten: b.eaten, gained: r1(b.gained), spent: r1(b.spent) });
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
      energy: s.energy, peakAlive: s.peakAlive
    };
  }

  return { LIMITS: LIMITS, create: create, hooks: hooks, event: event, compact: compact, summary: summary };
});
