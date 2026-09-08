/**
 * The one timestamp implementation. Backend emits naive SQLite datetimes
 * (`YYYY-MM-DD HH:MM:SS`, implicitly UTC) as well as ISO strings that may
 * already carry `Z` or a `+00:00` offset. The old `timeAgo` appended `Z`
 * blindly, turning `…+00:00` into an invalid date → "NaNd ago". This parser
 * respects an existing offset/Z and only assumes UTC when none is present.
 */

export function parseTimestamp(ts: string): Date {
  if (!ts) return new Date(NaN);
  const hasZone = /[zZ]$/.test(ts) || /[+-]\d{2}:?\d{2}$/.test(ts);
  // SQLite "YYYY-MM-DD HH:MM:SS" → ISO so Safari parses it too.
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  return new Date(hasZone ? iso : iso + "Z");
}

export function timeAgo(ts: string): string {
  const d = parseTimestamp(ts);
  if (isNaN(d.getTime())) return "Unknown";
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 0) return "just now"; // clock skew — never show a negative age
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  if (day < 365) return `${Math.floor(day / 30)}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

export function formatDateTime(ts: string): string {
  const d = parseTimestamp(ts);
  if (isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

export function formatDateShort(ts: string): string {
  const d = parseTimestamp(ts);
  if (isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
