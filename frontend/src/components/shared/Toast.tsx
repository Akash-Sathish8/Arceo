import { useEffect, useState } from "react";
import { CheckCircle, XCircle, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

type Subscriber = (toasts: ToastItem[]) => void;

// Module-level state — no React context needed
let nextId = 0;
let queue: ToastItem[] = [];
const subscribers = new Set<Subscriber>();
const MAX_TOASTS = 5;

function notify(): void {
  subscribers.forEach((sub) => sub([...queue]));
}

function dismiss(id: number): void {
  queue = queue.filter((t) => t.id !== id);
  notify();
}

export function toast(message: string, type: ToastType = "success"): void {
  const id = ++nextId;
  queue = [...queue, { id, message, type }];
  // Cap the stack so a burst (e.g. apply-all + refresh errors) can't bury the
  // screen — drop the oldest.
  if (queue.length > MAX_TOASTS) queue = queue.slice(queue.length - MAX_TOASTS);
  notify();

  const duration = type === "error" ? 6000 : 3000;
  setTimeout(() => dismiss(id), duration);
}

const ICON: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle size={16} className="shrink-0" />,
  error: <XCircle size={16} className="shrink-0" />,
  info: <Info size={16} className="shrink-0" />,
};

const COLOR: Record<ToastType, string> = {
  success: "bg-green-50 border-green-200 text-green-800",
  error: "bg-red-50 border-red-200 text-red-700",
  info: "bg-gray-50 border-gray-200 text-gray-700",
};

export function ToastContainer(): React.ReactElement {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    subscribers.add(setToasts);
    return () => {
      subscribers.delete(setToasts);
    };
  }, []);

  return (
    // z-[80] so toasts sit ABOVE the agent drawer (z-61) and command palette —
    // a success/error fired while the drawer is open must not hide under the scrim.
    <div
      className="fixed bottom-4 right-4 z-[80] flex flex-col gap-2 w-80"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border shadow-md text-sm font-medium ${COLOR[t.type]}`}
          style={{ animation: "toast-in 0.2s ease-out" }}
        >
          {ICON[t.type]}
          <span className="flex-1">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="shrink-0 opacity-50 hover:opacity-100 transition-opacity"
            style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: 2 }}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
