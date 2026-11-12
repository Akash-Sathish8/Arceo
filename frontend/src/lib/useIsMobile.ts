import { useEffect, useState } from "react"

/** Phone/narrow-tablet layout: the sidebar becomes a drawer below this width. */
export const MOBILE_QUERY = "(max-width: 767px)"

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(MOBILE_QUERY).matches : false)
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia(MOBILE_QUERY)
    const on = () => setMobile(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return mobile
}
