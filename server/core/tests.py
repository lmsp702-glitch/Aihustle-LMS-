from unittest.mock import MagicMock, patch

from bson import ObjectId
from django.test import SimpleTestCase
from django.test import override_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient
import yaml

from core.cloudinary_storage import (
    CloudinaryConfigurationError,
    MediaValidationError,
    configure_cloudinary,
    create_signed_upload,
    delete_media,
    get_media_metadata,
    upload_media,
)


class CloudinaryStorageTests(SimpleTestCase):
    cloudinary_settings = {
        "CLOUDINARY_CLOUD_NAME": "test-cloud",
        "CLOUDINARY_API_KEY": "test-key",
        "CLOUDINARY_API_SECRET": "test-secret",
    }

    @override_settings(**cloudinary_settings)
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_cloudinary_configuration_uses_server_settings(self, config):
        configure_cloudinary()

        config.assert_called_once_with(
            cloud_name="test-cloud",
            api_key="test-key",
            api_secret="test-secret",
            secure=True,
        )

    @override_settings(
        CLOUDINARY_CLOUD_NAME="",
        CLOUDINARY_API_KEY="test-key",
        CLOUDINARY_API_SECRET="test-secret",
    )
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_cloudinary_configuration_rejects_missing_values(self, config):
        with self.assertRaises(CloudinaryConfigurationError):
            configure_cloudinary()

        config.assert_not_called()

    @override_settings(**cloudinary_settings)
    @patch(
        "core.cloudinary_storage.uploader.upload",
        return_value={
            "secure_url": "https://res.cloudinary.com/test-cloud/image/upload/example.png",
            "public_id": "aihustle-lms/course-thumbnail/example",
            "resource_type": "image",
            "format": "png",
            "bytes": 12,
            "width": 1,
            "height": 1,
            "version": 1,
        },
    )
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_upload_returns_only_public_metadata(self, config, upload):
        upload_file = SimpleUploadedFile(
            "cover.png",
            b"\x89PNG\r\n\x1a\nmore",
            content_type="image/png",
        )

        metadata = upload_media(
            upload_file,
            "course_thumbnail",
            owner_id="admin-1",
        )

        self.assertEqual(metadata["secureUrl"].split("/")[0], "https:")
        self.assertEqual(metadata["publicId"], "aihustle-lms/course-thumbnail/example")
        self.assertEqual(metadata["resourceType"], "image")
        self.assertNotIn("apiSecret", metadata)
        self.assertNotIn("test-secret", repr(metadata))
        upload.assert_called_once()

    @override_settings(**cloudinary_settings)
    @patch("core.cloudinary_storage.uploader.upload")
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_upload_rejects_disallowed_file_before_cloudinary_call(self, config, upload):
        upload_file = SimpleUploadedFile(
            "cover.svg",
            b"<svg></svg>",
            content_type="image/svg+xml",
        )

        with self.assertRaises(MediaValidationError):
            upload_media(
                upload_file,
                "course_thumbnail",
                owner_id="admin-1",
            )

        upload.assert_not_called()

    @override_settings(**cloudinary_settings)
    @patch("core.cloudinary_storage.uploader.upload")
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_upload_rejects_mismatched_contents_and_oversized_files(self, config, upload):
        mismatched = SimpleUploadedFile(
            "cover.png",
            b"%PDF-1.4 not an image",
            content_type="image/png",
        )
        with self.assertRaises(MediaValidationError):
            upload_media(mismatched, "course_thumbnail", owner_id="admin-1")

        oversized = MagicMock()
        oversized.name = "cover.png"
        oversized.size = 10 * 1024 * 1024 + 1
        oversized.content_type = "image/png"
        with self.assertRaises(MediaValidationError):
            upload_media(oversized, "course_thumbnail", owner_id="admin-1")

        upload.assert_not_called()

    @override_settings(**cloudinary_settings)
    @patch(
        "core.cloudinary_storage.uploader.upload",
        return_value={
            "secure_url": "https://res.cloudinary.com/test-cloud/raw/upload/material.pdf",
            "public_id": "aihustle-lms/course_pdf/admin-1/material",
            "resource_type": "raw",
            "format": "pdf",
            "bytes": 14,
        },
    )
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_pdf_upload_uses_raw_cloudinary_resource_type(self, config, upload):
        pdf = SimpleUploadedFile("lesson.pdf", b"%PDF-1.4 sample", content_type="application/pdf")

        metadata = upload_media(pdf, "course_pdf", owner_id="admin-1")

        self.assertEqual(metadata["resourceType"], "raw")
        self.assertEqual(upload.call_args.kwargs["resource_type"], "raw")

    @override_settings(**cloudinary_settings)
    @patch(
        "core.cloudinary_storage.uploader.upload",
        return_value={
            "secure_url": "https://res.cloudinary.com/test-cloud/video/upload/lesson.mp4",
            "public_id": "aihustle-lms/course_video/admin-1/lesson",
            "resource_type": "video",
            "format": "mp4",
            "bytes": 16,
            "duration": 5,
        },
    )
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_video_upload_uses_video_cloudinary_resource_type(self, config, upload):
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake",
            content_type="video/mp4",
        )

        metadata = upload_media(video, "course_video", owner_id="admin-1")

        self.assertEqual(metadata["resourceType"], "video")
        self.assertEqual(upload.call_args.kwargs["resource_type"], "video")

    @override_settings(**cloudinary_settings)
    @patch(
        "core.cloudinary_storage.api.resource",
        return_value={
            "secure_url": "https://res.cloudinary.com/test-cloud/image/upload/thumbnail.png",
            "public_id": "aihustle-lms/course-thumbnail/thumbnail",
            "resource_type": "image",
            "format": "png",
            "bytes": 20,
            "width": 100,
            "height": 100,
        },
    )
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_direct_upload_metadata_is_fetched_from_cloudinary(self, config, resource):
        metadata = get_media_metadata(
            "aihustle-lms/course-thumbnail/thumbnail",
            "image",
        )

        self.assertEqual(metadata["bytes"], 20)
        self.assertEqual(metadata["secureUrl"].split("/")[0], "https:")
        self.assertNotIn("apiSecret", metadata)
        resource.assert_called_once_with(
            "aihustle-lms/course-thumbnail/thumbnail",
            resource_type="image",
            type="upload",
        )

    @override_settings(**cloudinary_settings)
    @patch("core.cloudinary_storage.api_sign_request", return_value="signed-value")
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_thumbnail_signature_never_returns_the_api_secret(self, config, sign):
        signature = create_signed_upload()

        self.assertEqual(signature["apiKey"], "test-key")
        self.assertEqual(signature["cloudName"], "test-cloud")
        self.assertEqual(signature["signature"], "signed-value")
        self.assertNotIn("apiSecret", signature)
        self.assertNotIn("test-secret", repr(signature))
        sign.assert_called_once()

    @override_settings(**cloudinary_settings)
    @patch("core.cloudinary_storage.uploader.destroy", return_value={"result": "ok"})
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_delete_uses_server_credentials_and_validates_asset_scope(self, config, destroy):
        result = delete_media(
            "aihustle-lms/courses/course-1/asset-1",
            "video",
        )

        self.assertEqual(result, "ok")
        destroy.assert_called_once_with(
            "aihustle-lms/courses/course-1/asset-1",
            resource_type="video",
            invalidate=True,
        )
        with self.assertRaises(MediaValidationError):
            delete_media("another-account/asset", "image")


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
    @patch("authentication.views.consume_registration_email_verification", return_value=True)
    @patch("authentication.views.collection")
    @patch("authentication.views.create_user")
    def test_registration_returns_pending_public_hustler_without_tokens(
        self, create_user, collection, consume_verification, issue_tokens
    ):
        collection.return_value.find_one.return_value = None
        user = {
            "_id": ObjectId(),
            "name": "Learner",
            "email": "learner@example.com",
            "username": "learner",
            "role": "student",
            "accountType": "external",
            "studentType": "independent",
            "status": "pending",
            "approvalStatus": "pending",
            "is_active": True,
            "password_hash": "must-not-leak",
        }
        create_user.return_value = user

        response = self.client.post(
            "/api/auth/register/",
            {
                "fullName": "Learner",
                "email": "learner@example.com",
                "username": "learner",
                "password": "secure-password",
                "confirmPassword": "secure-password",
                "emailVerificationToken": "verified-token",
                "role": "student",
                "accountType": "independent",
                "registrationDetails": {"educationLevel": "college"},
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["user"]["email"], user["email"])
        self.assertEqual(response.json()["user"]["accountType"], "hustler")
        self.assertEqual(response.json()["user"]["studentType"], "independent")
        self.assertEqual(response.json()["user"]["approvalStatus"], "pending")
        self.assertNotIn("password_hash", response.json()["user"])
        self.assertNotIn("token", response.json())
        self.assertNotIn("access", response.json())
        self.assertNotIn("refresh", response.json())
        issue_tokens.assert_not_called()
        consume_verification.assert_called_once_with(
            "learner@example.com",
            "verified-token",
        )
        self.assertEqual(create_user.call_args.kwargs["username"], "learner")
        self.assertEqual(
            create_user.call_args.kwargs["registration_details"],
            {"educationLevel": "college"},
        )
