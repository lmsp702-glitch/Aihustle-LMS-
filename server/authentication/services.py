from datetime import datetime, timedelta, timezone
import hashlib
import re
import secrets
import smtplib

import jwt
from bson import ObjectId
from bson.errors import InvalidId
from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.core.mail import BadHeaderError, send_mail
from pymongo.errors import DuplicateKeyError

from core.mongodb import collection


VALID_ROLES = {"main_admin", "college_admin", "student"}
EMAIL_VERIFICATION_TTL = timedelta(minutes=10)
EMAIL_VERIFICATION_RESEND_DELAY = timedelta(seconds=60)
EMAIL_VERIFICATION_MAX_ATTEMPTS = 5


class EmailVerificationConfigurationError(Exception):
    pass


class EmailVerificationDeliveryError(Exception):
    pass


class EmailVerificationRateLimitError(Exception):
    def __init__(self, retry_after_seconds):
        self.retry_after_seconds = retry_after_seconds
        super().__init__("Please wait before requesting another verification code.")


def create_user(
    name,
    email,
    password,
    role="student",
    username=None,
    registration_details=None,
):
    if role not in VALID_ROLES:
        raise ValueError("Invalid role.")
    if role != "student":
        raise ValueError("Only student accounts may be created by public registration.")
    if not username:
        raise ValueError("A username is required for external accounts.")
    if not re.fullmatch(r"[a-zA-Z0-9._-]{3,30}", username.strip()):
        raise ValueError("Username must contain 3 to 30 valid characters.")
    users = collection("users")
    users.create_index("email", unique=True)
    users.create_index(
        [("username", 1)],
        unique=True,
        partialFilterExpression={"username": {"$type": "string"}},
        name="username_unique",
    )
    normalized_email = email.strip().lower()
    normalized_username = username.strip().lower()
    user = {
        "name": name.strip(),
        "fullName": name.strip(),
        "email": normalized_email,
        "username": normalized_username,
        "password_hash": make_password(password),
        "role": role,
        "accountType": "external",
        "studentType": "independent",
        "is_active": True,
        "status": "active",
        "email_verified": True,
        "created_at": datetime.now(timezone.utc),
    }
    if registration_details:
        user["registrationDetails"] = registration_details
    try:
        result = users.insert_one(user)
    except DuplicateKeyError as exc:
        raise ValueError("The email or username is already in use.") from exc
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
    identifier = email.strip().lower()
    user = collection("users").find_one(
        {"$or": [{"email": identifier}, {"username": identifier}]}
    )
    if not user or not user.get("is_active", True):
        return None
    if not check_password(password, user.get("password_hash", "")):
        return None
    return user


def get_or_create_google_user(identity):
    email = identity["email"].strip().lower()
    users = collection("users")
    user = users.find_one({"email": email})
    if user is None:
        name = identity.get("name") or email.split("@", 1)[0]
        username = _google_username(users, email)
        try:
            return create_user(
                name=name,
                email=email,
                password=secrets.token_urlsafe(32),
                username=username,
                role="student",
            )
        except ValueError:
            user = users.find_one({"email": email})
            if user is None:
                raise

    if user.get("role") != "student" or user.get("accountType") != "external":
        raise ValueError("This Google account is not linked to an External User account.")
    if not user.get("is_active", True):
        raise ValueError("This Google account is inactive.")
    return user


def _google_username(users, email):
    base = re.sub(r"[^a-z0-9._-]", "", email.split("@", 1)[0].lower()).strip("._-")
    base = (base or "learner")[:24]
    if len(base) < 3:
        base = f"{base}user"
    for suffix in range(1000):
        username = base if suffix == 0 else f"{base[:24-len(str(suffix))]}{suffix}"
        if users.find_one({"username": username}) is None:
            return username
    raise ValueError("A unique username could not be generated for this Google account.")


def send_registration_email_code(email):
    if not settings.EMAIL_HOST or not settings.DEFAULT_FROM_EMAIL:
        raise EmailVerificationConfigurationError(
            "Email verification is not configured on the server."
        )
    if settings.EMAIL_USE_TLS and settings.EMAIL_USE_SSL:
        raise EmailVerificationConfigurationError(
            "Email server TLS settings are inconsistent."
        )

    normalized_email = email.strip().lower()
    users = collection("users")
    if users.find_one({"email": normalized_email}):
        raise ValueError("An account with this email already exists.")

    challenges = collection("email_verifications")
    challenges.create_index("email", unique=True, name="email_verification_email_unique")
    challenges.create_index(
        "expires_at",
        expireAfterSeconds=0,
        name="email_verification_expiry",
    )
    now = datetime.now(timezone.utc)
    previous = challenges.find_one({"email": normalized_email})
    if previous and previous.get("sent_at"):
        sent_at = previous["sent_at"]
        if sent_at.tzinfo is None:
            sent_at = sent_at.replace(tzinfo=timezone.utc)
        elapsed = (now - sent_at).total_seconds()
        if elapsed < EMAIL_VERIFICATION_RESEND_DELAY.total_seconds():
            raise EmailVerificationRateLimitError(
                max(1, int(EMAIL_VERIFICATION_RESEND_DELAY.total_seconds() - elapsed))
            )

    code = f"{secrets.randbelow(1_000_000):06d}"
    challenge_id = secrets.token_urlsafe(18)
    challenges.update_one(
        {"email": normalized_email},
        {
            "$set": {
                "email": normalized_email,
                "challenge_id": challenge_id,
                "code_hash": make_password(code),
                "attempts": 0,
                "sent_at": now,
                "expires_at": now + EMAIL_VERIFICATION_TTL,
            },
            "$unset": {"verified_token_hash": "", "verified_until": ""},
        },
        upsert=True,
    )
    try:
        sent_count = send_mail(
            "Verify your aiHustle LMS email",
            (
                f"Your email verification code is {code}. "
                "It expires in 10 minutes. If you did not request this, ignore this email."
            ),
            settings.DEFAULT_FROM_EMAIL,
            [normalized_email],
            fail_silently=False,
        )
    except (OSError, smtplib.SMTPException, BadHeaderError) as exc:
        challenges.delete_one(
            {"email": normalized_email, "challenge_id": challenge_id}
        )
        raise EmailVerificationDeliveryError(
            "The verification email could not be sent."
        ) from exc
    if sent_count != 1:
        challenges.delete_one(
            {"email": normalized_email, "challenge_id": challenge_id}
        )
        raise EmailVerificationDeliveryError(
            "The verification email could not be sent."
        )
    return EMAIL_VERIFICATION_RESEND_DELAY.seconds


def verify_registration_email_code(email, code):
    normalized_email = email.strip().lower()
    now = datetime.now(timezone.utc)
    challenges = collection("email_verifications")
    challenge = challenges.find_one(
        {"email": normalized_email, "expires_at": {"$gt": now}}
    )
    if not challenge or not challenge.get("code_hash"):
        raise ValueError("The verification code is invalid or expired.")
    if challenge.get("attempts", 0) >= EMAIL_VERIFICATION_MAX_ATTEMPTS:
        raise ValueError("Too many incorrect codes. Request a new verification email.")
    if not check_password(code, challenge["code_hash"]):
        challenges.update_one(
            {
                "_id": challenge["_id"],
                "attempts": {"$lt": EMAIL_VERIFICATION_MAX_ATTEMPTS},
            },
            {"$inc": {"attempts": 1}},
        )
        raise ValueError("The verification code is invalid or expired.")

    verification_token = secrets.token_urlsafe(32)
    result = challenges.update_one(
        {
            "_id": challenge["_id"],
            "code_hash": challenge["code_hash"],
            "attempts": {"$lt": EMAIL_VERIFICATION_MAX_ATTEMPTS},
            "expires_at": {"$gt": now},
        },
        {
            "$set": {
                "verified_token_hash": hashlib.sha256(
                    verification_token.encode("utf-8")
                ).hexdigest(),
                "verified_until": now + EMAIL_VERIFICATION_TTL,
                "expires_at": now + EMAIL_VERIFICATION_TTL,
            },
            "$unset": {"code_hash": ""},
        },
    )
    if result.modified_count != 1:
        raise ValueError("The verification code is invalid or expired.")
    return verification_token


def consume_registration_email_verification(email, verification_token):
    token_hash = hashlib.sha256(verification_token.encode("utf-8")).hexdigest()
    result = collection("email_verifications").delete_one(
        {
            "email": email.strip().lower(),
            "verified_token_hash": token_hash,
            "verified_until": {"$gt": datetime.now(timezone.utc)},
        }
    )
    return result.deleted_count == 1


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
