import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface IpGeo {
  country?: string;
  region?: string;
  city?: string;
  isp?: string;
  /** Autonomous system, e.g. "AS15169 Google LLC". */
  asn?: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

/**
 * Optional country/city/ISP for a login IP.
 *
 * Three properties this MUST have, because it sits on the login path:
 *
 *  1. It never throws and never blocks for long — 3 s timeout, and a failure
 *     resolves to null so the alert still goes out without the geo line.
 *  2. Private, loopback and link-local addresses are answered locally. Sending
 *     10.x to a third party leaks the internal topology and gets nothing back.
 *  3. Results are cached for a day. An office of 200 people logging in from one
 *     NAT address is one lookup, not two hundred — which also keeps the free
 *     tier's per-minute limit out of the picture.
 *
 * The endpoint is a setting (`telegram.geoLookupUrl`) because this is the one
 * part of the feature that sends data to somebody else, and an operator has to
 * be able to point it at their own service or turn it off entirely.
 */
@Injectable()
export class IpGeoService {
  private readonly logger = new Logger(IpGeoService.name);
  private readonly cache = new Map<string, { at: number; geo: IpGeo | null }>();

  async lookup(ip: string | null | undefined, urlTemplate: string): Promise<IpGeo | null> {
    const addr = (ip ?? '').trim();
    if (!addr || isPrivateAddress(addr)) return null;

    const hit = this.cache.get(addr);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.geo;

    let geo: IpGeo | null = null;
    try {
      const url = urlTemplate.replace('{ip}', encodeURIComponent(addr));
      const { data } = await axios.get<Record<string, any>>(url, { timeout: 3_000 });
      // ip-api.com's shape, with the commonest alternatives accepted so a
      // different provider in the setting mostly just works.
      if (data && data.status !== 'fail') {
        geo = {
          country: str(data.country ?? data.country_name),
          region: str(data.regionName ?? data.region),
          city: str(data.city),
          isp: str(data.isp ?? data.org),
          asn: str(data.as ?? data.asn),
        };
        if (!geo.country && !geo.city && !geo.isp) geo = null;
      }
    } catch (e) {
      // Debug, not warn: an unreachable geo service is an expected condition on
      // an air-gapped deployment, and a warn per login would be noise.
      this.logger.debug(`IP geolocation failed for ${addr}: ${(e as Error).message}`);
      geo = null;
    }

    this.remember(addr, geo);
    return geo;
  }

  /** "Chennai, Tamil Nadu, India · Jio (AS55836)" */
  static describe(geo: IpGeo | null): string {
    if (!geo) return '';
    const place = [geo.city, geo.region, geo.country].filter(Boolean).join(', ');
    const net = geo.isp || geo.asn ? [geo.isp, geo.asn && `(${geo.asn})`].filter(Boolean).join(' ') : '';
    return [place, net].filter(Boolean).join(' · ');
  }

  private remember(addr: string, geo: IpGeo | null): void {
    // Plain FIFO eviction. An LRU would need bookkeeping on every read for a
    // cache this small; the eviction cost of getting it wrong is one HTTP call.
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(addr, { at: Date.now(), geo });
  }
}

function str(v: unknown): string | undefined {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || undefined;
}

/**
 * RFC 1918 / loopback / link-local / CGNAT / unique-local, v4 and v6.
 *
 * Anything unparseable counts as private: refusing to look up an address we do
 * not understand fails towards not leaking it.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  if (!addr) return true;
  if (addr === '::1' || addr === 'localhost' || addr === 'unknown') return true;
  // IPv4-mapped IPv6, e.g. ::ffff:10.0.0.1
  const mapped = addr.startsWith('::ffff:') ? addr.slice(7) : addr;

  const v4 = mapped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    // 100.64.0.0/10 — carrier-grade NAT, not routable to a geo service either.
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (mapped.includes(':')) {
    // fc00::/7 unique-local, fe80::/10 link-local.
    if (/^f[cd]/.test(mapped) || mapped.startsWith('fe80')) return true;
    return false;
  }

  return true;
}
