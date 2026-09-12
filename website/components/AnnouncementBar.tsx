export default function AnnouncementBar() {
  return (
    <div style={{
      background: "var(--brand)",
      padding: "9px 24px",
      textAlign: "center",
      borderBottom: "1px solid rgba(113,217,226,0.22)",
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
