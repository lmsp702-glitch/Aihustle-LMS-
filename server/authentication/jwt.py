from dataclasses import dataclass

import jwt
from bson import ObjectId
from bson.errors import InvalidId
from django.conf import settings
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from authentication.approval import hustler_access_error, normalize_account_type
from core.mongodb import collection


@dataclass
class AuthenticatedUser:
    id: str
    email: str
    name: str
    role: str
    username: str = None
    account_type: str = None
    student_type: str = None
    status: str = "active"
    college_id: str = None
    approval_status: str = None
    is_active: bool = True
    is_authenticated: bool = True


class JWTAuthentication(BaseAuthentication):
    def authenticate(self, request):
        authorization = request.headers.get("Authorization", "")
        if not authorization:
            return None
        parts = authorization.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            raise AuthenticationFailed("Authorization header must use Bearer token format.")
        try:
            payload = jwt.decode(parts[1], settings.SECRET_KEY, algorithms=["HS256"])
            if payload.get("type") != "access":
                raise AuthenticationFailed("An access token is required.")
            user_id = ObjectId(payload["sub"])
        except (jwt.InvalidTokenError, InvalidId, KeyError, TypeError) as exc:
            raise AuthenticationFailed("Invalid or expired access token.") from exc

        document = collection("users").find_one({"_id": user_id})
        if not document or not document.get("is_active", True):
            raise AuthenticationFailed("User account is unavailable.")
        if payload.get("role") != document.get("role"):
            raise AuthenticationFailed("Token role is no longer valid.")
        approval_error = hustler_access_error(document)
        if approval_error:
            raise AuthenticationFailed(approval_error)
        user = AuthenticatedUser(
            id=str(document["_id"]),
            email=document["email"],
            name=document.get("name", ""),
            role=document.get("role", "student"),
            username=document.get("username"),
            account_type=normalize_account_type(document),
            student_type=document.get("studentType"),
            status=document.get("status", "active"),
            approval_status=document.get("approvalStatus"),
            college_id=(
                str(document.get("collegeId") or document.get("college_id"))
                if document.get("collegeId") or document.get("college_id")
                else None
            ),
        )
        return user, parts[1]

    def authenticate_header(self, request):
        return "Bearer"
