import { describe, expect, it } from 'vitest';
import { buildCloudInit, getCloudInitVersion } from '../cloud-init';

describe('buildCloudInit', () => {
  it('enables Docker for both new site fleets and permits explicit legacy hosts', () => {
    const options = {
      deployAgentSharedSecret: 'paid-secret',
      previewsDeployAgentSharedSecret: 'preview-secret',
      caddyAcmeEmail: 'ops@example.com',
    };
    const docker = buildCloudInit(options);
    expect(docker.match(/DEPLOY_AGENT_SITE_RUNTIME=docker/g)).toHaveLength(2);
    const legacy = buildCloudInit({ ...options, siteRuntime: 'filesystem' });
    expect(legacy.match(/DEPLOY_AGENT_SITE_RUNTIME=filesystem/g)).toHaveLength(
      2
    );
    expect(legacy).not.toContain('DEPLOY_AGENT_SITE_RUNTIME=docker');
  });
  it('throws if shared secret is missing', () => {
    expect(() =>
      buildCloudInit({
        deployAgentSharedSecret: '',
        caddyAcmeEmail: 'ops@example.com',
      })
    ).toThrow();
  });

  it('throws if ACME email is missing', () => {
    expect(() =>
      buildCloudInit({
        deployAgentSharedSecret: 'secret',
        caddyAcmeEmail: '',
      })
    ).toThrow();
  });

  it('emits valid cloud-config header', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'shh',
      caddyAcmeEmail: 'ops@flowstarter.app',
    });
    expect(out.startsWith('#cloud-config')).toBe(true);
  });

  it('includes the shared secret + ACME email in write_files', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'super-shh',
      caddyAcmeEmail: 'ops@flowstarter.app',
      hostname: 'caddy-fra-01',
    });
    expect(out).toContain('DEPLOY_AGENT_SHARED_SECRET=super-shh');
    expect(out).toContain('email ops@flowstarter.app');
    expect(out).toContain('hostname: caddy-fra-01');
  });

  it('includes ssh keys when provided', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
      sshAuthorizedKeys: ['ssh-ed25519 AAAA test@host'],
    });
    expect(out).toContain('ssh-ed25519 AAAA test@host');
  });

  it('disables agent when no artifact url', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
    });
    expect(out).toContain('disabled (no artifact url)');
    expect(out).not.toContain('flowstarter-deploy-agent\n  - chmod +x');
    expect(out).not.toContain(
      'systemctl enable --now flowstarter-deploy-agent'
    );
  });

  it('downloads + enables agent when artifact url provided', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
      deployAgentArtifactUrl: 'https://artifacts.flowstarter.app/agent-v1.bin',
    });
    expect(out).toContain('agent-v1.bin');
    expect(out).toContain('/usr/local/bin/flowstarter-deploy-agent');
    expect(out).toContain('systemctl enable --now flowstarter-deploy-agent');
  });

  it('embeds the cloud_init_version label', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
    });
    expect(out).toContain(`cloud_init_version=${getCloudInitVersion()}`);
  });

  it('gives the paid agent the final hostname template, not a preview one', () => {
    // A host provisioned without it writes an empty Caddy snippet for any
    // workspace with no custom domain, and the deploy reports success for a
    // site nobody can open. The default is the platform domain for this
    // environment, so an operator has to do nothing to get a working host.
    const out = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
    });
    expect(out).toContain(
      'DEPLOY_AGENT_SITE_DOMAIN_TEMPLATE={slug}.flowstarter.dev'
    );
    expect(out).not.toContain(
      'DEPLOY_AGENT_SITE_DOMAIN_TEMPLATE={slug}.preview.'
    );
  });

  it('lets an operator override the site domain template', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
      siteDomainTemplate: '{slug}.sites.example.com',
    });
    expect(out).toContain(
      'DEPLOY_AGENT_SITE_DOMAIN_TEMPLATE={slug}.sites.example.com'
    );
  });
});

/**
 * The previews half of the host.
 *
 * The whole point of a second agent and a second Caddy is blast radius: a
 * malformed snippet generated from an LLM-authored preview must be able to
 * take down previews and nothing else. Caddy refuses to load a config with a
 * bad import, so that guarantee holds only if the paid-site config never
 * imports anything the previews agent can write. That is what the "separate
 * import globs" case below is actually checking.
 */
describe('buildCloudInit — previews stack', () => {
  const base = {
    deployAgentSharedSecret: 'paid-secret',
    caddyAcmeEmail: 'ops@flowstarter.net',
    deployAgentArtifactUrl: 'https://artifacts/agent.bin',
  };

  it('emits nothing about previews unless a previews secret is given', () => {
    const out = buildCloudInit(base);
    expect(out).not.toContain('/var/www/previews');
    expect(out).not.toContain('/etc/caddy/previews');
    expect(out).not.toContain('caddy-previews');
    expect(out).not.toContain('DEPLOY_AGENT_MODE=previews');
    expect(out).not.toContain('on_demand_tls');
  });

  it('emits both agents, each with its own secret, port and roots', () => {
    const out = buildCloudInit({
      ...base,
      previewsDeployAgentSharedSecret: 'previews-secret',
    });
    // Paid agent: unchanged.
    expect(out).toContain('DEPLOY_AGENT_SHARED_SECRET=paid-secret');
    expect(out).toContain('DEPLOY_AGENT_PORT=8443');
    // Previews agent: a different everything.
    expect(out).toContain('DEPLOY_AGENT_SHARED_SECRET=previews-secret');
    expect(out).toContain('DEPLOY_AGENT_PORT=8444');
    expect(out).toContain('DEPLOY_AGENT_MODE=previews');
    expect(out).toContain('DEPLOY_AGENT_SITES_ROOT=/var/www/previews');
    expect(out).toContain(
      'DEPLOY_AGENT_CADDY_SITES_DIR=/etc/caddy/previews/sites'
    );
    expect(out).toContain(
      'DEPLOY_AGENT_CADDY_RELOAD_CMD=systemctl reload caddy-previews'
    );
  });

  it('gives the two Caddy instances SEPARATE import globs', () => {
    const out = buildCloudInit({
      ...base,
      previewsDeployAgentSharedSecret: 'previews-secret',
    });
    const paidCaddyfile = fileBlock(out, '/etc/caddy/Caddyfile');
    const previewsCaddyfile = fileBlock(out, '/etc/caddy/previews/Caddyfile');

    expect(paidCaddyfile).toContain('import /etc/caddy/sites/*.caddy');
    expect(previewsCaddyfile).toContain(
      'import /etc/caddy/previews/sites/*.caddy'
    );

    // The load-bearing assertion: the paid config cannot import a previews
    // snippet, so a preview snippet that does not parse cannot fail the load
    // of the config serving paying customers.
    const paidImports = (paidCaddyfile.match(/^\s*import .*$/gm) ?? []).map(
      (l) => l.trim()
    );
    expect(paidImports).toEqual(['import /etc/caddy/sites/*.caddy']);
    for (const glob of paidImports) {
      expect(glob).not.toContain('previews');
    }
    // ...and vice versa.
    const previewImports = (
      previewsCaddyfile.match(/^\s*import .*$/gm) ?? []
    ).map((l) => l.trim());
    expect(previewImports).toEqual([
      'import /etc/caddy/previews/sites/*.caddy',
    ]);
  });

  it('runs previews Caddy as its own service on its own ports', () => {
    const out = buildCloudInit({
      ...base,
      previewsDeployAgentSharedSecret: 'previews-secret',
    });
    expect(out).toContain('/etc/systemd/system/caddy-previews.service');
    expect(out).toContain('systemctl enable --now caddy-previews');
    const previewsCaddyfile = fileBlock(out, '/etc/caddy/previews/Caddyfile');
    expect(previewsCaddyfile).toContain('http_port 9080');
    expect(previewsCaddyfile).toContain('https_port 9443');
    // TLS is terminated by the front Caddy; this instance must not try to
    // fight it for :443 or ask Let's Encrypt for anything.
    expect(previewsCaddyfile).toContain('auto_https off');
    expect(previewsCaddyfile).toContain('admin 127.0.0.1:2020');
    expect(previewsCaddyfile).toContain('default_bind 127.0.0.1');
    expect(out).toContain('--address 127.0.0.1:2020 --force');
  });

  it('serves the preview zone through one static, never-generated block', () => {
    const out = buildCloudInit({
      ...base,
      previewsDeployAgentSharedSecret: 'previews-secret',
      previewsHostSuffix: 'preview.flowstarter.net',
    });
    const paidCaddyfile = fileBlock(out, '/etc/caddy/Caddyfile');
    expect(paidCaddyfile).toContain('*.preview.flowstarter.net {');
    expect(paidCaddyfile).toContain('reverse_proxy 127.0.0.1:9080');
    expect(paidCaddyfile).toContain(
      'header X-Robots-Tag "noindex, nofollow, noarchive"'
    );
    // On-demand certificates, gated on the previews agent confirming it
    // actually serves the hostname — otherwise anybody pointing DNS here
    // makes us mint certificates for them.
    expect(paidCaddyfile).toContain('on_demand_tls');
    expect(paidCaddyfile).toContain('ask http://127.0.0.1:8444/tls-ask');
    expect(paidCaddyfile).toContain('on_demand');
  });

  it('honours a custom preview zone', () => {
    const out = buildCloudInit({
      ...base,
      previewsDeployAgentSharedSecret: 'previews-secret',
      previewsHostSuffix: 'demo.example.dev',
    });
    expect(out).toContain('*.demo.example.dev {');
    expect(out).toContain('DEPLOY_AGENT_PREVIEW_HOST_SUFFIX=demo.example.dev');
  });

  it('starts the second agent instance from the second env file', () => {
    const out = buildCloudInit({
      ...base,
      previewsDeployAgentSharedSecret: 'previews-secret',
    });
    expect(out).toContain(
      'EnvironmentFile=/etc/flowstarter/preview-deploy-agent.env'
    );
    expect(out).toContain(
      'systemctl enable --now flowstarter-preview-deploy-agent'
    );
    // Same binary — this is one agent built twice, not two codebases.
    expect(
      out.match(/ExecStart=\/usr\/local\/bin\/flowstarter-deploy-agent/g)
    ).toHaveLength(2);
  });

  it('keeps the previews env file root-only', () => {
    const out = buildCloudInit({
      ...base,
      previewsDeployAgentSharedSecret: 'previews-secret',
    });
    const index = out.indexOf('/etc/flowstarter/preview-deploy-agent.env');
    expect(out.slice(index, index + 800)).toContain("permissions: '0600'");
  });
});

/** The `content: |` body of one write_files entry, dedented. */
function fileBlock(cloudInit: string, path: string): string {
  const start = cloudInit.indexOf(`  - path: ${path}\n`);
  if (start < 0) throw new Error(`no write_files entry for ${path}`);
  const rest = cloudInit.slice(start);
  const end = rest.indexOf('\n    owner:');
  return rest.slice(0, end < 0 ? undefined : end);
}
