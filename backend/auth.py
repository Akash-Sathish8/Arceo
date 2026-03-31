"""Authentication — JWT tokens, bcrypt passwords, user middleware."""

from __future__ import annotations

import os
from datetime import datetime, timedelta

import bcrypt
import jwt
from fastapi import HTTPException, Request

from db import get_db, log_audit

import logging as _logging

SECRET_KEY = os.getenv("JWT_SECRET", "actiongate-demo-secret-key-change-in-prod")
ALGORITHM = "HS256"
TOKEN_EXPIRY_HOURS = 24

if SECRET_KEY == "actiongate-demo-secret-key-change-in-prod":
    _logger = _logging.getLogger("actiongate.auth")
    _logger.warning(
        "JWT_SECRET is using the default demo value. Set JWT_SECRET env var in production. "
        "This is insecure and will allow anyone to forge authentication tokens."
    )


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    # Support both bcrypt and legacy SHA256 hashes for migration
    if hashed.startswith("$2b$") or hashed.startswith("$2a$"):
        return bcrypt.checkpw(password.encode(), hashed.encode())
    else:
        # Legacy SHA256 — still works but should be migrated
        import hashlib
        return hashlib.sha256(password.encode()).hexdigest() == hashed


def create_token(user_id: str, email: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "exp": datetime.utcnow() + timedelta(hours=TOKEN_EXPIRY_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


def get_current_user(request: Request) -> dict:
    """Extract and verify user from Authorization header.

    When DEMO_MODE=true, auth is bypassed and the admin user is returned
    without checking JWT — so any YC partner can open the URL directly.
    """
    if os.getenv("DEMO_MODE", "").lower() == "true":
        with get_db() as conn:
            row = conn.execute("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").fetchone()
            if row:
                return {"sub": row["id"], "email": row["email"], "role": row["role"]}
        return {"sub": "demo", "email": "admin@actiongate.io", "role": "admin"}
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization header")
    token = auth[7:]
    return verify_token(token)


def login_user(email: str, password: str) -> dict:
    """Authenticate user and return token + user info."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid email or password")

        # Migrate legacy SHA256 hash to bcrypt on successful login
        if not row["password_hash"].startswith("$2b$"):
            new_hash = hash_password(password)
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, row["id"]))

        token = create_token(row["id"], row["email"], row["role"])
        log_audit(conn, row["id"], row["email"], "LOGIN", detail="User logged in")

        return {
            "token": token,
            "user": {
                "id": row["id"],
                "email": row["email"],
                "name": row["name"],
                "role": row["role"],
            },
        }
