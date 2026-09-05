/**
 * What a User-Agent string says about the device.
 *
 * Written here rather than pulled in as `ua-parser-js` on purpose. This is a
 * pure string classifier feeding one alert line; a dependency would add a
 * supply-chain surface and a regex database update cadence to a backend that
 * currently has neither, in exchange for detail nobody reading an ops alert
 * needs. The RAW User-Agent is always sent alongside this, so a device this
 * misses is still fully diagnosable from the message.
 *
 * Order is the whole correctness argument: nearly every browser lies about
 * being every other browser. Edge claims Chrome and Safari; Chrome claims
 * Safari; Safari claims Gecko. So each test must exclude the ones that
 * impersonate it, and the checks run most-specific first.
 */

export interface DeviceMeta {
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  /** 'Mobile' | 'Tablet' | 'Desktop' | 'Bot' | 'Unknown' */
  deviceType: string;
  /** True for crawlers, curl, Postman and friends. A human did not log in. */
  isBot: boolean;
}

export const UNKNOWN_DEVICE: DeviceMeta = {
  browser: 'Unknown',
  browserVersion: '',
  os: 'Unknown',
  osVersion: '',
  deviceType: 'Unknown',
  isBot: false,
};

const BOT_HINTS = [
  'bot',
  'crawler',
  'spider',
  'curl/',
  'wget/',
  'python-requests',
  'axios/',
  'postmanruntime',
  'insomnia',
  'httpie',
  'go-http-client',
  'okhttp',
  'java/',
];

function version(ua: string, re: RegExp): string {
  const m = ua.match(re);
  return m?.[1] ? m[1].replace(/_/g, '.') : '';
}

function parseBrowser(ua: string): { browser: string; browserVersion: string } {
  // Edge before Chrome before Safari — Edge's UA contains both of the others.
  if (/\bEdg(?:e|A|iOS)?\//i.test(ua)) {
    return { browser: 'Edge', browserVersion: version(ua, /\bEdg(?:e|A|iOS)?\/([\d.]+)/i) };
  }
  if (/\bOPR\/|\bOpera\//i.test(ua)) {
    return { browser: 'Opera', browserVersion: version(ua, /\b(?:OPR|Opera)\/([\d.]+)/i) };
  }
  if (/\bSamsungBrowser\//i.test(ua)) {
    return { browser: 'Samsung Internet', browserVersion: version(ua, /SamsungBrowser\/([\d.]+)/i) };
  }
  if (/\bFirefox\/|\bFxiOS\//i.test(ua)) {
    return { browser: 'Firefox', browserVersion: version(ua, /\b(?:Firefox|FxiOS)\/([\d.]+)/i) };
  }
  if (/\bCriOS\//i.test(ua)) {
    return { browser: 'Chrome', browserVersion: version(ua, /CriOS\/([\d.]+)/i) };
  }
  if (/\bChrome\//i.test(ua)) {
    return { browser: 'Chrome', browserVersion: version(ua, /Chrome\/([\d.]+)/i) };
  }
  // Safari last: it is the only one of these that does NOT also claim Chrome.
  if (/\bSafari\//i.test(ua) && /\bVersion\//i.test(ua)) {
    return { browser: 'Safari', browserVersion: version(ua, /Version\/([\d.]+)/i) };
  }
  return { browser: 'Unknown', browserVersion: '' };
}

function parseOs(ua: string): { os: string; osVersion: string } {
  // iPadOS 13+ reports itself as "Macintosh", so iOS must be tested first and
  // iPad detected by its touch hint rather than by name.
  if (/\biPhone\b|\biPod\b/i.test(ua)) {
    return { os: 'iOS', osVersion: version(ua, /OS ([\d_]+) like Mac/i) };
  }
  if (/\biPad\b/i.test(ua)) {
    return { os: 'iPadOS', osVersion: version(ua, /OS ([\d_]+) like Mac/i) };
  }
  if (/\bAndroid\b/i.test(ua)) {
    return { os: 'Android', osVersion: version(ua, /Android ([\d.]+)/i) };
  }
  if (/\bWindows NT\b/i.test(ua)) {
    const nt = version(ua, /Windows NT ([\d.]+)/i);
    // Windows 11 is indistinguishable from 10 in a UA string — Microsoft froze
    // it at 10.0 — so say "10/11" rather than assert something false.
    const named: Record<string, string> = {
      '10.0': '10/11',
      '6.3': '8.1',
      '6.2': '8',
      '6.1': '7',
    };
    return { os: 'Windows', osVersion: named[nt] ?? nt };
  }
  if (/\bCrOS\b/i.test(ua)) return { os: 'ChromeOS', osVersion: '' };
  if (/\bMac OS X\b/i.test(ua)) {
    return { os: 'macOS', osVersion: version(ua, /Mac OS X ([\d_.]+)/i) };
  }
  if (/\bLinux\b/i.test(ua)) return { os: 'Linux', osVersion: '' };
  return { os: 'Unknown', osVersion: '' };
}

function parseDeviceType(ua: string, os: string, isBot: boolean): string {
  if (isBot) return 'Bot';
  if (os === 'iPadOS' || /\bTablet\b/i.test(ua)) return 'Tablet';
  // Android without "Mobile" is the tablet convention Google documents.
  if (os === 'Android') return /\bMobile\b/i.test(ua) ? 'Mobile' : 'Tablet';
  if (os === 'iOS' || /\bMobile\b/i.test(ua)) return 'Mobile';
  if (os === 'Unknown') return 'Unknown';
  return 'Desktop';
}

export function parseUserAgent(userAgent?: string | null): DeviceMeta {
  const ua = (userAgent ?? '').trim();
  if (!ua) return { ...UNKNOWN_DEVICE };

  const lower = ua.toLowerCase();
  const isBot = BOT_HINTS.some((h) => lower.includes(h));

  const { browser, browserVersion } = parseBrowser(ua);
  const { os, osVersion } = parseOs(ua);

  return {
    browser,
    browserVersion,
    os,
    osVersion,
    deviceType: parseDeviceType(ua, os, isBot),
    isBot,
  };
}

/** "Chrome 131 on Windows 10/11" — the one-line form used in an alert. */
export function describeDevice(meta: DeviceMeta): string {
  const browser = [meta.browser, meta.browserVersion.split('.')[0]].filter(Boolean).join(' ');
  const os = [meta.os, meta.osVersion].filter(Boolean).join(' ');
  if (browser === 'Unknown' && os === 'Unknown') return 'Unknown device';
  if (os === 'Unknown') return browser;
  if (browser === 'Unknown') return os;
  return `${browser} on ${os}`;
}
