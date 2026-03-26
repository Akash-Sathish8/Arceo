import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          textAlign: "center",
          padding: "120px 20px",
          animation: "fadeIn 0.4s",
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: "50%",
            background: "#fef2f2", color: "#dc2626",
            fontSize: 22, fontWeight: 800,
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 16px",
          }}>!</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Something went wrong</h2>
          <p style={{ fontSize: 14, color: "#555", margin: "0 0 20px" }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              padding: "8px 20px", fontSize: 14, fontWeight: 600,
              border: "1px solid #e8e8e8", borderRadius: 8,
              background: "#fff", cursor: "pointer",
            }}
          >
            Reload Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
