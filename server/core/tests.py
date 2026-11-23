from unittest.mock import patch

from bson import ObjectId
from django.test import SimpleTestCase
from django.test import override_settings
from rest_framework.test import APIClient
import yaml



class HealthCheckTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()

    @patch("core.views.check_mongo_connection")
    def test_health_returns_json_when_mongo_is_available(self, check_mongo):
        response = self.client.get(
            "/api/health/",
            HTTP_ORIGIN="http://localhost:5173",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(response.json()["database"], "connected")
        self.assertEqual(
            response["Access-Control-Allow-Origin"],
            "http://localhost:5173",
        )
        check_mongo.assert_called_once_with()

    @patch("core.views.check_mongo_connection", side_effect=RuntimeError("MONGODB_URI is not configured."))
    def test_health_reports_missing_database_configuration(self, check_mongo):
        response = self.client.get("/api/health/")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["status"], "degraded")
        self.assertEqual(response.json()["database"], "unavailable")

    @override_settings(MONGODB_URI="")
    def test_health_returns_503_when_atlas_uri_is_not_configured(self):
        response = self.client.get("/api/health/")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["database"], "unavailable")

    def test_api_documentation_routes_are_available(self):
        schema = self.client.get("/api/schema/")
        docs = self.client.get("/api/docs/")

        self.assertEqual(schema.status_code, 200)
        schema_document = yaml.safe_load(schema.content)
        self.assertIn("BearerAuth", schema_document["components"]["securitySchemes"])
        expected_paths = {
            "/api/health/",
            "/api/auth/register/",
            "/api/auth/login/",
            "/api/colleges/",
            "/api/courses/",
            "/api/assignments/",
            "/api/submissions/",
            "/api/admin/dashboard/",
        }
        self.assertTrue(expected_paths.issubset(schema_document["paths"]))
        college_list_schema = schema_document["paths"]["/api/colleges/"]["get"][
            "responses"
        ]["200"]["content"]["application/json"]["schema"]
        self.assertEqual(college_list_schema["type"], "array")
        self.assertEqual(
            schema_document["paths"]["/api/courses/"]["get"]["security"],
            [{"BearerAuth": []}],
        )
        self.assertEqual(docs.status_code, 200)

    def test_collection_endpoints_require_a_jwt(self):
        response = self.client.get("/api/courses/")

        self.assertEqual(response.status_code, 401)

    @patch("authentication.views.issue_token_pair", return_value={"access": "access", "refresh": "refresh"})
    @patch("authentication.views.create_user")
    def test_registration_returns_public_user_and_token_pair(self, create_user, issue_tokens):
        user = {
            "_id": ObjectId(),
            "name": "Learner",
            "email": "learner@example.com",
            "role": "student",
            "password_hash": "must-not-leak",
        }
        create_user.return_value = user

        response = self.client.post(
            "/api/auth/register/",
            {
                "name": "Learner",
                "email": "learner@example.com",
                "password": "secure-password",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["user"]["email"], user["email"])
        self.assertNotIn("password_hash", response.json()["user"])
        self.assertEqual(response.json()["access"], "access")
