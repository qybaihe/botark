// electron-builder config (was the "build" key in package.json).
// Signing is optional: without the env vars below every build is unsigned,
// exactly like the earlier manual releases.
//   macOS CI (.p12):       CSC_LINK, CSC_KEY_PASSWORD
//   macOS local Keychain:  APPLE_SIGN=1 (or CSC_NAME="Developer ID Application: ...")
//   macOS Notarization:    (APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID)
//                       or (APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER)
//                       or (APPLE_KEYCHAIN_PROFILE [+ APPLE_KEYCHAIN])
//   Windows:               WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const has = (name) => Boolean(process.env[name] && process.env[name].trim())
const hasBundledTunnelBin = existsSync(join(__dirname, 'resources', 'bin'))
const macSigned = has('CSC_LINK') || has('CSC_NAME') || process.env.APPLE_SIGN === '1'
const notarizeByAppleId =
  has('APPLE_ID') && has('APPLE_APP_SPECIFIC_PASSWORD') && has('APPLE_TEAM_ID')
const notarizeByApiKey =
  has('APPLE_API_KEY') && has('APPLE_API_KEY_ID') && has('APPLE_API_ISSUER')
const notarizeByKeychainProfile = has('APPLE_KEYCHAIN_PROFILE')
const notarize =
  macSigned && (notarizeByAppleId || notarizeByApiKey || notarizeByKeychainProfile)
const cliArgs = new Set(process.argv.slice(2))
const macArchs = cliArgs.has('--arm64')
  ? ['arm64']
  : cliArgs.has('--x64')
    ? ['x64']
    : ['arm64', 'x64']

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.qybaihe.botark',
  productName: 'BotArk',
  copyright: 'Copyright © 2026 BotArk contributors',
  directories: {
    output: 'release',
    buildResources: 'build'
  },
  files: ['out/**/*', 'package.json'],
  // cloudflared publishes the workspace portal on a public https URL so a
  // member that refuses BotArk's `[TOOL]` protocol can still reach the local
  // workspace with its own web tools. Ship unpacked when present locally/in CI
  // (skipped gracefully on clean checkouts without resources/bin).
  ...(hasBundledTunnelBin
    ? {
        extraResources: [
          {
            from: 'resources/bin',
            to: 'bin',
            filter: ['**/*']
          }
        ]
      }
    : {}),
  asar: true,
  protocols: [
    {
      name: 'Cue Desktop OAuth Callback',
      schemes: ['cuedev']
    }
  ],
  mac: {
    category: 'public.app-category.productivity',
    icon: 'build/icon.icns',
    target: [
      { target: 'dmg', arch: macArchs },
      // zip is what electron-updater reads on macOS (latest-mac.yml).
      { target: 'zip', arch: macArchs }
    ],
    // null = skip signing entirely (unsigned build, as before).
    identity: macSigned ? undefined : null,
    hardenedRuntime: macSigned,
    gatekeeperAssess: false,
    // Skip non-code data files (covered by CodeResources) and framework symlink duplicates
    // so codesign only signs real Mach-O binaries & bundles once (TN2206 compliant, ~30x faster).
    signIgnore: [
      '\\.(pak|dat|bin|icns|car|asar|nib|strings|plist|json|txt|md|html|css|svg|png|woff2)$',
      '\\.framework/Versions/Current(/|$)',
      '\\.framework/(Electron Framework|Helpers|Libraries|Resources|Mantle|ReactiveObjC|Squirrel)(/|$)'
    ],
    notarize,
    artifactName: '${productName}-${version}-${arch}.${ext}'
  },
  dmg: {
    sign: macSigned,
    artifactName: '${productName}-${version}-${arch}.${ext}'
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // Keep the user's data (accounts, sessions) on uninstall.
    deleteAppDataOnUninstall: false
  },
  publish: [
    {
      provider: 'github',
      owner: 'qybaihe',
      repo: 'botark',
      // CI creates the draft first and every platform job uploads into it,
      // then one final step publishes. No job ever creates the release, so
      // parallel uploads cannot race into a 422.
      releaseType: 'draft'
    }
  ]
}
