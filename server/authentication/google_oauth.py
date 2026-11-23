import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import jwt
from django.conf import settings
from jwt import PyJWKClient


TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs"


class GoogleOAuthConfigurationError(Exception):
    pass


class GoogleOAuthError(Exception):
    pass


class GoogleOAuthProviderError(Exception):
    pass


def authenticate_google_authorization_code(code, redirect_uri):
    if not settings.GOOGLE_CLIENT_ID or not settings.GOOGLE_CLIENT_SECRET:
        raise GoogleOAuthConfigurationError("Google sign-in is not configured.")

    body = urlencode(
        {
            "code": code,
            "client_id": settings.GOOGLE_CLIENT_ID,
            "client_secret": settings.GOOGLE_CLIENT_SECRET,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
    ).encode("ascii")
    request = Request(
        TOKEN_ENDPOINT,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            token_response = json.loads(response.read())
    except HTTPError as exc:
        if exc.code in {400, 401}:
            raise GoogleOAuthError("Google authorization code is invalid or expired.") from exc
        raise GoogleOAuthProviderError("Google sign-in is temporarily unavailable.") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise GoogleOAuthProviderError("Google sign-in is temporarily unavailable.") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise GoogleOAuthProviderError("Google returned an invalid token response.") from exc

    if not isinstance(token_response, dict):
        raise GoogleOAuthProviderError("Google returned an invalid token response.")

    id_token = token_response.get("id_token")
    if not isinstance(id_token, str) or not id_token:
        raise GoogleOAuthError("Google did not return a valid identity token.")

    try:
        signing_key = PyJWKClient(JWKS_ENDPOINT, timeout=10).get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256"],
            audience=settings.GOOGLE_CLIENT_ID,
            issuer=("https://accounts.google.com", "accounts.google.com"),
        )
    except (jwt.PyJWTError, OSError, URLError, TimeoutError) as exc:
        raise GoogleOAuthError("Google identity could not be verified.") from exc

    email = claims.get("email")
    subject = claims.get("sub")
    authorized_party = claims.get("azp")
    email_verified = claims.get("email_verified") is True or claims.get("email_verified") == "true"
    if (
        not email_verified
        or not isinstance(email, str)
        or not email.strip()
        or not isinstance(subject, str)
        or not subject
        or (authorized_party and authorized_party != settings.GOOGLE_CLIENT_ID)
    ):
        raise GoogleOAuthError("Google identity could not be verified.")

    return {
        "email": email.strip().lower(),
        "name": claims.get("name") if isinstance(claims.get("name"), str) else "",
        "subject": subject,
    }
