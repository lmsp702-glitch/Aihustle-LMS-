from datetime import datetime, timedelta, timezone
import hashlib
import re

import jwt
from bson import ObjectId
from cryptography.hazmat.primitives.asymmetric import rsa
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs
from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIClient

from authentication.jwt import AuthenticatedUser
from authentication.google_oauth import (
    GoogleOAuthError,
    authenticate_google_authorization_code,
)
from authentication.services import (
    authenticate_user,
    consume_registration_email_verification,
    create_user,
    get_or_create_google_user,
    issue_token_pair,
    send_registration_email_code,
    verify_registration_email_code,
)
from pymongo.errors import DuplicateKeyError
from authentication.permissions import (
    IsMainAdmin,
    IsCollegeAdmin,
)


class AuthenticationTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()

    @patch("authentication.views.issue_token_pair", return_value={"access": "access", "refresh": "refresh"})
    @patch("authentication.views.create_user")
    def test_student_registration_rejects_privilege_escalation(self, create_user, issue_tokens):
        create_user.return_value = {
            "_id": ObjectId(),
            "name": "Student",
            "email": "student@example.com",
            "role": "student",
            "password_hash": "must-not-leak",
        }
        response = self.client.post(
            "/api/auth/register/",
            {
                "name": "Student",
                "email": "student@example.com",
                "password": "secure-password",
                "confirmPassword": "secure-password",
                "username": "student",
                "emailVerificationToken": "verified-token",
                "role": "main_admin",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        create_user.assert_not_called()

    def test_registration_does_not_silently_discard_referral_code(self):
        response = self.client.post(
            "/api/auth/register/",
            {
                "fullName": "Student",
                "email": "student@example.com",
                "username": "student",
                "password": "secure-password",
                "confirmPassword": "secure-password",
                "emailVerificationToken": "verified-token",
                "role": "student",
                "accountType": "independent",
                "referralCode": "REFERRAL-123",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 501)
        self.assertIn("Referral-code", response.json()["message"])

    @patch("student_api.views.collection")
    def test_referral_validation_route_returns_json_for_an_invalid_code(self, collection):
        collection.return_value.find_one.return_value = None
        response = self.client.post(
            "/api/referrals/validate",
            {"code": "REFERRAL-123"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["valid"])

    @patch("authentication.services.collection")
    def test_duplicate_email_is_rejected(self, collection):
        users = collection.return_value
        users.create_index.return_value = "email_1"
        users.insert_one.side_effect = DuplicateKeyError("duplicate")

        with self.assertRaisesRegex(ValueError, "already in use"):
            create_user(
                name="Student",
                email="duplicate@example.com",
                password="secure-password",
                role="student",
                username="duplicate",
            )

    @patch("authentication.services.collection")
    def test_login_accepts_correct_password_and_rejects_incorrect_password(self, collection):
        password_hash = make_password("secure-password")
        user = {
            "_id": ObjectId(),
            "email": "student@example.com",
            "role": "student",
            "is_active": True,
            "password_hash": password_hash,
        }
        collection.return_value.find_one.return_value = user

        self.assertIsNotNone(
            authenticate_user("student@example.com", "secure-password")
        )
        self.assertIsNone(
            authenticate_user("student@example.com", "wrong-password")
        )

    @patch("authentication.services.collection")
    def test_create_user_marks_account_as_external(self, collection):
        users = collection.return_value
        users.insert_one.return_value.inserted_id = ObjectId()

        user = create_user(
            name="External Learner",
            email="learner@example.com",
            password="secure-password",
            username="external.learner",
        )

        stored_user = users.insert_one.call_args.args[0]
        self.assertEqual(user["accountType"], "external")
        self.assertEqual(user["studentType"], "independent")
        self.assertEqual(stored_user["accountType"], "external")
        self.assertEqual(stored_user["username"], "external.learner")

    @patch("authentication.services.collection")
    @patch("authentication.services.create_user")
    def test_google_creates_an_external_user_for_a_new_email(self, create, collection):
        users = collection.return_value
        users.find_one.return_value = None
        created_user = {
            "_id": ObjectId(),
            "email": "new-google@example.com",
            "role": "student",
            "accountType": "external",
            "studentType": "independent",
            "is_active": True,
        }
        create.return_value = created_user

        result = get_or_create_google_user(
            {"email": "new-google@example.com", "name": "Google Learner"}
        )

        self.assertIs(result, created_user)
        self.assertEqual(create.call_args.kwargs["role"], "student")
        self.assertEqual(create.call_args.kwargs["username"], "new-google")

    @patch("authentication.services.collection")
    def test_google_does_not_convert_existing_non_external_account(self, collection):
        existing_user = {
            "_id": ObjectId(),
            "email": "institutional@example.com",
            "role": "student",
            "accountType": "institutional",
            "is_active": True,
        }
        collection.return_value.find_one.return_value = existing_user

        with self.assertRaisesRegex(ValueError, "not linked to an External User"):
            get_or_create_google_user({"email": "institutional@example.com"})

    @patch("authentication.services.collection")
    def test_google_logs_in_existing_external_user_without_rewriting_it(self, collection):
        existing_user = {
            "_id": ObjectId(),
            "email": "external@example.com",
            "role": "student",
            "accountType": "external",
            "studentType": "independent",
            "is_active": True,
        }
        collection.return_value.find_one.return_value = existing_user

        result = get_or_create_google_user({"email": "external@example.com"})

        self.assertIs(result, existing_user)
        collection.return_value.update_one.assert_not_called()
        collection.return_value.insert_one.assert_not_called()

    @override_settings(EMAIL_HOST="smtp.example.com", DEFAULT_FROM_EMAIL="lms@example.com")
    @patch("authentication.services.send_mail", return_value=1)
    @patch("authentication.services.collection")
    def test_email_verification_code_is_hashed_and_sent(
        self, collection, send_mail
    ):
        users, challenges = collection.side_effect = (MagicMock(), MagicMock())
        users.find_one.return_value = None
        challenges.find_one.return_value = None

        retry_after = send_registration_email_code("Learner@Example.com")

        stored_challenge = challenges.update_one.call_args.args[1]["$set"]
        sent_code = re.search(r"\b(\d{6})\b", send_mail.call_args.args[1]).group(1)
        self.assertEqual(retry_after, 60)
        self.assertEqual(stored_challenge["email"], "learner@example.com")
        self.assertNotEqual(stored_challenge["code_hash"], sent_code)
        self.assertTrue(check_password(sent_code, stored_challenge["code_hash"]))

    @patch("authentication.services.collection")
    def test_email_verification_returns_one_time_registration_token(self, collection):
        challenge = {
            "_id": ObjectId(),
            "code_hash": make_password("123456"),
            "attempts": 0,
        }
        challenges = collection.return_value
        challenges.find_one.return_value = challenge
        challenges.update_one.return_value.modified_count = 1

        token = verify_registration_email_code("learner@example.com", "123456")

        update = challenges.update_one.call_args.args[1]
        self.assertTrue(token)
        self.assertEqual(
            update["$set"]["verified_token_hash"],
            hashlib.sha256(token.encode("utf-8")).hexdigest(),
        )
        self.assertNotIn("code_hash", update["$set"])

    @patch("authentication.services.collection")
    def test_registration_verification_token_is_consumed_once(self, collection):
        token = "verification-token"
        collection.return_value.delete_one.return_value.deleted_count = 1

        self.assertTrue(
            consume_registration_email_verification(
                "learner@example.com",
                token,
            )
        )
        self.assertEqual(
            collection.return_value.delete_one.call_args.args[0][
                "verified_token_hash"
            ],
            hashlib.sha256(token.encode("utf-8")).hexdigest(),
        )

    def test_jwt_pair_contains_role_and_identifies_user(self):
        user = {
            "_id": ObjectId(),
            "role": "college_admin",
            "email": "college@example.com",
        }

        pair = issue_token_pair(user)

        access_payload = jwt.decode(
            pair["access"],
            settings.SECRET_KEY,
            algorithms=["HS256"],
        )
        refresh_payload = jwt.decode(
            pair["refresh"],
            settings.SECRET_KEY,
            algorithms=["HS256"],
        )
        self.assertEqual(access_payload["role"], "college_admin")
        self.assertEqual(refresh_payload["type"], "refresh")
        self.assertEqual(access_payload["type"], "access")

    def test_invalid_access_token_is_rejected(self):
        response = self.client.get(
            "/api/auth/me/",
            HTTP_AUTHORIZATION="Bearer invalid-token",
        )

        self.assertEqual(response.status_code, 401)

    def test_refresh_token_cannot_be_used_as_access_token(self):
        user = {"_id": ObjectId(), "role": "student"}
        pair = issue_token_pair(user)

        response = self.client.get(
            "/api/auth/me/",
            HTTP_AUTHORIZATION=f"Bearer {pair['refresh']}",
        )

        self.assertEqual(response.status_code, 401)

    @patch("authentication.views.issue_token_pair")
    @patch("authentication.views.authenticate_user")
    def test_login_accepts_username_and_returns_token_pair(
        self, authenticate, issue_tokens
    ):
        user = {
            "_id": ObjectId(),
            "name": "Learner",
            "email": "learner@example.com",
            "username": "learner",
            "role": "student",
            "accountType": "external",
            "studentType": "independent",
            "is_active": True,
        }
        authenticate.return_value = user
        issue_tokens.return_value = {"access": "access", "refresh": "refresh"}

        response = self.client.post(
            "/api/auth/login/",
            {"identifier": "learner", "password": "secure-password", "role": "student"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["refresh"], "refresh")
        self.assertEqual(response.json()["user"]["accountType"], "external")
        authenticate.assert_called_once_with(
            email="learner",
            password="secure-password",
        )

    @patch("authentication.views.refresh_access_token", return_value="new-access")
    @patch("authentication.views.collection")
    def test_refresh_returns_user_and_preserves_refresh_token(
        self, collection, refresh_access
    ):
        user = {
            "_id": ObjectId(),
            "name": "Learner",
            "email": "learner@example.com",
            "username": "learner",
            "role": "student",
            "accountType": "external",
            "studentType": "independent",
            "is_active": True,
        }
        collection.return_value.find_one.return_value = user
        pair = issue_token_pair(user)

        response = self.client.post(
            "/api/auth/refresh/",
            {"refresh": pair["refresh"]},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["token"], "new-access")
        self.assertEqual(response.json()["refresh"], pair["refresh"])
        self.assertEqual(response.json()["user"]["accountType"], "external")
        refresh_access.assert_called_once_with(pair["refresh"])

    @patch("authentication.jwt.collection")
    def test_student_dashboard_session_returns_user_envelope(self, collection):
        user = {
            "_id": ObjectId(),
            "name": "Learner",
            "email": "learner@example.com",
            "username": "learner",
            "role": "student",
            "accountType": "external",
            "studentType": "independent",
            "is_active": True,
            "status": "active",
        }
        collection.return_value.find_one.return_value = user
        pair = issue_token_pair(user)

        response = self.client.get(
            "/api/auth/dashboard/student",
            HTTP_AUTHORIZATION=f"Bearer {pair['access']}",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"]["role"], "student")
        self.assertEqual(response.json()["user"]["accountType"], "external")
        self.assertEqual(response.json()["user"]["isActive"], True)

    @patch("authentication.jwt.collection")
    def test_student_dashboard_rejects_mismatched_role(self, collection):
        user = {
            "_id": ObjectId(),
            "email": "admin@example.com",
            "name": "Admin",
            "role": "main_admin",
            "is_active": True,
        }
        collection.return_value.find_one.return_value = user
        pair = issue_token_pair(user)

        response = self.client.get(
            "/api/auth/dashboard/student",
            HTTP_AUTHORIZATION=f"Bearer {pair['access']}",
        )

        self.assertEqual(response.status_code, 403)

    @patch("authentication.views.collection")
    def test_username_availability_returns_suggestions_for_taken_name(self, collection):
        collection.return_value.find_one.side_effect = [
            {"username": "learner"},
            None,
            None,
            None,
        ]

        response = self.client.get("/api/auth/check-username?username=learner")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["available"])
        self.assertEqual(len(response.json()["suggestions"]), 3)

    @patch(
        "authentication.views.send_registration_email_code",
        return_value=60,
    )
    def test_registration_email_send_route(self, send_code):
        response = self.client.post(
            "/api/auth/registration/email/send",
            {"email": "Learner@Example.com"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["retryAfterSeconds"], 60)
        send_code.assert_called_once_with("learner@example.com")

    @patch(
        "authentication.views.verify_registration_email_code",
        return_value="one-time-token",
    )
    def test_registration_email_verify_route(self, verify_code):
        response = self.client.post(
            "/api/auth/registration/email/verify",
            {"email": "Learner@Example.com", "code": "123456"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["emailVerificationToken"], "one-time-token")
        verify_code.assert_called_once_with("learner@example.com", "123456")

    def test_main_admin_permission_allows_only_main_admin(self):
        view = object()
        request = type("Request", (), {})()
        permission = IsMainAdmin()

        request.user = AuthenticatedUser(
            id="1",
            email="main@example.com",
            name="Main",
            role="main_admin",
        )
        self.assertTrue(permission.has_permission(request, view))

        request.user.role = "college_admin"
        self.assertFalse(permission.has_permission(request, view))

    def test_college_admin_permission_allows_only_college_admin(self):
        permission = IsCollegeAdmin()
        request = type("Request", (), {})()
        request.user = AuthenticatedUser(
            id="1",
            email="college@example.com",
            name="College",
            role="college_admin",
        )

        self.assertTrue(permission.has_permission(request, object()))

        request.user.role = "student"
        self.assertFalse(permission.has_permission(request, object()))


@override_settings(
    GOOGLE_CLIENT_ID="test-google-client-id",
    GOOGLE_CLIENT_SECRET="test-google-client-secret",
)
class GoogleLoginTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.google_private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
        )
        cls.google_public_key = cls.google_private_key.public_key()

    def setUp(self):
        self.client = APIClient()
        self.headers = {
            "HTTP_ORIGIN": "http://localhost:5173",
            "HTTP_X_REQUESTED_WITH": "XmlHttpRequest",
        }

    def make_google_id_token(self, email_verified=True):
        now = datetime.now(timezone.utc)
        return jwt.encode(
            {
                "iss": "https://accounts.google.com",
                "aud": settings.GOOGLE_CLIENT_ID,
                "sub": "google-subject",
                "email": "verified@example.com",
                "email_verified": email_verified,
                "iat": now,
                "exp": now + timedelta(minutes=5),
            },
            self.google_private_key,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )

    @patch("authentication.views.issue_token_pair")
    @patch("authentication.views.get_or_create_google_user")
    @patch("authentication.views.authenticate_google_authorization_code")
    def test_google_login_returns_frontend_token_response(
        self, authenticate_code, get_user, issue_tokens
    ):
        identity = {
            "email": "google-user@example.com",
            "name": "Google User",
            "subject": "google-subject",
        }
        user = {
            "_id": ObjectId(),
            "email": identity["email"],
            "name": identity["name"],
            "role": "student",
            "accountType": "external",
            "studentType": "independent",
        }
        authenticate_code.return_value = identity
        get_user.return_value = user
        issue_tokens.return_value = {
            "access": "access-token",
            "refresh": "refresh-token",
            "token_type": "Bearer",
            "expires_in": 1800,
        }

        response = self.client.post(
            "/api/auth/google",
            {
                "code": "authorization-code",
                "role": "student",
                "email": "untrusted@example.com",
            },
            format="json",
            **self.headers,
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["token"], "access-token")
        self.assertEqual(response.json()["refresh"], "refresh-token")
        self.assertEqual(response.json()["user"]["email"], identity["email"])
        self.assertEqual(response.json()["user"]["role"], "student")
        self.assertEqual(response.json()["user"]["accountType"], "external")
        authenticate_code.assert_called_once_with(
            "authorization-code",
            redirect_uri="http://localhost:5173",
        )
        get_user.assert_called_once_with(identity)
        issue_tokens.assert_called_once_with(user)

    @patch("authentication.views.authenticate_google_authorization_code")
    def test_google_login_rejects_untrusted_origin(self, authenticate_code):
        response = self.client.post(
            "/api/auth/google",
            {"code": "authorization-code"},
            format="json",
            HTTP_ORIGIN="https://attacker.example",
            HTTP_X_REQUESTED_WITH="XmlHttpRequest",
        )

        self.assertEqual(response.status_code, 403)
        authenticate_code.assert_not_called()

    @patch("authentication.views.authenticate_google_authorization_code")
    def test_google_login_requires_google_popup_request_header(self, authenticate_code):
        response = self.client.post(
            "/api/auth/google",
            {"code": "authorization-code"},
            format="json",
            HTTP_ORIGIN="http://localhost:5173",
        )

        self.assertEqual(response.status_code, 403)
        authenticate_code.assert_not_called()

    @patch("authentication.views.authenticate_google_authorization_code")
    def test_google_login_rejects_non_student_role(self, authenticate_code):
        response = self.client.post(
            "/api/auth/google",
            {"code": "authorization-code", "role": "main_admin"},
            format="json",
            **self.headers,
        )

        self.assertEqual(response.status_code, 400)
        authenticate_code.assert_not_called()

    @patch("authentication.google_oauth.PyJWKClient")
    @patch("authentication.google_oauth.urlopen")
    def test_google_authorization_code_is_exchanged_and_identity_verified(
        self, urlopen, jwk_client
    ):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = (
            ('{"id_token":"' + self.make_google_id_token() + '"}').encode("ascii")
        )
        urlopen.return_value = response
        jwk_client.return_value.get_signing_key_from_jwt.return_value = SimpleNamespace(
            key=self.google_public_key
        )

        identity = authenticate_google_authorization_code(
            "authorization-code",
            redirect_uri="http://localhost:5173",
        )

        token_request = urlopen.call_args.args[0]
        token_request_form = parse_qs(token_request.data.decode("ascii"))
        self.assertEqual(token_request_form["code"], ["authorization-code"])
        self.assertEqual(token_request_form["redirect_uri"], ["http://localhost:5173"])
        self.assertTrue(token_request_form.get("client_id"))
        self.assertTrue(token_request_form.get("client_secret"))
        self.assertEqual(identity["email"], "verified@example.com")
        self.assertEqual(identity["subject"], "google-subject")

    @patch("authentication.google_oauth.PyJWKClient")
    @patch("authentication.google_oauth.urlopen")
    def test_google_authorization_code_rejects_unverified_email(
        self, urlopen, jwk_client
    ):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = (
            ('{"id_token":"' + self.make_google_id_token(email_verified=False) + '"}').encode(
                "ascii"
            )
        )
        urlopen.return_value = response
        jwk_client.return_value.get_signing_key_from_jwt.return_value = SimpleNamespace(
            key=self.google_public_key
        )

        with self.assertRaises(GoogleOAuthError):
            authenticate_google_authorization_code(
                "authorization-code",
                redirect_uri="http://localhost:5173",
            )
