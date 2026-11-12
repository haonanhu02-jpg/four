import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppConfig } from '../apps/api/dist/config.js';

function configured(overrides, check) {
  const values = {
    NODE_ENV: 'production',
    APP_ORIGIN: 'http://192.168.3.110:5001',
    COOKIE_SECURE: 'false',
    ALLOW_PRIVATE_HTTP: 'false',
    DATABASE_URL: 'postgresql://fixture:fixture@db/fixture',
    AUTH_TOKEN_SECRET: 'config-test-secret'.repeat(4),
    ...overrides,
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    check();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('production private HTTP requires explicit opt-in', () => {
  configured({}, () => assert.throws(() => new AppConfig(), /HTTPS/));
});

test('explicit private HTTP permits the deployed LAN origin and insecure cookie transport', () => {
  configured({ ALLOW_PRIVATE_HTTP: 'true' }, () => {
    const config = new AppConfig();
    assert.equal(config.appOrigin, 'http://192.168.3.110:5001');
    assert.equal(config.cookieSecure, false);
    assert.equal(config.production, true);
  });
});

test('private HTTP is limited to RFC1918 IPv4 and IPv6 unique-local addresses', () => {
  for (const host of [
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.3.110',
    '[fd00::1]',
    '[fc00::2]',
  ]) {
    configured({ ALLOW_PRIVATE_HTTP: 'true', APP_ORIGIN: `http://${host}:5001` }, () => {
      assert.doesNotThrow(() => new AppConfig());
    });
  }
  for (const host of ['172.15.255.254', '172.32.0.1', '8.8.8.8', 'example.com']) {
    configured({ ALLOW_PRIVATE_HTTP: 'true', APP_ORIGIN: `http://${host}:5001` }, () => {
      assert.throws(() => new AppConfig(), /HTTPS/);
    });
  }
});

test('private HTTP cannot bypass HTTPS cookie requirements or enable Secure cookies over HTTP', () => {
  configured({ ALLOW_PRIVATE_HTTP: 'true', COOKIE_SECURE: 'true' }, () => {
    assert.throws(() => new AppConfig(), /HTTPS/);
  });
  configured({ ALLOW_PRIVATE_HTTP: 'true', APP_ORIGIN: 'https://192.168.3.110:5001' }, () => {
    assert.throws(() => new AppConfig(), /HTTPS/);
  });
});

test('strict HTTPS and existing loopback development remain supported', () => {
  configured({ APP_ORIGIN: 'https://workbench.example.com', COOKIE_SECURE: 'true' }, () => {
    assert.doesNotThrow(() => new AppConfig());
  });
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    configured({ APP_ORIGIN: `http://${host}:5001` }, () => {
      assert.doesNotThrow(() => new AppConfig());
    });
  }
});
