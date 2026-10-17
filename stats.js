/* Bot World statistics. Pure bookkeeping: never touches the PRNG or world physics,
 * so adding metrics can't change what happens in the world.
 * Behaviour is measured from OUTCOMES (what bots actually do), never from code labels:
 *   chase  - hungry & grass visible: mean cos(heading, direction to grass)                 random 0, perfect 1
 *   follow - mean cos(own heading, nearest visible bot's heading)                         random 0
 *   herd   - random-baseline nearest-neighbour distance / actual (settled bots)          random ~1, >1 clustered
 *   sprint - mean thrust when food is visible minus otherwise                             0 = no strategy
 *   call   - max over signal channels of |mean signal when food visible - otherwise|      0 = uninformative
 *   warn   - same, for distress (energy < 30% or warmth < 30%) vs not
 *   huddle - with no food in sight: mean cos(heading, direction to nearest bot), winter minus summer   0 = no seasonal huddling
 *   cluster- (info only) winter/summer ratio of bot-time warmed by a close bot vs random placement; confounded by food scarcity
 *   settle - share of bot-time on riverbanks / share of land that is riverbank             1 = random
 *   paths  - share of movement in the busiest 10% of map cells                              ~0.1-0.2 random
 *   cache  - share of meals that were food the bot itself had dropped earlier
 *   share  - share of meals that were food another bot had dropped
 *   store  - share of winter meals that came from food stored before winter
 *   breed  - breeding rate of eligible bots in spring+summer / autumn+winter                1 = no timing */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LIMITS = { events: 80, lifespans: 30, seriesPoints: 240, sampleTicks: 600, seasonLog: 16, days: 30,
                 genMilestone: 10, patternGap: 216000, ema: 0.05, warmup: 3000, sustain: 30, decay: 0.98 };
  var SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
  var TRAITS = ['speed', 'vision', 'size'];
  var METRICS = ['chase', 'follow', 'herd', 'sprint', 'call', 'warn', 'huddle', 'cluster', 'settle', 'paths', 'cache', 'share', 'store', 'breed'];
  var PATTERNS = {
    chase:  { th: 0.5,  text: 'learned to chase food' },
    follow: { th: 0.35, text: 'started following each other' },
    herd:   { th: 1.6,  text: 'Herding emerged: bots cluster together' },
    sprint: { th: 0.25, text: 'learned to sprint for food and coast otherwise' },
    call:   { th: 0.75, text: 'developed a food call (a signal that changes when food is seen)' },
    warn:   { th: 0.75, text: 'developed a distress signal (changes when hungry or cold)' },
    huddle: { th: 0.35, text: 'Huddling emerged: with no food in sight, bots head toward each other in winter far more than in summer' },
    settle: { th: 1.6,  text: 'Settlement emerged: bots stay near the riverbanks' },
    paths:  { th: 0.45, text: 'Paths emerged: movement concentrates on a few routes' },
    cache:  { th: 0.12, text: 'learned to cache food and come back for it' },
    share:  { th: 0.15, text: 'Sharing emerged: bots eat food that others dropped' },
    store:  { th: 0.15, text: 'Winter stores emerged: bots eat food stored before winter' },
    breed:  { th: 2.5,  text: 'Seasonal breeding emerged: bots breed in spring/summer, hold back in autumn/winter' }
  };
  var GLOBAL_ONLY = { herd: 1, huddle: 1, settle: 1, paths: 1, share: 1, store: 1, breed: 1 };
  var Sim = null;
  function bind(api) { Sim = api; }
  function zero(keys) { var o = {}; keys.forEach(function (m) { o[m] = 0; }); return o; }
  function r3(x) { return x === null ? null : Math.round(x * 1000) / 1000; }
  function newAcc() { return { cs: 0, cn: 0, fs: 0, fn: 0, tf: 0, nf: 0, to: 0, no: 0, af1: 0, af2: 0, ao1: 0, ao2: 0, d1: 0, d2: 0, dn: 0, u1: 0, u2: 0, un: 0 }; }
  function newWin() { var a = newAcc(); a.warm = 0; a.wn = 0; a.bank = 0; a.bn = 0; a.ap = 0; a.an = 0; return a; }

  function create() {
    var series = { interval: LIMITS.sampleTicks, t: [], alive: [], grass: [], dropped: [], energy: [], season: [], food: [], div: [], home: [] };
    TRAITS.concat(METRICS).forEach(function (k) { series[k] = []; });
    var bySeason = {}, breed = {};
    SEASONS.forEach(function (n) { bySeason[n] = { births: 0, deaths: 0, eaten: 0, ticks: 0 }; breed[n] = { elig: 0, bred: 0 }; });
    var ema = {}; METRICS.forEach(function (m) { ema[m] = null; });
    return {
      botsBorn: 0, births: { first: 0, resprout: 0, reproduction: 0 },
      deaths: { total: 0, byCause: { starvation: 0 } }, extinctions: 0, era: 1, maxGen: 1, grassSpawned: 0, grassEaten: 0,
      energy: { gained: 0, wasted: 0, spent: 0, heat: 0, climb: 0 },
      lifespan: { count: 0, totalTicks: 0, maxTicks: 0, maxName: null }, peakAlive: 0,
      bySeason: bySeason, breed: breed,
      season: { name: 'Spring', year: 0, births: 0, deaths: 0, eaten: 0, popStart: 2, popMin: 2, popMax: 2 }, seasonLog: [], winterStart: null,
      lineages: {}, oldestLineage: null,
      foodx: { pickups: 0, drops: 0, rotted: 0, carriedMeals: 0, cached: 0, shared: 0, kinShared: 0, winterEats: 0, winterFromStore: 0 },
      dec: { eats: 0, cached: 0, shared: 0, wEats: 0, wStore: 0 },   // decaying counters for rates
      warmS: [null, null, null, null],                                // smoothed contact share (vs random placement) per season
      apS: [null, null, null, null],                                  // smoothed approach-to-nearest-bot (no food in sight) per season
      visits: [],                                                    // decaying movement counts per 50px cell
      win: newWin(), winEaten: 0, winBotTicks: 0,
      ema: ema, emaN: 0, patterns: {}, daily: [],
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
  function seasonIdx(w) { return Math.floor(w.tick / w.config.seasonTicks) % 4; }
  function seasonName(w) { return SEASONS[seasonIdx(w)]; }
  function accAdd(a, E, grassAhead, follow, th, s1, s2, distress) {
    if (grassAhead !== null) { a.tf += th; a.nf++; a.af1 += s1; a.af2 += s2; if (E < 0.75) { a.cs += grassAhead; a.cn++; } }
    else { a.to += th; a.no++; a.ao1 += s1; a.ao2 += s2; }
    if (distress) { a.d1 += s1; a.d2 += s2; a.dn++; } else { a.u1 += s1; a.u2 += s2; a.un++; }
    if (follow !== null) { a.fs += follow; a.fn++; }
  }
  function accValues(a) {
    var ok = a.nf >= 20 && a.no >= 20, okd = a.dn >= 20 && a.un >= 20;
    return { chase: a.cn >= 20 ? a.cs / a.cn : null, follow: a.fn >= 20 ? a.fs / a.fn : null,
             sprint: ok ? a.tf / a.nf - a.to / a.no : null,
             call: ok ? Math.max(Math.abs(a.af1 / a.nf - a.ao1 / a.no), Math.abs(a.af2 / a.nf - a.ao2 / a.no)) : null,
             warn: okd ? Math.max(Math.abs(a.d1 / a.dn - a.u1 / a.un), Math.abs(a.d2 / a.dn - a.u2 / a.un)) : null };
  }
  function decay(a, k) { for (var key in a) a[key] *= k; }
  function breedRatio(s) {
    var B = s.breed, good = (B.Spring.bred + B.Summer.bred) / Math.max(1, B.Spring.elig + B.Summer.elig),
        bad = (B.Autumn.bred + B.Winter.bred) / Math.max(1, B.Autumn.elig + B.Winter.elig);
    if (B.Spring.elig + B.Summer.elig < 50 || B.Autumn.elig + B.Winter.elig < 50) return null;
    return Math.min(20, good / Math.max(bad, 0.01));
  }
  function detect(w, key, value, who) {
    var s = S(w), P = PATTERNS[key], st = s.patterns[key] || (s.patterns[key] = { first: null, count: 0, active: false, last: null, lineage: null, above: 0 });
    if (value === null) return;
    st.above = value >= P.th ? st.above + 1 : 0;
    if (!st.active && st.above >= LIMITS.sustain) {
      st.active = true; st.count++;
      if (st.first === null) st.first = w.tick;
      if (st.last === null || w.tick - st.last >= LIMITS.patternGap) {
        st.last = w.tick; st.lineage = who || null;
        event(w, 'pattern', GLOBAL_ONLY[key] ? P.text + (who ? ' (mostly the ' + who + ' line)' : '') : (who ? 'The ' + who + ' line ' : 'Bots ') + P.text);
      }
    } else if (st.active && value < P.th * 0.7) st.active = false;
  }
  function stored(s, item) { var ws = s.winterStart; return ws !== null && ((item.picked && item.picked < ws) || (item.dropTick && item.dropTick < ws)); }

  var hooks = {
    birth: function (w, b, why) {
      var s = S(w), kind = b.parent ? 'reproduction' : (s.era > 1 ? 'resprout' : 'first');
      s.botsBorn++; s.births[kind]++; s.bySeason[seasonName(w)].births++; s.season.births++;
      if (kind === 'reproduction') s.breed[seasonName(w)].bred++;
      b.eaten = 0; b.gained = 0; b.spent = 0; b.era = s.era; b.hr = [0, 0, 0, 0, 0]; b.shared = 0; b.cached = 0;
      if (w.bots.length > s.peakAlive) s.peakAlive = w.bots.length;
      if (w.bots.length > s.season.popMax) s.season.popMax = w.bots.length;
      var L = s.lineages[b.lineage];
      if (!L) L = s.lineages[b.lineage] = { root: b.lineage, name: b.name, era: s.era, born: w.tick, members: 0, alive: 0, maxGen: 1, births: 0, acc: newAcc(), m: {} };
      L.members++; L.alive++; if (b.parent) L.births++; if (b.gen > L.maxGen) L.maxGen = b.gen;
      if (b.gen > s.maxGen) { s.maxGen = b.gen; if (b.gen % LIMITS.genMilestone === 0) event(w, 'birth', 'Generation ' + b.gen + ' reached (' + label(b) + ')'); }
      if (kind !== 'reproduction') event(w, 'birth', label(b) + ' was born (' + why + ')', { bot: b.id });
    },
    grassSpawn: function (w) { S(w).grassSpawned++; },
    eat: function (w, b, gained, wasted, item, how) {
      var s = S(w), X = s.foodx, D = s.dec, winter = seasonIdx(w) === 3;
      s.grassEaten++; s.winEaten++; s.energy.gained += gained; s.energy.wasted += wasted;
      s.bySeason[seasonName(w)].eaten++; s.season.eaten++; b.eaten++; b.gained += gained; D.eats++;
      if (how === 'carried') X.carriedMeals++;
      if (item.dropper && !item.corpse) {
        if (item.dropper === b.id) { X.cached++; D.cached++; b.cached++; }
        else { X.shared++; D.shared++; b.shared++; if (item.dropLin === b.lineage) X.kinShared++; }
      }
      if (winter) { X.winterEats++; D.wEats++; if (stored(s, item)) { X.winterFromStore++; D.wStore++; } }
    },
    pickup: function (w) { S(w).foodx.pickups++; },
    dropped: function (w) { S(w).foodx.drops++; },
    rot: function (w) { S(w).foodx.rotted++; },
    perceive: function (w, b, p) {
      var s = S(w), follow = p.other ? b.hx * p.other.hx + b.hy * p.other.hy : null, distress = p.E < 0.3 || p.warm < 0.3;
      accAdd(s.win, p.E, p.grassAhead, follow, b.th, b.s1, b.s2, distress);
      s.win.warm += b.warm > 0 ? 1 : 0; s.win.wn++;
      if (p.other && p.grassAhead === null) { var ox = p.other.x - b.x, oy = p.other.y - b.y, ol = Math.sqrt(ox * ox + oy * oy) || 1; s.win.ap += (b.hx * ox + b.hy * oy) / ol; s.win.an++; } s.win.bank += p.bank; s.win.bn++;
      var L = s.lineages[b.lineage]; if (L) accAdd(L.acc, p.E, p.grassAhead, follow, b.th, b.s1, b.s2, distress);
      if (b.vx * b.vx + b.vy * b.vy > 1) { var c = Math.floor(b.y / 50) * 20 + Math.floor(b.x / 50); s.visits[c] = (s.visits[c] || 0) + 1; }
      var h = b.hr; h[0]++; h[1] += b.x; h[2] += b.y; h[3] += b.x * b.x; h[4] += b.y * b.y;
    },
    eligible: function (w) { S(w).breed[seasonName(w)].elig++; },
    spend: function (w, b, amount, heat, climb) { var s = S(w); s.energy.spent += amount; s.energy.heat += heat; if (climb > 0) s.energy.climb += climb; b.spent += amount; },
    death: function (w, b, cause, fmt) {
      var s = S(w), age = w.tick - b.born;
      s.deaths.total++; s.deaths.byCause[cause] = (s.deaths.byCause[cause] || 0) + 1;
      s.bySeason[seasonName(w)].deaths++; s.season.deaths++;
      if (w.bots.length < s.season.popMin) s.season.popMin = w.bots.length;
      s.lifespan.count++; s.lifespan.totalTicks += age;
      if (age > s.lifespan.maxTicks) { s.lifespan.maxTicks = age; s.lifespan.maxName = label(b); }
      var T = {}; TRAITS.forEach(function (k) { T[k] = r3(b.traits[k]); });
      s.lifespans.push({ id: b.id, name: b.name, gen: b.gen, era: b.era, born: b.born, died: w.tick, cause: cause, kids: b.kids, eaten: b.eaten, cached: b.cached, shared: b.shared, traits: T });
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
      if (info.index === 3) s.winterStart = w.tick;
      if (info.index === 0) for (var k in s.breed) { s.breed[k].elig *= 0.5; s.breed[k].bred *= 0.5; }
    },
    tick: function (w, T) {
      var s = S(w), n = w.bots.length;
      s.bySeason[seasonName(w)].ticks++; s.winBotTicks += n;
      if (w.tick % LIMITS.sampleTicks !== 0) return;
      // ---------- one sample per simulated minute ----------
      var v = accValues(s.win), herd = null, e = 0, sums = zero(TRAITS), div = null, i, j, si = seasonIdx(w), k = LIMITS.ema;
      var settled = w.bots.filter(function (q) { return w.tick - q.born >= 3000; }), ns = settled.length;
      if (ns >= 3) {
        var tot = 0;
        for (i = 0; i < ns; i++) { var a = settled[i], best = Infinity;
          for (j = 0; j < ns; j++) { if (i === j) continue; var dx = settled[j].x - a.x, dy = settled[j].y - a.y, d = dx * dx + dy * dy; if (d < best) best = d; }
          tot += Math.sqrt(best); }
        var Ar = w.config.width * w.config.height, Pr = 2 * (w.config.width + w.config.height);
        herd = (0.5 * Math.sqrt(Ar / ns) + (0.0514 + 0.041 / Math.sqrt(ns)) * Pr / ns) / (tot / ns);
      }
      if (n >= 2) { var dsum = 0; for (i = 0; i < n; i++) { var A = w.bots[i].brain, B = w.bots[(i + 1) % n].brain, dd = 0;
          for (j = 0; j < A.length; j++) dd += Math.abs(A[j] - B[j]); dsum += dd / A.length / 1000; } div = dsum / n; }
      var home = 0, hn = 0;
      for (i = 0; i < n; i++) { var b = w.bots[i]; e += b.energy / Sim.maxEnergy(b); for (j = 0; j < TRAITS.length; j++) sums[TRAITS[j]] += b.traits[TRAITS[j]];
        var h = b.hr; if (h[0] >= 50) { var mx = h[1] / h[0], my = h[2] / h[0]; home += Math.sqrt(Math.max(0, h[3] / h[0] - mx * mx + h[4] / h[0] - my * my)); hn++; } }
      var food = s.winBotTicks > 600 ? s.winEaten / s.winBotTicks * 36000 : null;
      // warmth contact by season -> huddling
      // contact share relative to what random placement of the same number of bots would give
      if (s.win.wn >= 10 && n >= 4) {
        var rr = w.config.warmRadius + 28, pc = 3.1416 * rr * rr / (w.config.width * w.config.height), ex = 1, wf;
        for (i = 1; i < n; i++) ex *= 1 - pc;
        wf = (s.win.warm / s.win.wn) / Math.max(0.02, 1 - ex);
        s.warmS[si] = s.warmS[si] === null ? wf : s.warmS[si] + 0.02 * (wf - s.warmS[si]);
      }
      v.cluster = s.warmS[3] !== null && s.warmS[1] !== null ? s.warmS[3] / Math.max(0.05, s.warmS[1]) : null;
      if (s.win.an >= 10) { var apv = s.win.ap / s.win.an; s.apS[si] = s.apS[si] === null ? apv : s.apS[si] + 0.02 * (apv - s.apS[si]); }
      v.huddle = s.apS[3] !== null && s.apS[1] !== null ? s.apS[3] - s.apS[1] : null;
      v.settle = s.win.bn >= 10 ? (s.win.bank / s.win.bn) / Math.max(0.01, T.bankFrac) : null;
      // paths: share of decayed movement in the busiest 10% of cells
      var vis = s.visits, all = [], total = 0;
      for (i = 0; i < 260; i++) { var c = vis[i] || 0; c = c * LIMITS.decay; vis[i] = c; all.push(c); total += c; }
      if (total > 200) { all.sort(function (p, q) { return q - p; }); var top = 0; for (i = 0; i < 26; i++) top += all[i]; v.paths = top / total; } else v.paths = null;
      var Dc = s.dec; decay(Dc, LIMITS.decay);
      v.cache = Dc.eats >= 20 ? Dc.cached / Dc.eats : null; v.share = Dc.eats >= 20 ? Dc.shared / Dc.eats : null;
      v.store = Dc.wEats >= 10 ? Dc.wStore / Dc.wEats : null;
      v.herd = herd;
      s.emaN++;
      METRICS.forEach(function (m) { if (m !== 'breed' && m !== 'huddle' && m !== 'cluster' && v[m] !== null && v[m] !== undefined) s.ema[m] = s.ema[m] === null ? v[m] : s.ema[m] + k * (v[m] - s.ema[m]); });
      s.ema.huddle = v.huddle; s.ema.cluster = v.cluster; s.ema.breed = breedRatio(s);
      var topL = null;
      for (var key in s.lineages) { var L = s.lineages[key]; L.m = accValues(L.acc); decay(L.acc, 0.95); if (!topL || L.alive > topL.alive) topL = L; }
      if (w.tick >= LIMITS.warmup * 10) {
        METRICS.forEach(function (m) {
          if (!PATTERNS[m]) return;
          if (GLOBAL_ONLY[m]) { if (n >= (m === 'herd' || m === 'huddle' ? 4 : m === 'paths' ? 6 : 2)) detect(w, m, s.ema[m], topL ? topL.name : null); return; }
          var who = null;
          for (var key2 in s.lineages) { var L2 = s.lineages[key2]; if (L2.alive >= 3 && L2.m[m] !== null && L2.m[m] !== undefined && L2.m[m] >= PATTERNS[m].th && (!who || L2.alive > who.alive)) who = L2; }
          if (n >= 3) detect(w, m, s.ema[m], who ? who.name : (topL ? topL.name : null));
        });
      }
      // daily aggregates
      var day = Math.floor(w.tick / 864000), DD = s.daily[s.daily.length - 1];
      if (!DD || DD.day !== day) { DD = { day: day, cs: 0, cn: 0, fs: 0, fn: 0, hs: 0, hn: 0, eaten: 0, botTicks: 0, pop: 0, pn: 0, ext: 0, cached: 0, shared: 0, meals: 0, bank: 0, bn: 0 };
        s.daily.push(DD); if (s.daily.length > LIMITS.days) s.daily.shift(); s.dayStart = { cached: s.foodx.cached, shared: s.foodx.shared, meals: s.grassEaten }; }
      DD.cs += s.win.cs; DD.cn += s.win.cn; DD.fs += s.win.fs; DD.fn += s.win.fn; if (herd !== null) { DD.hs += herd; DD.hn++; }
      DD.eaten += s.winEaten; DD.botTicks += s.winBotTicks; DD.pop += n; DD.pn++; DD.bank += s.win.bank; DD.bn += s.win.bn;
      if (s.dayStart) { DD.cached = s.foodx.cached - s.dayStart.cached; DD.shared = s.foodx.shared - s.dayStart.shared; DD.meals = s.grassEaten - s.dayStart.meals; }
      DD.bankFrac = T.bankFrac;
      s.win = newWin(); s.winEaten = 0; s.winBotTicks = 0;
      var se = s.series;
      if (w.tick % se.interval !== 0) return;
      se.t.push(w.tick); se.alive.push(n); se.grass.push(w.natural); se.dropped.push(w.dropped); se.energy.push(n ? Math.round(100 * e / n) : 0);
      se.season.push(si); se.food.push(food === null ? null : Math.round(food * 10) / 10); se.div.push(r3(div)); se.home.push(hn ? Math.round(home / hn) : null);
      TRAITS.forEach(function (t) { se[t].push(n ? r3(sums[t] / n) : null); });
      METRICS.forEach(function (m) { se[m].push(r3(s.ema[m])); });
      if (se.t.length > LIMITS.seriesPoints) {
        se.interval *= 2;
        var keep = se.t.map(function (t) { return t % se.interval === 0; });
        Object.keys(se).forEach(function (q) { if (q !== 'interval') se[q] = se[q].filter(function (_, x) { return keep[x]; }); });
      }
    }
  };

  // Only derived values that are recomputed before use are rounded, so a resumed world matches one that never stopped.
  function compact(w) {
    var s = w.stats;
    for (var k in s.lineages) { var L = s.lineages[k]; for (var m in L.m) L.m[m] = r3(L.m[m]); }
    return w;
  }
  function oldestLiving(w) { var s = S(w), best = null; for (var k in s.lineages) { var L = s.lineages[k]; if (!best || L.born < best.born) best = L; } return best; }
  function dayValues(D) {
    return { day: D.day, chase: D.cn ? D.cs / D.cn : null, follow: D.fn ? D.fs / D.fn : null, herd: D.hn ? D.hs / D.hn : null,
             food: D.botTicks ? D.eaten / D.botTicks * 36000 : null, pop: D.pn ? D.pop / D.pn : 0, ext: D.ext || 0,
             cache: D.meals ? D.cached / D.meals : null, share: D.meals ? D.shared / D.meals : null,
             settle: D.bn && D.bankFrac ? (D.bank / D.bn) / D.bankFrac : null };
  }
  function summary(w) {
    var s = S(w), L = s.lifespan, tm = w.config.tickMs;
    return {
      ageMs: w.tick * tm, era: s.era, extinctions: s.extinctions, alive: w.bots.length, botsBorn: s.botsBorn, births: s.births,
      deaths: s.deaths, grassSpawned: s.grassSpawned, grassEaten: s.grassEaten, grassNow: w.natural, droppedNow: w.dropped, maxGen: s.maxGen,
      avgLifeMs: L.count ? L.totalTicks / L.count * tm : 0, maxLifeMs: L.maxTicks * tm, maxLifeName: L.maxName,
      energy: s.energy, peakAlive: s.peakAlive, bySeason: s.bySeason, oldestLiving: oldestLiving(w), oldestEver: s.oldestLineage,
      lineagesAlive: Object.keys(s.lineages).length, ema: s.ema, patterns: s.patterns, daily: s.daily.map(dayValues), foodx: s.foodx
    };
  }
  return { LIMITS: LIMITS, SEASONS: SEASONS, METRICS: METRICS, PATTERNS: PATTERNS, bind: bind, create: create, hooks: hooks, event: event,
           compact: compact, summary: summary, label: label, dayValues: dayValues };
});
