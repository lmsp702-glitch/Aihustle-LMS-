import jwt
from bson import ObjectId
from django.conf import settings
from django.test import SimpleTestCase
from rest_framework.test import APIClient
from unittest.mock import patch


class UserProfileAccountTypeTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = {
            "_id": ObjectId(),
            "name": "Legacy learner",
            "email": "learner@example.com",
            "role": "student",
            "accountType": "external",
            "studentType": "independent",
            "is_active": True,
            "status": "approved",
            "approvalStatus": "approved",
        }
        token = jwt.encode(
            {"sub": str(self.user["_id"]), "role": "student", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

    @patch("users.views.collection")
    @patch("authentication.jwt.collection")
    def test_legacy_account_type_is_normalized_in_profile_response(
        self,
        auth_collection,
        profile_collection,
    ):
        auth_collection.return_value.find_one.return_value = self.user
        profile_collection.return_value.find_one.return_value = self.user

        response = self.client.get("/api/users/me/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["accountType"], "hustler")
        self.assertNotIn("account_type", response.json())

    @patch("users.views.collection")
    @patch("authentication.jwt.collection")
    def test_college_student_account_type_is_preserved(
        self,
        auth_collection,
        profile_collection,
    ):
        college_user = {
            **self.user,
            "accountType": "college",
            "studentType": "college",
        }
        auth_collection.return_value.find_one.return_value = college_user
        profile_collection.return_value.find_one.return_value = college_user

        response = self.client.get("/api/users/me/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["accountType"], "college")
