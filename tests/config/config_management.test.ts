import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager, ConfigValidator, mainSchema } from '../../src/config';

async function main() {
  const validator = new ConfigValidator(mainSchema);
  const valid = validator.validate({
    db: { host: 'localhost', port: 5432, user: 'verinode', password: '', database: 'verinode' },
    app: { port: 3000, environment: 'production', logLevel: 'info' },
    feature_flags: { overrides: { payouts: 'degraded' } },
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.data.capacity_shedding.enabled, true);

  const invalid = validator.validate({
    db: { host: 'localhost', port: 70000, user: 'verinode', password: '', database: 'verinode' },
    app: { port: 3000, environment: 'staging', logLevel: 'info' },
    feature_flags: { overrides: { payouts: 'maybe' } },
  });
  assert.equal(invalid.valid, false);
  assert(invalid.errors.some(e => e.path === 'db.port'));
  assert(invalid.errors.some(e => e.path === 'app.environment'));
  assert(invalid.errors.some(e => e.path.includes('payouts')));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verinode-config-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ app: { port: 3001 } }));

  const manager = new ConfigManager(mainSchema);
  await manager.initialize({ configFile });
  assert.equal(manager.getIn('app.port'), 3001);

  let observedPort = 0;
  manager.onChangePath('app.port', value => { observedPort = value; }, 'test-port-watch');
  manager.update('app.port', 3002);
  assert.equal(observedPort, 3002);
  assert.throws(() => manager.update('app.port', 70000), /Configuration validation failed/);
  manager.cleanup();

  console.log('config_management tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
