import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildChromeClientHints,
  buildGoogleOAuthMainWorldPatchScript,
  buildGoogleOAuthPreloadScriptSource,
  cleanChromeUserAgentForGoogle,
  GOOGLE_OAUTH_PRELOAD_ID,
  GOOGLE_OAUTH_URL_PATTERNS,
  installGoogleOAuthHeaderGuard,
  isGoogleBlockedOrPasskeyText,
  sanitizeGoogleRequestHeaders
} from './googleOAuthUaGuard'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botark-oauth-guard-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('googleOAuthUaGuard', () => {
  it('strips Electron and BotArk tokens from User-Agent and Sec-CH-UA headers across OS platforms', () => {
    const rawWin =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) BotArk/0.12.1 Chrome/147.0.7103.49 Electron/45.2.1 Safari/537.36'
    expect(cleanChromeUserAgentForGoogle(rawWin, '147.0.7103.49', 'win32')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7103.49 Safari/537.36'
    )

    const sanitizedWin = sanitizeGoogleRequestHeaders(
      {
        'User-Agent': rawWin,
        'sec-ch-ua': '"Not.A/Brand";v="99", "Electron";v="45", "Chromium";v="147"',
        'sec-ch-ua-full-version-list': '"Electron";v="45.2.1", "Chromium";v="147.0.7103.49"',
        'sec-ch-ua-platform': '"Windows"',
        'X-Custom-Header': 'keep-me'
      },
      '147.0.7103.49',
      'darwin'
    )
    expect(sanitizedWin['User-Agent']).not.toContain('Electron')
    expect(sanitizedWin['User-Agent']).not.toContain('BotArk')
    expect(sanitizedWin['sec-ch-ua']).toBe(
      '"Chromium";v="147", "Google Chrome";v="147", "Not-A.Brand";v="99"'
    )
    expect(sanitizedWin['sec-ch-ua-full-version-list']).toBe(
      '"Chromium";v="147.0.7103.49", "Google Chrome";v="147.0.7103.49", "Not-A.Brand";v="99.0.0.0"'
    )
    // Inferred from Windows UA even if fallback platform was darwin
    expect(sanitizedWin['sec-ch-ua-platform']).toBe('"Windows"')
    expect(sanitizedWin['X-Custom-Header']).toBe('keep-me')

    const sanitizedMac = sanitizeGoogleRequestHeaders(
      {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/147.0.0.0 Electron/45.2.1 Safari/537.36'
      },
      '147.0.0.0',
      'win32'
    )
    expect(sanitizedMac['Sec-CH-UA-Platform']).toBe('"macOS"')

    const sanitizedLinux = sanitizeGoogleRequestHeaders({}, '147.0.0.0', 'linux')
    expect(sanitizedLinux['User-Agent']).toContain('X11; Linux x86_64')
    expect(sanitizedLinux['Sec-CH-UA-Platform']).toBe('"Linux"')
  })

  it('uses platform-appropriate fallback UA when Chrome/ is absent', () => {
    expect(cleanChromeUserAgentForGoogle('CustomUA/1.0', '145.0.0.0', 'win32')).toContain(
      'Windows NT 10.0; Win64; x64'
    )
    expect(cleanChromeUserAgentForGoogle('CustomUA/1.0', '145.0.0.0', 'darwin')).toContain(
      'Macintosh; Intel Mac OS X 10_15_7'
    )
    expect(cleanChromeUserAgentForGoogle('CustomUA/1.0', '145.0.0.0', 'linux')).toContain(
      'X11; Linux x86_64'
    )
    expect(buildChromeClientHints('145.1.2.3', 'win32').uaDataPlatform).toBe('Windows')
  })

  it('covers all 6+ Google OAuth domains and installs headers + preload idempotently', () => {
    expect(GOOGLE_OAUTH_URL_PATTERNS).toEqual([
      '*://*.google.com/*',
      '*://google.com/*',
      '*://*.youtube.com/*',
      '*://youtube.com/*',
      '*://*.gstatic.com/*',
      '*://*.googleapis.com/*',
      '*://*.googleusercontent.com/*'
    ])

    const dir = makeTempDir()
    const registeredScripts: Array<{ id?: string; filePath: string; matches?: string[]; type: string }> = []
    const onBeforeSendHeaders = vi.fn()
    const registerPreloadScript = vi.fn((script) => {
      registeredScripts.push(script)
      return script.id ?? 'id'
    })

    const ses = {
      getStoragePath: () => join(dir, 'Partitions', 'bothub-account-acc_1'),
      webRequest: { onBeforeSendHeaders },
      registerPreloadScript,
      getPreloadScripts: () => registeredScripts
    } as unknown as Parameters<typeof installGoogleOAuthHeaderGuard>[0]

    installGoogleOAuthHeaderGuard(ses, { chromeVersion: '147.0.0.0', platform: 'win32' })
    installGoogleOAuthHeaderGuard(ses, { chromeVersion: '147.0.0.0', platform: 'win32' })

    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1)
    expect(onBeforeSendHeaders.mock.calls[0]?.[0]).toEqual({
      urls: [...GOOGLE_OAUTH_URL_PATTERNS]
    })
    expect(registerPreloadScript).toHaveBeenCalledTimes(1)
    expect(registeredScripts[0]).toMatchObject({
      id: GOOGLE_OAUTH_PRELOAD_ID,
      type: 'frame',
      matches: [...GOOGLE_OAUTH_URL_PATTERNS],
      matchOriginAsFallback: true
    })
    const diskPreload = readFileSync(registeredScripts[0]!.filePath, 'utf8')
    expect(diskPreload).toContain('webFrame.executeJavaScript')
    expect(buildGoogleOAuthPreloadScriptSource('147.0.0.0', 'win32')).toBe(diskPreload)
  })

  it('gracefully handles mock sessions without registerPreloadScript or nullish input', () => {
    expect(() => installGoogleOAuthHeaderGuard(null)).not.toThrow()
    expect(() => installGoogleOAuthHeaderGuard(undefined)).not.toThrow()
    const onBeforeSendHeaders = vi.fn()
    const minimalSes = { webRequest: { onBeforeSendHeaders } } as unknown as Parameters<
      typeof installGoogleOAuthHeaderGuard
    >[0]
    expect(() => installGoogleOAuthHeaderGuard(minimalSes)).not.toThrow()
    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1)
  })

  it('patches navigator.userAgent, userAgentData, and webdriver ONLY on Google origins (no-op on Turnstile)', async () => {
    const patchScript = buildGoogleOAuthMainWorldPatchScript('147.0.7103.49', 'win32')

    const runInOrigin = (hostname: string) => {
      class MockNavigatorUAData {
        brands = [{ brand: 'Electron', version: '45' }]
        mobile = false
        platform = 'Windows'
        async getHighEntropyValues() {
          return {
            architecture: 'x86',
            brands: [{ brand: 'Electron', version: '45' }],
            fullVersionList: [{ brand: 'Electron', version: '45.2.1' }],
            uaFullVersion: '45.2.1'
          }
        }
      }
      class MockNavigator {}
      Object.defineProperties(MockNavigator.prototype, {
        userAgent: {
          configurable: true,
          get: () =>
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 BotArk/0.12.1 Chrome/147.0.7103.49 Electron/45.2.1 Safari/537.36'
        },
        appVersion: {
          configurable: true,
          get: () =>
            '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 BotArk/0.12.1 Chrome/147.0.7103.49 Electron/45.2.1 Safari/537.36'
        },
        webdriver: { configurable: true, get: () => true },
        userAgentData: { configurable: true, get: () => new MockNavigatorUAData() }
      })
      const navigator = new MockNavigator()
      const context = {
        Navigator: MockNavigator,
        navigator,
        location: { hostname, protocol: 'https:' },
        Object,
        Symbol,
        Promise,
        Array
      }
      vm.runInNewContext(patchScript, context)
      return { navigator, MockNavigatorUAData }
    }

    // Google OAuth origin: patched
    const googleEnv = runInOrigin('accounts.google.com')
    const gNav = googleEnv.navigator as unknown as {
      userAgent: string
      appVersion: string
      webdriver: boolean
      userAgentData: {
        brands: Array<{ brand: string; version: string }>
        platform: string
        mobile: boolean
        getHighEntropyValues: (hints: string[]) => Promise<Record<string, unknown>>
      }
    }
    expect(gNav.userAgent).not.toContain('Electron')
    expect(gNav.userAgent).not.toContain('BotArk')
    expect(gNav.appVersion).not.toContain('Electron')
    expect(gNav.webdriver).toBe(false)
    expect(gNav.userAgentData instanceof googleEnv.MockNavigatorUAData).toBe(true)
    expect(gNav.userAgentData.brands).toEqual([
      { brand: 'Chromium', version: '147' },
      { brand: 'Google Chrome', version: '147' },
      { brand: 'Not-A.Brand', version: '99' }
    ])
    expect(gNav.userAgentData.platform).toBe('Windows')
    const entropy = await gNav.userAgentData.getHighEntropyValues(['fullVersionList', 'uaFullVersion'])
    expect(entropy.uaFullVersion).toBe('147.0.7103.49')
    expect(entropy.fullVersionList).toEqual([
      { brand: 'Chromium', version: '147.0.7103.49' },
      { brand: 'Google Chrome', version: '147.0.7103.49' },
      { brand: 'Not-A.Brand', version: '99.0.0.0' }
    ])

    // Cloudflare Turnstile / non-Google origin: completely untouched
    const cfEnv = runInOrigin('challenges.cloudflare.com')
    const cNav = cfEnv.navigator as unknown as {
      userAgent: string
      webdriver: boolean
      userAgentData: { brands: Array<{ brand: string; version: string }> }
    }
    expect(cNav.userAgent).toContain('Electron/45.2.1')
    expect(cNav.webdriver).toBe(true)
    expect(cNav.userAgentData.brands[0]?.brand).toBe('Electron')
  })

  it('detects Google blocked or passkey pages strictly on Google/YouTube auth hosts', () => {
    expect(
      isGoogleBlockedOrPasskeyText(
        '此浏览器或应用可能不安全。请尝试使用其他浏览器。',
        'https://accounts.google.com/v3/signin/rejected'
      )
    ).toBe(true)
    expect(
      isGoogleBlockedOrPasskeyText(
        'This browser or app may not be secure',
        'https://accounts.google.com/signin/v2'
      )
    ).toBe(true)
    expect(
      isGoogleBlockedOrPasskeyText(
        'Use your passkey to confirm it is really you',
        'https://accounts.youtube.com/signin'
      )
    ).toBe(true)
    expect(
      isGoogleBlockedOrPasskeyText(
        '请使用通行密钥或安全密钥验证',
        'https://accounts.google.com/v3/signin/challenge'
      )
    ).toBe(true)
    expect(
      isGoogleBlockedOrPasskeyText(
        'Couldn’t sign you in',
        'https://accounts.google.com/v3/signin'
      )
    ).toBe(true)
    // Never false-positive on non-Google sites
    expect(
      isGoogleBlockedOrPasskeyText(
        'Use your passkey to sign in',
        'https://chatgpt.com/auth/login'
      )
    ).toBe(false)
  })
})
