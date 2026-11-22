import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Session } from 'electron'

export const GOOGLE_OAUTH_URL_PATTERNS = [
  '*://*.google.com/*',
  '*://google.com/*',
  '*://*.youtube.com/*',
  '*://youtube.com/*',
  '*://*.gstatic.com/*',
  '*://*.googleapis.com/*',
  '*://*.googleusercontent.com/*'
] as const

export const GOOGLE_OAUTH_PRELOAD_ID = 'botark-google-oauth-ua-guard-v1'
const PRELOAD_FILENAME = 'google-oauth-ua-preload-v1.cjs'
const DEFAULT_CHROME_VERSION = '136.0.0.0'

const guardedSessions = new WeakSet<object>()

export interface GooglePlatformHint {
  header: '"Windows"' | '"macOS"' | '"Linux"'
  uaDataPlatform: 'Windows' | 'macOS' | 'Linux'
  uaOsSegment: string
}

export function resolvePlatformHint(platform: NodeJS.Platform = process.platform): GooglePlatformHint {
  if (platform === 'win32') {
    return {
      header: '"Windows"',
      uaDataPlatform: 'Windows',
      uaOsSegment: 'Windows NT 10.0; Win64; x64'
    }
  }
  if (platform === 'darwin') {
    return {
      header: '"macOS"',
      uaDataPlatform: 'macOS',
      uaOsSegment: 'Macintosh; Intel Mac OS X 10_15_7'
    }
  }
  return {
    header: '"Linux"',
    uaDataPlatform: 'Linux',
    uaOsSegment: 'X11; Linux x86_64'
  }
}

export function inferPlatformFromUa(
  ua: string,
  fallbackPlatform: NodeJS.Platform = process.platform
): NodeJS.Platform {
  if (/Windows NT/i.test(ua)) return 'win32'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'darwin'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return fallbackPlatform
}

function normalizeChromeVersion(chromeVersion = process.versions?.chrome): string {
  return chromeVersion && /^\d+(\.\d+)*$/.test(chromeVersion) ? chromeVersion : DEFAULT_CHROME_VERSION
}

export function cleanChromeUserAgentForGoogle(
  rawUa: string,
  chromeVersion = process.versions?.chrome,
  platform: NodeJS.Platform = process.platform
): string {
  const cleaned = rawUa
    .replace(/(?:^|\s+)Electron\/[^\s]+/gi, '')
    .replace(/(?:^|\s+)(?:BotArk|BotHub)\/[^\s]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (/Chrome\/[\d.]+/i.test(cleaned)) return cleaned
  const ver = normalizeChromeVersion(chromeVersion)
  const { uaOsSegment } = resolvePlatformHint(platform)
  return `Mozilla/5.0 (${uaOsSegment}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`
}

export interface ChromeClientHints {
  major: string
  full: string
  secChUa: string
  secChUaFullVersionList: string
  secChUaPlatform: '"Windows"' | '"macOS"' | '"Linux"'
  uaDataPlatform: 'Windows' | 'macOS' | 'Linux'
  brands: Array<{ brand: string; version: string }>
  fullVersionList: Array<{ brand: string; version: string }>
}

export function buildChromeClientHints(
  chromeVersion = process.versions?.chrome,
  platform: NodeJS.Platform = process.platform
): ChromeClientHints {
  const full = normalizeChromeVersion(chromeVersion)
  const major = full.split('.')[0] || '136'
  const { header, uaDataPlatform } = resolvePlatformHint(platform)
  return {
    major,
    full,
    secChUa: `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`,
    secChUaFullVersionList: `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not-A.Brand";v="99.0.0.0"`,
    secChUaPlatform: header,
    uaDataPlatform,
    brands: [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not-A.Brand', version: '99' }
    ],
    fullVersionList: [
      { brand: 'Chromium', version: full },
      { brand: 'Google Chrome', version: full },
      { brand: 'Not-A.Brand', version: '99.0.0.0' }
    ]
  }
}

export function sanitizeGoogleRequestHeaders(
  requestHeaders: Record<string, string>,
  chromeVersion = process.versions?.chrome,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const next = { ...requestHeaders }

  let existingUaKey: string | undefined
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'user-agent') {
      existingUaKey = key
      break
    }
  }
  const cleanedUa = cleanChromeUserAgentForGoogle(
    existingUaKey ? (next[existingUaKey] ?? '') : '',
    chromeVersion,
    platform
  )
  const effectivePlatform = inferPlatformFromUa(cleanedUa, platform)
  const hints = buildChromeClientHints(chromeVersion, effectivePlatform)

  let sawUaKey = false
  let sawSecChUa = false
  let sawPlatform = false
  for (const key of Object.keys(next)) {
    const lower = key.toLowerCase()
    if (lower === 'user-agent') {
      next[key] = cleanedUa
      sawUaKey = true
    } else if (lower === 'sec-ch-ua') {
      next[key] = hints.secChUa
      sawSecChUa = true
    } else if (lower === 'sec-ch-ua-full-version-list') {
      next[key] = hints.secChUaFullVersionList
    } else if (lower === 'sec-ch-ua-platform') {
      next[key] = hints.secChUaPlatform
      sawPlatform = true
    } else if (lower === 'sec-ch-ua-mobile') {
      next[key] = '?0'
    }
  }
  if (!sawUaKey) {
    next['User-Agent'] = cleanedUa
  }
  if (!sawSecChUa) {
    next['Sec-CH-UA'] = hints.secChUa
  }
  if (!sawPlatform) {
    next['Sec-CH-UA-Platform'] = hints.secChUaPlatform
  }
  return next
}

/**
 * Build the pure main-world JavaScript snippet that normalizes `navigator.userAgent`,
 * `navigator.appVersion`, `navigator.userAgentData`, and `navigator.webdriver` strictly
 * on Google OAuth origins (never on non-Google / Cloudflare Turnstile pages).
 */
export function buildGoogleOAuthMainWorldPatchScript(
  chromeVersion = process.versions?.chrome,
  platform: NodeJS.Platform = process.platform
): string {
  const hints = buildChromeClientHints(chromeVersion, platform)
  const fallbackUa = cleanChromeUserAgentForGoogle('', chromeVersion, platform)

  return `(() => {
  try {
    var loc = typeof location !== 'undefined' ? location : null;
    var host = (loc && typeof loc.hostname === 'string' ? loc.hostname : '').toLowerCase();
    var proto = (loc && typeof loc.protocol === 'string' ? loc.protocol : '').toLowerCase();
    var isGoogleHost = /(?:^|\\.)(?:google\\.com|youtube\\.com|gstatic\\.com|googleapis\\.com|googleusercontent\\.com)$/i.test(host);
    var isOpaqueChild = !host && (proto === 'about:' || proto === 'blob:' || proto === 'data:');
    if (!isGoogleHost && !isOpaqueChild) return;

    var nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav) return;
    var MARK = Symbol.for('botark.googleOAuthUaPatched');
    if (nav[MARK]) return;
    try {
      Object.defineProperty(nav, MARK, { value: true, configurable: false, enumerable: false });
    } catch (_) {}

    var FALLBACK_UA = ${JSON.stringify(fallbackUa)};
    var rawUa = typeof nav.userAgent === 'string' ? nav.userAgent : '';
    var stripped = rawUa
      .replace(/\\s+Electron\\/[^\\s]+/gi, '')
      .replace(/\\s+(?:BotArk|BotHub)\\/[^\\s]+/gi, '')
      .replace(/\\s{2,}/g, ' ')
      .trim();
    var cleanUa = /Chrome\\/[\\d.]+/i.test(stripped) ? stripped : FALLBACK_UA;
    var cleanAppVersion = cleanUa.replace(/^Mozilla\\//, '');

    var BRANDS = ${JSON.stringify(hints.brands)};
    var FULL_LIST = ${JSON.stringify(hints.fullVersionList)};
    var UA_PLATFORM = ${JSON.stringify(hints.uaDataPlatform)};
    var UA_FULL = ${JSON.stringify(hints.full)};

    var origUaData = nav.userAgentData;
    var patchedUaData;
    try {
      var protoObj = origUaData && typeof origUaData === 'object' ? Object.getPrototypeOf(origUaData) : Object.prototype;
      patchedUaData = Object.create(protoObj || Object.prototype);
    } catch (_) {
      patchedUaData = {};
    }

    var defineVal = function(target, prop, getterOrVal, isGetter) {
      try {
        Object.defineProperty(
          target,
          prop,
          isGetter
            ? { get: getterOrVal, enumerable: true, configurable: true }
            : { value: getterOrVal, enumerable: true, configurable: true }
        );
        return true;
      } catch (_) {
        return false;
      }
    };

    defineVal(patchedUaData, 'brands', function() { return BRANDS.map(function(b) { return { brand: b.brand, version: b.version }; }); }, true);
    defineVal(patchedUaData, 'mobile', function() { return false; }, true);
    defineVal(patchedUaData, 'platform', function() { return UA_PLATFORM; }, true);
    defineVal(patchedUaData, 'toJSON', function() {
      return {
        brands: BRANDS.map(function(b) { return { brand: b.brand, version: b.version }; }),
        mobile: false,
        platform: UA_PLATFORM
      };
    }, false);
    defineVal(patchedUaData, 'getHighEntropyValues', function(requestedHints) {
      var list = Array.isArray(requestedHints) ? requestedHints : [];
      var basePromise;
      try {
        if (origUaData && typeof origUaData.getHighEntropyValues === 'function') {
          basePromise = Promise.resolve(origUaData.getHighEntropyValues(list)).catch(function() { return {}; });
        } else {
          basePromise = Promise.resolve({});
        }
      } catch (_) {
        basePromise = Promise.resolve({});
      }
      return basePromise.then(function(base) {
        var out = Object.assign({}, base || {}, {
          brands: BRANDS.map(function(b) { return { brand: b.brand, version: b.version }; }),
          mobile: false,
          platform: UA_PLATFORM
        });
        if (list.indexOf('fullVersionList') >= 0) {
          out.fullVersionList = FULL_LIST.map(function(b) { return { brand: b.brand, version: b.version }; });
        }
        if (list.indexOf('uaFullVersion') >= 0) {
          out.uaFullVersion = UA_FULL;
        }
        return out;
      });
    }, false);

    var navProto = typeof Navigator !== 'undefined' && Navigator.prototype ? Navigator.prototype : null;
    var defineOnNav = function(prop, getter) {
      if (!navProto || !defineVal(navProto, prop, getter, true)) {
        defineVal(nav, prop, getter, true);
      }
    };
    defineOnNav('userAgent', function() { return cleanUa; });
    defineOnNav('appVersion', function() { return cleanAppVersion; });
    defineOnNav('webdriver', function() { return false; });
    defineOnNav('userAgentData', function() { return patchedUaData; });
  } catch (_) {}
})();`
}

export function buildGoogleOAuthPreloadScriptSource(
  chromeVersion = process.versions?.chrome,
  platform: NodeJS.Platform = process.platform
): string {
  const mainWorldScript = buildGoogleOAuthMainWorldPatchScript(chromeVersion, platform)
  return `'use strict';
try {
  var electronMod = require('electron');
  var webFrame = electronMod && electronMod.webFrame;
  if (webFrame && typeof webFrame.executeJavaScript === 'function') {
    Promise.resolve(webFrame.executeJavaScript(${JSON.stringify(mainWorldScript)})).catch(function() {});
  }
} catch (_) {}
`
}

function resolvePreloadDir(ses: Session, explicitDir?: string): string {
  if (explicitDir && explicitDir.trim()) return explicitDir
  try {
    const maybeStorage = (ses as Session & { getStoragePath?: () => string | null }).getStoragePath?.()
    if (typeof maybeStorage === 'string' && maybeStorage.trim()) {
      const parentDir = dirname(maybeStorage)
      if (basename(parentDir).toLowerCase() === 'partitions') {
        return dirname(parentDir)
      }
      return maybeStorage
    }
  } catch {
    /* fallback to tmpdir */
  }
  return join(tmpdir(), 'botark-google-oauth-guard')
}

function materializePreloadScript(dir: string, source: string): string {
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, PRELOAD_FILENAME)
  let existing = ''
  try {
    existing = readFileSync(filePath, 'utf8')
  } catch {
    /* file does not exist yet */
  }
  if (existing !== source) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmpPath, source, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, filePath)
  }
  return filePath
}

export function isGoogleBlockedOrPasskeyText(bodyText: unknown, url?: string): boolean {
  if (url !== undefined) {
    try {
      const parsed = new URL(url)
      const host = parsed.hostname.toLowerCase()
      if (!/^accounts\.(?:google\.com|youtube\.com)$/i.test(host)) {
        return false
      }
      if (/\/signin\/rejected\b/i.test(parsed.pathname) || /disallowed_useragent/i.test(parsed.search)) {
        if (bodyText === true || (typeof bodyText === 'string' && bodyText.trim().length > 0)) {
          return true
        }
      }
    } catch {
      return false
    }
  }
  if (typeof bodyText === 'boolean') return bodyText
  if (typeof bodyText !== 'string' || !bodyText) return false
  return (
    bodyText.includes('此浏览器或应用可能不安全') ||
    bodyText.includes('This browser or app may not be secure') ||
    bodyText.includes('disallowed_useragent') ||
    bodyText.includes("Couldn't sign you in") ||
    bodyText.includes('Couldn’t sign you in') ||
    bodyText.includes('无法登录') ||
    /\bpasskey\b|通行密钥|security key|安全密钥/i.test(bodyText)
  )
}

export const GOOGLE_BLOCK_CHECK_SCRIPT = `(() => (document.body && (document.body.innerText || document.body.textContent)) || '')()`

export function buildGoogleFallbackBannerScript(opts: {
  id?: string
  title: string
  detail: string
  buttonLabel?: string
  actionUrl?: string
}): string {
  const bannerId = opts.id ?? 'botark-google-fallback-banner'
  return `(() => {
  try {
    if (!document.body) return;
    var existing = document.getElementById(${JSON.stringify(bannerId)});
    if (existing) return;
    var bar = document.createElement('div');
    bar.id = ${JSON.stringify(bannerId)};
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1f2937;color:#f9fafb;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.22);';
    var info = document.createElement('div');
    info.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';
    var titleEl = document.createElement('strong');
    titleEl.textContent = ${JSON.stringify(opts.title)};
    titleEl.style.cssText = 'font-size:13px;font-weight:600;color:#fff;';
    var detailEl = document.createElement('span');
    detailEl.textContent = ${JSON.stringify(opts.detail)};
    detailEl.style.cssText = 'font-size:12px;color:#d1d5db;';
    info.appendChild(titleEl);
    info.appendChild(detailEl);
    bar.appendChild(info);
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;';
    ${
      opts.buttonLabel
        ? `var btn = document.createElement('a');
    btn.href = ${JSON.stringify(opts.actionUrl ?? 'botark-external://open')};
    btn.textContent = ${JSON.stringify(opts.buttonLabel)};
    btn.style.cssText = 'background:#3b82f6;color:#fff;text-decoration:none;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;';
    actions.appendChild(btn);`
        : ''
    }
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background:transparent;border:none;color:#9ca3af;font-size:16px;cursor:pointer;padding:2px 6px;';
    closeBtn.onclick = function() { bar.remove(); };
    actions.appendChild(closeBtn);
    bar.appendChild(actions);
    document.body.appendChild(bar);
  } catch (_) {}
})();`
}

/**
 * Strip `Electron/...` and `"Electron"` Client Hints + main-world `navigator` fingerprints
 * strictly on Google OAuth origins (`*.google.com`, `*.youtube.com`, `*.gstatic.com`,
 * `*.googleapis.com`, `*.googleusercontent.com`), leaving non-Google origins (such as
 * Cloudflare Turnstile pages) completely untouched.
 *
 * NOTE: Electron's `Session.webRequest.onBeforeSendHeaders` only retains one active listener
 * per `Session` (calling it again replaces any prior listener). No other module should
 * attach its own `onBeforeSendHeaders` handler directly to account sessions.
 */
export function installGoogleOAuthHeaderGuard(
  ses: Session | undefined | null,
  opts?: { preloadDir?: string; chromeVersion?: string; platform?: NodeJS.Platform }
): void {
  if (!ses || typeof ses !== 'object') return

  if (!guardedSessions.has(ses)) {
    const webRequest = (ses as Session & { webRequest?: Session['webRequest'] }).webRequest
    if (webRequest && typeof webRequest.onBeforeSendHeaders === 'function') {
      guardedSessions.add(ses)
      webRequest.onBeforeSendHeaders(
        {
          urls: [...GOOGLE_OAUTH_URL_PATTERNS]
        },
        (details, callback) => {
          callback({
            requestHeaders: sanitizeGoogleRequestHeaders(
              details.requestHeaders,
              opts?.chromeVersion,
              opts?.platform
            )
          })
        }
      )
    }
  }

  const extSes = ses as Session & {
    registerPreloadScript?: (script: {
      id?: string
      type: 'frame' | 'service-worker'
      filePath: string
      matches?: string[]
      matchOriginAsFallback?: boolean
    }) => string
    getPreloadScripts?: () => Array<{ id?: string }>
  }
  if (typeof extSes.registerPreloadScript === 'function') {
    try {
      const existingScripts = extSes.getPreloadScripts?.() ?? []
      if (!existingScripts.some((s) => s.id === GOOGLE_OAUTH_PRELOAD_ID)) {
        const dir = resolvePreloadDir(ses, opts?.preloadDir)
        const source = buildGoogleOAuthPreloadScriptSource(opts?.chromeVersion, opts?.platform)
        const filePath = materializePreloadScript(dir, source)
        extSes.registerPreloadScript({
          id: GOOGLE_OAUTH_PRELOAD_ID,
          type: 'frame',
          filePath,
          matches: [...GOOGLE_OAUTH_URL_PATTERNS],
          matchOriginAsFallback: true
        })
      }
    } catch {
      /* ignore mock sessions or transient registration failures */
    }
  }
}
