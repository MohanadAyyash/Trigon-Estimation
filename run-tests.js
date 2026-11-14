// Runs every test-*.js in the repo root sequentially (sorted); stops on the first failure.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const files = fs.readdirSync(__dirname).filter(f => /^test-.*\.js$/.test(f)).sort();
for (const f of files) {
  console.log('> ' + f);
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`FAILED: ${f} (exit ${r.status})`); process.exit(r.status || 1); }
}
console.log(`all ${files.length} test file(s) passed`);
