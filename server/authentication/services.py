from datetime import datetime, timedelta, timezone

import jwt
from bson import ObjectId
from bson.errors import InvalidId
from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from pymongo.errors import DuplicateKeyError

from core.mongodb import collection


VALID_ROLES = {"main_admin", "college_admin", "student"}


def create_user(name, email, password, role="student"):
    if role not in VALID_ROLES:
        raise ValueError("Invalid role.")
    if role != "student":
        raise ValueError("Only student accounts may be created by public registration.")
    users = collection("users")
    users.create_index("email", unique=True)
    user = {
        "name": name.strip(),
        "email": email.strip().lower(),
        "password_hash": make_password(password),
        "role": role,
        "is_active": True,
        "created_at": datetime.now(timezone.utc),
    }
    try:
        result = users.insert_one(user)
    except DuplicateKeyError as exc:
        raise ValueError("An account with this email already exists.") from exc
    user["_id"] = result.inserted_id
    return user


def create_privileged_user(name, email, password, role):
    if role not in {"main_admin", "college_admin"}:
        raise ValueError("Invalid privileged role.")
    users = collection("users")
    users.create_index("email", unique=True)
    user = {
        "name": name.strip(),
        "email": email.strip().lower(),
        "password_hash": make_password(password),
        "role": role,
        "is_active": True,
        "created_at": datetime.now(timezone.utc),
    }
    try:
        result = users.insert_one(user)
    except DuplicateKeyError as exc:
        raise ValueError("An account with this email already exists.") from exc
    user["_id"] = result.inserted_id
    return user


def authenticate_user(email, password):
    user = collection("users").find_one({"email": email.strip().lower()})
    if not user or not user.get("is_active", True):
        return None
    if not check_password(password, user.get("password_hash", "")):
        return None
    return user


def issue_token(user, token_type, expires_at):
    return jwt.encode(
        {
            "sub": str(user["_id"]),
            "type": token_type,
            "role": user["role"],
            "exp": expires_at,
            "iat": datetime.now(timezone.utc),
        },
        settings.SECRET_KEY,
        algorithm="HS256",
    )


def issue_token_pair(user):
    now = datetime.now(timezone.utc)
    access_expiry = now + timedelta(minutes=settings.JWT_ACCESS_TOKEN_MINUTES)
    refresh_expiry = now + timedelta(days=settings.JWT_REFRESH_TOKEN_DAYS)
    return {
        "access": issue_token(user, "access", access_expiry),
        "refresh": issue_token(user, "refresh", refresh_expiry),
        "token_type": "Bearer",
        "expires_in": settings.JWT_ACCESS_TOKEN_MINUTES * 60,
    }


def refresh_access_token(token):
    payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    if payload.get("type") != "refresh":
        raise jwt.InvalidTokenError("A refresh token is required.")
    try:
        user_id = ObjectId(payload["sub"])
    except (InvalidId, KeyError, TypeError) as exc:
        raise jwt.InvalidTokenError("The token subject is invalid.") from exc
    user = collection("users").find_one({"_id": user_id})
    if not user or not user.get("is_active", True):
        raise jwt.InvalidTokenError("The user account is unavailable.")
    expiry = datetime.now(timezone.utc) + timedelta(minutes=settings.JWT_ACCESS_TOKEN_MINUTES)
    return issue_token(user, "access", expiry)
