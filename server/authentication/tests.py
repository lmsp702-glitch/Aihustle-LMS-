import jwt
from bson import ObjectId
from unittest.mock import patch
from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.test import SimpleTestCase
from rest_framework.test import APIClient

from authentication.jwt import AuthenticatedUser
from authentication.services import authenticate_user, create_user, issue_token_pair
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
    def test_student_registration_rejects_role_fields(self, create_user, issue_tokens):
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
                "role": "main_admin",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)

    @patch("authentication.services.collection")
    def test_duplicate_email_is_rejected(self, collection):
        users = collection.return_value
        users.create_index.return_value = "email_1"
        users.insert_one.side_effect = DuplicateKeyError("duplicate")

        with self.assertRaisesRegex(ValueError, "already exists"):
            create_user(
                name="Student",
                email="duplicate@example.com",
                password="secure-password",
                role="student",
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
