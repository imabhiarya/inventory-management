// Turns a mongodb+srv:// connection string into a plain mongodb:// one by looking up the
// cluster's SRV and TXT records ourselves. Many home/office routers and ISP DNS servers time
// out on SRV lookups ("querySrv ETIMEOUT"), so this tries, in order:
//   1. the computer's own DNS
//   2. public DNS servers (Google, Cloudflare) over normal DNS
//   3. DNS-over-HTTPS (port 443), which works even where port 53 to outside servers is blocked
const dns = require('node:dns');

const TIMEOUT = 5000;
const withTimeout = (p, ms = TIMEOUT) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('DNS lookup timed out')), ms))]);

const normalise = (records) => ({
  srv: records.srv.map((r) => ({ name: r.name.replace(/\.$/, ''), port: r.port })),
  txt: records.txt,
});

async function viaResolver(resolver, name, host) {
  const [srv, txt] = await Promise.all([
    withTimeout(resolver.resolveSrv(name)),
    withTimeout(resolver.resolveTxt(host)).catch(() => []),
  ]);
  return normalise({ srv, txt: txt.map((parts) => parts.join('')) });
}

async function viaDoh(url, name, host) {
  const get = async (n, type) => {
    const res = await withTimeout(
      fetch(`${url}?name=${encodeURIComponent(n)}&type=${type}`, { headers: { accept: 'application/dns-json' } }),
    );
    if (!res.ok) throw new Error(`DNS-over-HTTPS HTTP ${res.status}`);
    return ((await res.json()).Answer || []).filter((a) => a.type === (type === 'SRV' ? 33 : 16)).map((a) => a.data);
  };
  const [srv, txt] = await Promise.all([get(name, 'SRV'), get(host, 'TXT').catch(() => [])]);
  return normalise({
    srv: srv.map((d) => {
      const [, , port, target] = d.trim().split(/\s+/);
      return { name: target, port: Number(port) };
    }),
    txt: txt.map((d) => d.replace(/^"|"$/g, '').replace(/"\s*"/g, '')),
  });
}

async function lookup(host) {
  const name = `_mongodb._tcp.${host}`;
  const publicDns = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
  publicDns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1']);
  const attempts = [
    ['system DNS', () => viaResolver(dns.promises, name, host)],
    ['public DNS', () => viaResolver(publicDns, name, host)],
    ['Google DNS-over-HTTPS', () => viaDoh('https://dns.google/resolve', name, host)],
    ['Cloudflare DNS-over-HTTPS', () => viaDoh('https://cloudflare-dns.com/dns-query', name, host)],
  ];
  const errors = [];
  for (const [label, fn] of attempts) {
    try {
      const r = await fn();
      if (r.srv.length) return r;
      errors.push(`${label}: no records`);
    } catch (err) {
      errors.push(`${label}: ${err.code || err.message}`);
    }
  }
  const err = new Error(`Could not look up the Atlas cluster address ${host} (${errors.join('; ')}).`);
  err.name = 'DnsLookupError'; // treated as "offline" by the sync
  throw err;
}

/** Returns a mongodb:// URI equivalent to the given mongodb+srv:// URI (others are returned unchanged). */
async function resolveSrvUri(uri) {
  const m = /^mongodb\+srv:\/\/(?:([^@/]*)@)?([^/?,]+)(\/[^?]*)?(?:\?(.*))?$/.exec(uri.trim());
  if (!m) return uri;
  const [, creds, host, pathPart, query] = m;
  const { srv, txt } = await lookup(host);

  // Like the official driver: every server must be inside the cluster's own domain.
  const domain = host.split('.').slice(1).join('.');
  for (const s of srv) {
    if (!s.name.endsWith(`.${domain}`)) throw new Error(`Unexpected server ${s.name} in the DNS records of ${host}`);
  }

  const params = new URLSearchParams(query || '');
  for (const record of txt) {
    for (const [k, v] of new URLSearchParams(record)) {
      if (['authSource', 'replicaSet', 'loadBalanced'].includes(k) && !params.has(k)) params.set(k, v);
    }
  }
  if (!params.has('tls') && !params.has('ssl')) params.set('tls', 'true');

  const hosts = srv.map((s) => `${s.name}:${s.port}`).join(',');
  return `mongodb://${creds ? `${creds}@` : ''}${hosts}${pathPart || '/'}?${params}`;
}

module.exports = { resolveSrvUri };
