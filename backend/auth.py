"""Authentication — JWT tokens, bcrypt passwords, user middleware. Multi-tenant."""

from __future__ import annotations

import os
from datetime import datetime, timedelta

import bcrypt
import jwt
from fastapi import HTTPException, Request

from db import get_db, log_audit, DEFAULT_ORG_ID

import logging as _logging

SECRET_KEY = os.getenv("JWT_SECRET", "actiongate-demo-secret-key-change-in-prod")
ALGORITHM = "HS256"
TOKEN_EXPIRY_HOURS = 24

_logger = _logging.getLogger("actiongate.auth")
if SECRET_KEY == "actiongate-demo-secret-key-change-in-prod":
    if os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("FLY_APP_NAME") or os.getenv("RENDER") or os.getenv("PRODUCTION"):
        raise RuntimeError("JWT_SECRET must be set in production. Cannot use default demo value.")
    _logger.warning(
        "JWT_SECRET is using the default demo value. Set JWT_SECRET env var in production. "
        "This is insecure and will allow anyone to forge authentication tokens."
    )


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    if hashed.startswith("$2b$") or hashed.startswith("$2a$"):
        return bcrypt.checkpw(password.encode(), hashed.encode())
    else:
        import hashlib
        return hashlib.sha256(password.encode()).hexdigest() == hashed


def create_token(user_id: str, email: str, role: str, org_id: str = DEFAULT_ORG_ID) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "org_id": org_id,
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

    Returns dict with: sub, email, role, org_id.
    DEMO_MODE bypasses JWT and returns admin user with their org_id.
    """
    if os.getenv("DEMO_MODE", "").lower() == "true":
        with get_db() as conn:
            row = conn.execute("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").fetchone()
            if row:
                org_id = row["org_id"] if "org_id" in row.keys() else DEFAULT_ORG_ID
                return {"sub": row["id"], "email": row["email"], "role": row["role"], "org_id": org_id}
        return {"sub": "demo", "email": "admin@actiongate.io", "role": "admin", "org_id": DEFAULT_ORG_ID}
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization header")
    token = auth[7:]
    payload = verify_token(token)
    # Ensure org_id is always present (backward compat with old tokens)
    if "org_id" not in payload:
        payload["org_id"] = DEFAULT_ORG_ID
    return payload


def login_user(email: str, password: str) -> dict:
    """Authenticate user and return token + user info including org_id."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid email or password")

        if not row["password_hash"].startswith("$2b$"):
            new_hash = hash_password(password)
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, row["id"]))

        org_id = row["org_id"] if "org_id" in row.keys() else DEFAULT_ORG_ID
        token = create_token(row["id"], row["email"], row["role"], org_id)
        log_audit(conn, row["id"], row["email"], "LOGIN", detail="User logged in", org_id=org_id)

        return {
            "token": token,
            "user": {
                "id": row["id"],
                "email": row["email"],
                "name": row["name"],
                "role": row["role"],
                "org_id": org_id,
            },
        }
