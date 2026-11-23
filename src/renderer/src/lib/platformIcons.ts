import type { PlatformId } from "@adapters/types"
import grokIcon from "@/assets/platforms/grok.png"
import museIcon from "@/assets/platforms/muse.svg"
import harkIcon from "@/assets/platforms/hark.svg"
import dotIcon from "@/assets/platforms/dot.svg"
import hermesIcon from "@/assets/platforms/hermes.png"
import antigravityIcon from "@/assets/platforms/antigravity.png"
import cueIcon from "@/assets/platforms/cue.svg"

/**
 * Official brand marks, keyed by platform. Muse uses the white app icon from
 * muse.ai/images/landing/brand/muse-app-icon.svg; Grok Bot uses X Corp.'s
 * official App Store app icon; Hermes uses NousResearch/hermes-agent's official
 * emblem; Antigravity uses Google Antigravity's official emblem; Cue uses
 * cue.im's official Cue! app icon.
 */
const ICONS: Partial<Record<PlatformId, string>> = {
  "meta-muse": museIcon,
  grok: grokIcon,
  hark: harkIcon,
  dot: dotIcon,
  hermes: hermesIcon,
  antigravity: antigravityIcon,
  cue: cueIcon
}

export function platformIcon(id: PlatformId | undefined): string | undefined {
  return id ? ICONS[id] : undefined
}
