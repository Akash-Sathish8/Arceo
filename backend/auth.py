"""Authentication — JWT tokens, login, user middleware."""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from functools import wraps

import hashlib

import jwt
from fastapi import Depends, HTTPException, Request

from db import get_db, log_audit

SECRET_KEY = os.getenv("JWT_SECRET", "actiongate-demo-secret-key-change-in-prod")
ALGORITHM = "HS256"
TOKEN_EXPIRY_HOURS = 24


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
    """Extract and verify user from Authorization header."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization header")
    token = auth[7:]
    return verify_token(token)


def login_user(email: str, password: str) -> dict:
    """Authenticate user and return token + user info."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        pw_hash = hashlib.sha256(password.encode()).hexdigest()
        if not row or pw_hash != row["password_hash"]:
            raise HTTPException(status_code=401, detail="Invalid email or password")

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
