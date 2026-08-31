import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"

interface TooltipProps {
  /** Short single-line text. For multi-line / rich content, use `content` instead. */
  text?: string
  /** Rich / multi-line content. Wrapped instead of nowrap. */
  content?: React.ReactNode
  children: React.ReactNode
}

/**
 * Hover/focus-triggered tooltip. Renders via a portal so it isn't clipped by
 * overflow:hidden ancestors. Pass `text` for one-liners (nowrap), `content`
 * for methodology explanations or anything that needs to wrap.
 * The wrapper span is the focusable trigger (tabIndex=0); Escape dismisses.
 */
export default function Tooltip({ text, content, children }: TooltipProps) {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const tooltipId = useId()

  const show = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect()
      setCoords({ top: r.top, left: r.left + r.width / 2 })
    }
  }

  const hide = () => setCoords(null)

  const isOpen = coords !== null

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCoords(null)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [isOpen])

  const isRich = content !== undefined
  const body = isRich ? content : text

  return (
    <span
      ref={ref}
      className="relative inline-block"
      tabIndex={0}
      aria-describedby={isOpen ? tooltipId : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {isOpen &&
        createPortal(
          <span
            id={tooltipId}
            role="tooltip"
            className={
              isRich
                ? "fixed z-50 px-3 py-2 text-xs text-white bg-gray-800 rounded-md shadow-lg pointer-events-none leading-relaxed"
                : "fixed z-50 px-2 py-1 text-xs text-white bg-gray-800 rounded shadow-lg whitespace-nowrap pointer-events-none"
            }
            style={{
              top: coords.top,
              left: coords.left,
              transform: "translate(-50%, calc(-100% - 8px))",
              maxWidth: isRich ? 320 : undefined,
            }}
          >
            {body}
          </span>,
          document.body
        )}
    </span>
  )
}
