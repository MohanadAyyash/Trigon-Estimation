// The IPC side of a job child process (worker.js, select-worker.js), forked by modules/drawings.js with
// --max-old-space-size and serialization 'advanced' (ArrayBuffers cross as they are).
// serve(job): on the first message from the server, sends { started: { heap_limit_mb } } (the V8 heap limit of this
// process, a test hook for the cap; sent first because a job that outgrows the cap never replies), then runs
// job(input, reply); reply(msg) sends the one answer and the process then ends.
// The process also ends when the server goes away (disconnect), so a stopped server never leaves a parse running.
const v8 = require('v8');
function serve(job) {
  if (typeof process.send !== 'function') throw new Error('run this file with child_process.fork');
  process.on('disconnect', () => process.exit(0));
  process.once('message', input => {
    process.send({ started: { heap_limit_mb: v8.getHeapStatistics().heap_size_limit / 1048576 } });
    let sent = false;
    const reply = msg => {
      if (sent) return; sent = true;
      try { process.send(msg, () => process.disconnect()); }
      catch (e) { process.exit(1); }   // no reply: the server reports the job as stopped
    };
    job(input || {}, reply);
  });
}
module.exports = { serve };
