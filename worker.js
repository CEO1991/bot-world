/* Catch-up worker: advances a saved world to the shared "now" off the main thread, reporting progress.
 * Same sim.js/stats.js as the page, so the result is identical to catching up on the main thread. */
importScripts('stats.js?v=8', 'sim.js?v=8');
self.onmessage = function (e) {
  var w = self.BotSim.deserialize(e.data.state), start = w.tick;
  function chunk() {
    var target = self.BotSim.tickAt(w, Date.now());
    self.BotSim.advanceToTick(w, target, 20000);
    if (w.tick < self.BotSim.tickAt(w, Date.now()) - 2) {
      postMessage({ type: 'progress', done: w.tick - start, total: target - start });
      setTimeout(chunk, 0);
    } else postMessage({ type: 'done', state: self.BotSim.serialize(w) });
  }
  chunk();
};
