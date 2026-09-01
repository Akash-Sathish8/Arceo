export default function AnnouncementBar() {
  return (
    <div style={{
      background: "var(--ink)",
      padding: "9px 24px",
      textAlign: "center",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
    }}>
      <span style={{
        fontSize: 13.5,
        fontWeight: 500,
        color: "var(--paper)",
        letterSpacing: "0.01em",
      }}>
        We help CIOs and CFOs sign off on AI agents before they go live
      </span>
    </div>
  );
}
