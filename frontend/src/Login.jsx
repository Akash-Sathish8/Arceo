import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, setToken, setUser } from "./api.js";
import "./Login.css";

export default function Login() {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const endpoint = isSignup ? "/api/auth/signup" : "/api/auth/login";
      const body = isSignup
        ? { email, password, name }
        : { email, password };
      const data = await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setToken(data.token);
      setUser(data.user);
      navigate("/");
    } catch (err) {
      if (isSignup) {
        setError(err.message.includes("409") ? "Email already registered" : err.message.includes("400") ? "Password must be at least 6 characters" : "Signup failed");
      } else {
        setError("Invalid email or password");
      }
    }
    setLoading(false);
  };

  return (
    <div className="login-page">
      <div className="login-brand-panel">
        <div className="login-brand-logo">ActionGate</div>
        <h1 className="login-brand-headline">Know what your AI agents can do before they do it.</h1>
        <p className="login-brand-sub">Map every tool, score the blast radius, catch dangerous chains — before a single action runs in production.</p>
        <div className="login-brand-features">
          <div className="login-brand-feature">
            <span className="login-brand-feature-label">Authority</span>
            <span className="login-brand-feature-value">Map agent permissions</span>
          </div>
          <div className="login-brand-feature">
            <span className="login-brand-feature-label">Sandbox</span>
            <span className="login-brand-feature-value">Simulate before deploy</span>
          </div>
          <div className="login-brand-feature">
            <span className="login-brand-feature-label">Enforce</span>
            <span className="login-brand-feature-value">Block risky actions</span>
          </div>
        </div>
      </div>
      <div className="login-form-panel">
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-brand">ActionGate</div>
          <p className="login-subtitle">{isSignup ? "Create your account" : "Sign in to the Authority Engine"}</p>

          {error && <div className="login-error">{error}</div>}

          {isSignup && (
            <>
              <label>Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </>
          )}

          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />

          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isSignup ? "At least 6 characters" : ""} required />

          <button type="submit" disabled={loading}>
            {loading ? (isSignup ? "Creating..." : "Signing in...") : (isSignup ? "Create Account" : "Sign In")}
          </button>

          <p className="login-toggle">
            {isSignup ? (
              <>Already have an account? <span onClick={() => { setIsSignup(false); setError(null); }}>Sign in</span></>
            ) : (
              <>Don't have an account? <span onClick={() => { setIsSignup(true); setError(null); }}>Create one</span></>
            )}
          </p>

          {!isSignup && <p className="login-hint">Demo: admin@actiongate.io / admin123</p>}
        </form>
      </div>
    </div>
  );
}
