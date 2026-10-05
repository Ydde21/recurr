import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeEnv } from '../src/replay.js';

/**
 * Environment sanitization — production credentials, proxy config, cloud
 * provider material, and socket/agent paths must never reach a replay child.
 */

const STRIPPED: Array<[string, string]> = [
  // proxies — steer egress toward internal infra
  ['HTTP_PROXY', 'http://corp-proxy:3128'],
  ['HTTPS_PROXY', 'http://corp-proxy:3128'],
  ['http_proxy', 'http://corp-proxy:3128'],
  ['NO_PROXY', 'localhost'],
  ['ALL_PROXY', 'socks5://x'],
  // cloud provider material
  ['AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI'],
  ['AWS_SESSION_TOKEN', 'tok'],
  ['AWS_PROFILE', 'prod'],
  ['AWS_ROLE_ARN', 'arn:aws:iam::1:role/x'],
  ['GOOGLE_APPLICATION_CREDENTIALS', '/keys/sa.json'],
  ['GCLOUD_PROJECT', 'prod-1'],
  ['AZURE_CLIENT_SECRET', 's'],
  ['AZURE_TENANT_ID', 't'],
  // database / service credentials
  ['DATABASE_URL', 'postgres://u:p@prod:5432/db'],
  ['PGPASSWORD', 'p'],
  ['PGPASSFILE', '~/.pgpass'],
  ['MYSQL_PWD', 'p'],
  ['MONGO_INITDB_ROOT_PASSWORD', 'p'],
  ['REDIS_PASSWORD', 'p'],
  ['CONNECTION_STRING', 'Server=prod'],
  ['DB_DSN', 'postgres://x'],
  // app secrets under varied naming
  ['STRIPE_SECRET_KEY', 'sk_live_x'],
  ['NPM_TOKEN', 'tok'],
  ['GITHUB_TOKEN', 'ghp_x'],
  ['JWT_SIGNING_KEY', 'k'],
  ['SESSION_SECRET', 's'],
  ['CSRF_TOKEN', 't'],
  ['OAUTH_CLIENT_SECRET', 's'],
  ['API_KEY', 'k'],
  ['ENCRYPTION_SALT', 's'],
  ['TLS_PRIVATE_KEY', 'k'],
  ['SSL_CERT_FILE', '/cert'],
  // agents / sockets / orchestration
  ['SSH_AUTH_SOCK', '/tmp/ssh-agent'],
  ['SSH_AGENT_PID', '123'],
  ['DOCKER_HOST', 'tcp://prod:2375'],
  ['DOCKER_CONFIG', '~/.docker'],
  ['KUBECONFIG', '~/.kube/config'],
  ['KUBERNETES_SERVICE_HOST', '10.0.0.1'],
  ['GPG_AGENT_INFO', '/tmp/gpg'],
];

const KEPT: Array<[string, string]> = [
  ['PATH', '/usr/bin'],
  ['HOME', '/home/x'],
  ['NODE_ENV', 'production'],
  ['PORT', '3000'],
  ['HOSTNAME', 'web-1'],
  ['LANG', 'en_US.UTF-8'],
  ['PWD', '/app'], // cwd hint — harmless
  ['APP_NAME', 'checkout'],
  ['LOG_LEVEL', 'info'],
  ['PAYMENT_URL', 'http://payments:8080'], // non-secret config must flow through
];

describe('sanitizeEnv', () => {
  afterEach(() => {
    delete process.env.RECURR_REPLAY_INHERIT_ENV;
  });

  it('strips credential/proxy/socket env vars', () => {
    const env = sanitizeEnv(Object.fromEntries([...STRIPPED, ...KEPT]));
    for (const [k] of STRIPPED) {
      expect(env[k], `${k} leaked into replay env`).toBeUndefined();
    }
    for (const [k, v] of KEPT) {
      expect(env[k], `${k} wrongly stripped`).toBe(v);
    }
  });

  it('RECURR_REPLAY_INHERIT_ENV=1 is an explicit opt-out that keeps everything', () => {
    process.env.RECURR_REPLAY_INHERIT_ENV = '1';
    const env = sanitizeEnv({ AWS_SECRET_ACCESS_KEY: 'x', PATH: '/bin' });
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('x');
    expect(env.PATH).toBe('/bin');
  });

  it('does not mutate the source env object', () => {
    const src = { PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'x' };
    sanitizeEnv(src);
    expect(src.AWS_SECRET_ACCESS_KEY).toBe('x');
  });
});
