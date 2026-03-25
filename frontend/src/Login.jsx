import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, setToken, setUser } from "./api.js";
import "./Login.css";

export default function Login() {
  const [email, setEmail] = useState("admin@actiongate.io");
  const [password, setPassword] = useState("admin123");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(data.token);
      setUser(data.user);
      navigate("/");
    } catch (err) {
      setError("Invalid email or password");
    }
    setLoading(false);
  };

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={handleSubmit}>
        <div className="login-brand">ActionGate</div>
        <p className="login-subtitle">Sign in to the Authority Engine</p>

        {error && <div className="login-error">{error}</div>}

        <label>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />

        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />

        <button type="submit" disabled={loading}>
          {loading ? "Signing in..." : "Sign In"}
        </button>

        <p className="login-hint">Demo: admin@actiongate.io / admin123</p>
      </form>
    </div>
  );
}
