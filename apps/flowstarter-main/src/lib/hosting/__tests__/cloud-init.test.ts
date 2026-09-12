import { describe, expect, it } from 'vitest';
import {
  buildCloudInit,
  getCloudInitVersion,
  ON_DEMAND_TLS_MARKER,
} from '../cloud-init';

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

  it('includes the shared secret in write_files and the ACME email in the Caddy bootstrap step', () => {
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

  it('bumps CLOUD_INIT_VERSION past the pre-fix value', () => {
    // Locks in the bump that shipped with the runcmd-ordering fix (on top of
    // the bump #102 already made for the site-domain-template change). Bump
    // this expectation forward the next time CLOUD_INIT_VERSION legitimately
    // changes — it exists so a future change to the ordering doesn't forget
    // to bump the version at all.
    expect(getCloudInitVersion()).toBe(6);
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
 * The dpkg-conffile-prompt bug: `write_files` runs before `runcmd`, so a
 * `write_files` entry at `/etc/caddy/Caddyfile` lands on disk before the
 * `caddy` package is installed. dpkg then treats it as a locally-modified
 * conffile and stops to ask a question no one can answer during unattended
 * boot, which aborts the whole apt transaction — Docker, Node, npm and the
 * Claude CLI all silently failed to install as a result, and `caddy-previews`
 * crash-looped because the package postinst that creates the `caddy` system
 * user never ran. These tests pin the fix: the Caddyfiles are written from
 * `runcmd`, after their package installs, never from `write_files`.
 */
describe('buildCloudInit — runcmd ordering', () => {
  const base = {
    deployAgentSharedSecret: 'x',
    caddyAcmeEmail: 'a@b.c',
  };

  it('never writes the base Caddyfile from write_files', () => {
    const out = buildCloudInit(base);
    const writeFilesStart = out.indexOf('\nwrite_files:');
    const runcmdStart = out.indexOf('\nruncmd:');
    expect(writeFilesStart).toBeGreaterThan(-1);
    expect(runcmdStart).toBeGreaterThan(writeFilesStart);
    const writeFilesSection = out.slice(writeFilesStart, runcmdStart);
    expect(writeFilesSection).not.toContain('- path: /etc/caddy/Caddyfile');
  });

  it('writes the base Caddyfile from runcmd only after caddy is installed', () => {
    const out = buildCloudInit(base);
    const caddyInstallIdx = out.indexOf(
      'apt-get install -y -o Dpkg::Options::=--force-confold caddy'
    );
    const caddyfileWriteIdx = out.indexOf('> /etc/caddy/Caddyfile');
    expect(caddyInstallIdx).toBeGreaterThan(-1);
    expect(caddyfileWriteIdx).toBeGreaterThan(caddyInstallIdx);
  });

  it('never writes the previews Caddyfile from write_files either', () => {
    const out = buildCloudInit({
      ...base,
      previewsDeployAgentSharedSecret: 'preview-secret',
    });
    const writeFilesStart = out.indexOf('\nwrite_files:');
    const runcmdStart = out.indexOf('\nruncmd:');
    const writeFilesSection = out.slice(writeFilesStart, runcmdStart);
    expect(writeFilesSection).not.toContain(
      '- path: /etc/caddy/previews/Caddyfile'
    );
    const caddyInstallIdx = out.indexOf(
      'apt-get install -y -o Dpkg::Options::=--force-confold caddy'
    );
    const previewsCaddyfileWriteIdx = out.indexOf(
      '> /etc/caddy/previews/Caddyfile'
    );
    expect(previewsCaddyfileWriteIdx).toBeGreaterThan(caddyInstallIdx);
  });

  it('installs caddy with --force-confold as a belt to the ordering fix', () => {
    const out = buildCloudInit(base);
    expect(out).toContain(
      'apt-get install -y -o Dpkg::Options::=--force-confold caddy'
    );
  });

  it('marks the on-demand TLS block so the existing-host installer can recognize it as the platform policy', () => {
    const out = buildCloudInit({
      ...base,
      previewsDeployAgentSharedSecret: 'preview-secret',
    });
    expect(out).toContain(ON_DEMAND_TLS_MARKER);
    // The marker must sit next to the actual directive, not float free —
    // otherwise a script grepping for it could match a stray comment.
    const markerIdx = out.indexOf(ON_DEMAND_TLS_MARKER);
    const onDemandIdx = out.indexOf('on_demand_tls {');
    expect(onDemandIdx).toBeGreaterThan(markerIdx);
    expect(onDemandIdx - markerIdx).toBeLessThan(60);
  });
});

/**
 * `cloud-init status` reports `done` once every module has run, whether or
 * not the commands inside `runcmd` actually succeeded — precisely the gap
 * that let a poisoned apt transaction leave Docker, Node and the Claude CLI
 * missing while the boot "succeeded". This self-check closes that gap: it
 * fails loudly and leaves evidence on disk when the host isn't actually
 * usable.
 */
describe('buildCloudInit — bootstrap self-check', () => {
  it('fails loudly and records the reason when the host is unhealthy', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
    });
    expect(out).toContain('flowstarter_bootstrap_fail');
    expect(out).toContain('/etc/flowstarter/bootstrap-failed');
    expect(out).toContain('exit 1');
    expect(out).toContain('command -v caddy');
    expect(out).toContain('systemctl is-active --quiet caddy');
    expect(out).toContain('command -v docker');
    expect(out).toContain('systemctl is-active --quiet docker');
    expect(out).toContain('command -v node');
  });

  it('requires the deploy-agent unit active only when an artifact was actually installed', () => {
    const withArtifact = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
      deployAgentArtifactUrl: 'https://artifacts/agent.bin',
    });
    expect(withArtifact).toContain(
      'systemctl is-active --quiet flowstarter-deploy-agent'
    );

    const withoutArtifact = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
    });
    expect(withoutArtifact).not.toContain(
      'systemctl is-active --quiet flowstarter-deploy-agent'
    );
  });

  it('also checks caddy-previews and the preview agent when previews are enabled', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
      deployAgentArtifactUrl: 'https://artifacts/agent.bin',
      previewsDeployAgentSharedSecret: 'preview-secret',
    });
    expect(out).toContain('systemctl is-active --quiet caddy-previews');
    expect(out).toContain(
      'systemctl is-active --quiet flowstarter-preview-deploy-agent'
    );
  });

  it('does not require the previews agent active when previews have no artifact yet', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
      previewsDeployAgentSharedSecret: 'preview-secret',
    });
    expect(out).toContain('systemctl is-active --quiet caddy-previews');
    expect(out).not.toContain(
      'systemctl is-active --quiet flowstarter-preview-deploy-agent'
    );
  });

  it('runs the self-check as the last runcmd step, after every install', () => {
    const out = buildCloudInit({
      deployAgentSharedSecret: 'x',
      caddyAcmeEmail: 'a@b.c',
      deployAgentArtifactUrl: 'https://artifacts/agent.bin',
    });
    const selfCheckIdx = out.indexOf('flowstarter_bootstrap_fail');
    const finalMessageIdx = out.indexOf('final_message:');
    const deployAgentEnableIdx = out.lastIndexOf(
      'systemctl enable --now flowstarter-deploy-agent'
    );
    expect(selfCheckIdx).toBeGreaterThan(deployAgentEnableIdx);
    expect(finalMessageIdx).toBeGreaterThan(selfCheckIdx);
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
    const paidCaddyfile = caddyFileBlock(out, '/etc/caddy/Caddyfile');
    const previewsCaddyfile = caddyFileBlock(
      out,
      '/etc/caddy/previews/Caddyfile'
    );

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
    const previewsCaddyfile = caddyFileBlock(
      out,
      '/etc/caddy/previews/Caddyfile'
    );
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
    const paidCaddyfile = caddyFileBlock(out, '/etc/caddy/Caddyfile');
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

/**
 * The body of one runcmd `cat <<'MARKER' > path ... MARKER` heredoc,
 * dedented. Caddyfiles now come from these runcmd heredocs, not
 * `write_files`, so the old write_files-scraping helper no longer applies.
 */
function caddyFileBlock(cloudInit: string, path: string): string {
  const redirect = `> ${path}\n`;
  const redirectIdx = cloudInit.indexOf(redirect);
  if (redirectIdx < 0) {
    throw new Error(`no runcmd heredoc write found for ${path}`);
  }
  const lineStart = cloudInit.lastIndexOf('\n', redirectIdx) + 1;
  const openingLine = cloudInit.slice(lineStart, redirectIdx + redirect.length);
  const markerMatch = openingLine.match(/<<'([A-Za-z0-9_]+)'/);
  if (!markerMatch) {
    throw new Error(`no heredoc terminator marker found for ${path}`);
  }
  const terminator = markerMatch[1];
  const bodyStart = redirectIdx + redirect.length;
  const terminatorLine = `\n    ${terminator}`;
  const endIdx = cloudInit.indexOf(terminatorLine, bodyStart);
  if (endIdx < 0) {
    throw new Error(`no heredoc terminator line found for ${path}`);
  }
  return cloudInit.slice(bodyStart, endIdx);
}
