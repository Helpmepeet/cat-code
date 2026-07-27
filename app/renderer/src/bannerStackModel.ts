import { useCallback, useState } from 'react'
import type { BannerNotice } from './BannerStack.js'

export function upsertBanner(
  banners: readonly BannerNotice[],
  banner: BannerNotice,
): BannerNotice[] {
  const index = banners.findIndex(b => b.id === banner.id)
  if (index < 0) return [...banners, banner]
  const next = banners.slice()
  next[index] = banner
  return next
}

export function dismissBanner(
  banners: readonly BannerNotice[],
  id: string,
): BannerNotice[] {
  return banners.filter(b => b.id !== id)
}

export function useBannerStack(initial: readonly BannerNotice[] = []) {
  const [banners, setBanners] = useState<BannerNotice[]>(() => [...initial])
  const showBanner = useCallback((banner: BannerNotice) => {
    setBanners(current => upsertBanner(current, banner))
  }, [])
  const removeBanner = useCallback((id: string) => {
    setBanners(current => dismissBanner(current, id))
  }, [])
  return { banners, showBanner, removeBanner }
}
