from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from bson import ObjectId
from cloudinary.exceptions import Error as CloudinaryError, GeneralError
from django.test import SimpleTestCase
from django.test import override_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient
import yaml

from core.cloudinary_storage import (
    CloudinaryConfigurationError,
    CloudinaryStorageError,
    MediaValidationError,
    configure_cloudinary,
    create_signed_course_video_upload,
    create_signed_upload,
    delete_media,
    get_media_metadata,
    upload_media,
)
from core.assignment_attempts import assignment_policy_status, get_assignment_policy


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

        with self.assertLogs("course_video_upload", level="INFO") as upload_logs:
            metadata = upload_media(
                video,
                "course_video",
                owner_id="admin-1",
                upload_trace_id="test-trace",
            )

        self.assertEqual(metadata["resourceType"], "video")
        self.assertEqual(upload.call_args.kwargs["resource_type"], "video")
        self.assertEqual(upload.call_args.kwargs["folder"], "aihustle-lms/course_video/admin-1")
        self.assertNotIn("/", upload.call_args.kwargs["public_id"])
        stages = {record.getMessage().split("stage=", 1)[1].split()[0] for record in upload_logs.records}
        self.assertIn("cloudinary_upload_started", stages)
        self.assertIn("cloudinary_upload_completed", stages)

    @override_settings(**cloudinary_settings)
    @patch(
        "core.cloudinary_storage.uploader.upload",
        return_value={
            "secure_url": "https://res.cloudinary.com/test-cloud/video/upload/lesson.mp4",
            "public_id": "aihustle-lms/course_video/course/module/admin-1/" + "a" * 64,
            "resource_type": "video",
            "format": "mp4",
            "bytes": 16,
        },
    )
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_video_retry_uses_stable_overwriting_cloudinary_public_id(self, config, upload):
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake",
            content_type="video/mp4",
        )

        upload_media(
            video,
            "course_video",
            owner_id="admin-1",
            course_id="course",
            module_id="module",
            idempotency_key="a" * 64,
        )

        self.assertEqual(upload.call_args.kwargs["public_id"], "a" * 64)
        self.assertEqual(
            upload.call_args.kwargs["folder"],
            "aihustle-lms/course_video/course/module/admin-1",
        )
        self.assertTrue(upload.call_args.kwargs["overwrite"])

    @override_settings(**cloudinary_settings)
    @patch(
        "core.cloudinary_storage.uploader.upload",
        side_effect=CloudinaryError("Cloudinary rejected the upload: invalid signature"),
    )
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_video_upload_error_preserves_cloudinary_detail(self, config, upload):
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake",
            content_type="video/mp4",
        )

        with self.assertRaisesRegex(CloudinaryStorageError, "invalid signature"):
            upload_media(video, "course_video", owner_id="admin-1")

    @override_settings(**cloudinary_settings)
    @patch("core.cloudinary_storage.VIDEO_CHUNK_SIZE", 16)
    @patch("core.cloudinary_storage.VIDEO_CHUNKED_UPLOAD_THRESHOLD", 16)
    @patch("core.cloudinary_storage.VIDEO_UPLOAD_RETRY_DELAY_SECONDS", 0)
    @patch(
        "core.cloudinary_storage.uploader.upload_large_part",
        side_effect=[
            GeneralError("Cloudinary response timed out"),
            {
                "secure_url": "https://res.cloudinary.com/test-cloud/video/upload/lesson.mp4",
                "public_id": "aihustle-lms/course_video/course/module/" + "a" * 64,
                "resource_type": "video",
                "format": "mp4",
                "bytes": 32,
            },
            {
                "secure_url": "https://res.cloudinary.com/test-cloud/video/upload/lesson.mp4",
                "public_id": "aihustle-lms/course_video/course/module/" + "a" * 64,
                "resource_type": "video",
                "format": "mp4",
                "bytes": 32,
            },
        ],
    )
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_video_upload_retries_transient_error_with_stable_asset_id(
        self,
        config,
        upload_chunk,
    ):
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake-more-video-data",
            content_type="video/mp4",
        )

        with self.assertLogs("course_video_upload", level="INFO") as upload_logs:
            metadata = upload_media(
                video,
                "course_video",
                owner_id="admin-1",
                course_id="course",
                module_id="module",
                idempotency_key="a" * 64,
                upload_trace_id="retry-trace",
            )

        self.assertEqual(metadata["resourceType"], "video")
        self.assertEqual(upload_chunk.call_count, 3)
        first_chunk, retried_chunk, second_chunk = upload_chunk.call_args_list
        self.assertEqual(first_chunk.args[0], retried_chunk.args[0])
        self.assertEqual(first_chunk.kwargs["http_headers"], retried_chunk.kwargs["http_headers"])
        self.assertEqual(
            first_chunk.kwargs["http_headers"]["X-Unique-Upload-Id"],
            second_chunk.kwargs["http_headers"]["X-Unique-Upload-Id"],
        )
        self.assertEqual(first_chunk.kwargs["http_headers"]["Content-Range"], "bytes 0-15/32")
        self.assertEqual(second_chunk.kwargs["http_headers"]["Content-Range"], "bytes 16-31/32")
        self.assertEqual(first_chunk.kwargs["public_id"], "a" * 64)
        self.assertTrue(first_chunk.kwargs["overwrite"])
        self.assertEqual(first_chunk.kwargs["timeout"].connect_timeout, 15)
        self.assertEqual(first_chunk.kwargs["timeout"].read_timeout, 600)
        self.assertEqual(video.tell(), 0)
        stages = [record.getMessage() for record in upload_logs.records]
        self.assertTrue(any("stage=cloudinary_chunk_upload_failed" in record and "retrying=True" in record for record in stages))
        self.assertTrue(any("stage=cloudinary_upload_response_received" in record for record in stages))
        self.assertTrue(any(
            "stage=cloudinary_upload_started" in record
            and "stream_position=0" in record
            and "stream_readable=True" in record
            and "stream_seekable=True" in record
            for record in stages
        ))

    @override_settings(**cloudinary_settings)
    @patch("core.cloudinary_storage.VIDEO_CHUNK_SIZE", 16)
    @patch("core.cloudinary_storage.VIDEO_CHUNKED_UPLOAD_THRESHOLD", 16)
    @patch("core.cloudinary_storage.VIDEO_UPLOAD_RETRY_DELAY_SECONDS", 0)
    @patch(
        "core.cloudinary_storage.uploader.upload_large_part",
        side_effect=GeneralError("The write operation timed out"),
    )
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_video_chunk_failure_returns_timeout_after_retrying_only_same_chunk(
        self,
        config,
        upload_chunk,
    ):
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake-more-video-data",
            content_type="video/mp4",
        )

        with self.assertRaisesRegex(
            CloudinaryStorageError,
            "chunk upload failed after 3 attempts: The write operation timed out",
        ):
            upload_media(
                video,
                "course_video",
                owner_id="admin-1",
                course_id="course",
                module_id="module",
                idempotency_key="a" * 64,
                upload_trace_id="failed-chunk-trace",
            )

        self.assertEqual(upload_chunk.call_count, 3)
        headers = [call.kwargs["http_headers"] for call in upload_chunk.call_args_list]
        self.assertEqual(headers[0], headers[1])
        self.assertEqual(headers[1], headers[2])
        self.assertTrue(all(header["Content-Range"] == "bytes 0-15/32" for header in headers))
        self.assertEqual(len({header["X-Unique-Upload-Id"] for header in headers}), 1)

    @override_settings(**cloudinary_settings)
    @patch("core.cloudinary_storage.VIDEO_CHUNKED_UPLOAD_THRESHOLD", 16)
    @patch("core.cloudinary_storage.uploader.upload_large_part")
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_large_video_upload_uses_bounded_chunk_request(
        self,
        config,
        upload_large_part,
    ):
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake",
            content_type="video/mp4",
        )
        upload_large_part.return_value = {
                "secure_url": "https://res.cloudinary.com/test-cloud/video/upload/lesson.mp4",
                "public_id": "aihustle-lms/course_video/course/module/lesson",
                "resource_type": "video",
                "format": "mp4",
                "bytes": 16,
                "duration": 5,
            }

        metadata = upload_media(
            video,
            "course_video",
            owner_id="admin-1",
            course_id="course",
            module_id="module",
        )

        self.assertEqual(metadata["resourceType"], "video")
        self.assertEqual(upload_large_part.call_args.kwargs["resource_type"], "video")
        self.assertEqual(upload_large_part.call_args.kwargs["http_headers"]["Content-Range"], "bytes 0-15/16")
        self.assertEqual(upload_large_part.call_args.kwargs["timeout"].connect_timeout, 15)
        self.assertEqual(upload_large_part.call_args.kwargs["timeout"].read_timeout, 600)

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
    @patch("core.cloudinary_storage.api_sign_request", return_value="video-signed-value")
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_signed_course_video_upload_is_scoped_and_uses_server_secret(self, config, sign):
        signed = create_signed_course_video_upload(
            "admin-1",
            "course-1",
            "module-1",
            "lesson.mp4",
        )

        self.assertEqual(signed["resourceType"], "video")
        self.assertEqual(signed["filenameOverride"], "lesson.mp4")
        self.assertTrue(signed["publicId"].startswith(
            "aihustle-lms/course_video/course-1/module-1/admin-1/"
        ))
        self.assertEqual(signed["overwrite"], "false")
        self.assertEqual(signed["signature"], "video-signed-value")
        self.assertNotIn("apiSecret", signed)
        self.assertNotIn("test-secret", repr(signed))
        signed_parameters = sign.call_args.args[0]
        self.assertEqual(signed_parameters["public_id"], signed["publicId"])
        self.assertEqual(signed_parameters["filename_override"], "lesson.mp4")
        self.assertEqual(signed_parameters["overwrite"], "false")
        self.assertEqual(sign.call_args.args[1], "test-secret")

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

    @override_settings(**cloudinary_settings)
    @patch(
        "core.cloudinary_storage.uploader.upload",
        return_value={
            "secure_url": "https://res.cloudinary.com/test-cloud/image/upload/certificate.png",
            "public_id": "aihustle-lms/certificate_template/admin-1/certificate",
            "resource_type": "image",
            "format": "png",
            "bytes": 16,
            "width": 4,
            "height": 3,
        },
    )
    @patch("core.cloudinary_storage.cloudinary.config")
    def test_certificate_template_upload_uses_validated_image_storage(self, config, upload):
        image = SimpleUploadedFile(
            "certificate.png",
            b"\x89PNG\r\n\x1a\nmore",
            content_type="image/png",
        )

        metadata = upload_media(image, "certificate_template", owner_id="admin-1")

        self.assertEqual(metadata["resourceType"], "image")
        self.assertEqual(upload.call_args.kwargs["resource_type"], "image")
        self.assertEqual(
            upload.call_args.kwargs["folder"],
            "aihustle-lms/certificate_template/admin-1",
        )


class _MemoryAssignmentPolicies:
    def __init__(self):
        self.documents = {}

    def find_one(self, query):
        document = self.documents.get(query.get("_id"))
        if document is None:
            return None
        return dict(document)

    def find_one_and_update(self, query, update, **kwargs):
        policy_id = query.get("_id")
        document = self.documents.get(policy_id)
        if document is None:
            if not kwargs.get("upsert"):
                return None
            document = dict(update.get("$setOnInsert", {}))
            self.documents[policy_id] = document
            return dict(document)
        for field, expected in query.items():
            if field == "_id":
                continue
            actual = document.get(field)
            if isinstance(expected, dict):
                if "$ne" in expected and actual == expected["$ne"]:
                    return None
            elif actual != expected:
                return None
        document.update(update.get("$set", {}))
        for field, value in update.get("$inc", {}).items():
            document[field] = document.get(field, 0) + value
        return dict(document)


class _MemoryAssignmentSubmissions:
    def __init__(self):
        self.documents = {}

    def find(self, _query):
        return list(self.documents.values())

    def find_one(self, query):
        expected = query.get("_id")
        ids = expected.get("$in", []) if isinstance(expected, dict) else [expected]
        for value in ids:
            record = self.documents.get(str(value))
            if record is not None:
                return dict(record)
        return None


class AssignmentAttemptPolicyTests(SimpleTestCase):
    def test_legacy_admin_review_status_counts_without_review_timestamp(self):
        student_id, course_id, assignment_id = ObjectId(), ObjectId(), ObjectId()
        enrollment_at = datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc)
        enrollment = {
            "_id": ObjectId(),
            "createdAt": enrollment_at,
            "studentId": str(student_id),
            "courseId": str(course_id),
        }
        submissions = _MemoryAssignmentSubmissions()
        submission_id = ObjectId()
        submissions.documents[str(submission_id)] = {
            "_id": submission_id,
            "studentId": str(student_id),
            "courseId": str(course_id),
            "assignmentId": str(assignment_id),
            "status": "rejected",
            "reviewStatus": "rejected",
            "createdAt": enrollment_at + timedelta(days=1),
        }
        policy = get_assignment_policy(
            _MemoryAssignmentPolicies(),
            [submissions],
            student_id,
            course_id,
            assignment_id,
            enrollment,
            now=enrollment_at + timedelta(days=2),
        )

        self.assertEqual(policy["attemptsUsed"], 1)
        self.assertEqual(policy["failedAttempts"], 1)
        self.assertIsNone(policy["activeSubmissionId"])

    def test_three_failed_reviews_lock_for_24_hours_then_allow_a_new_cycle_and_pass(self):
        student_id, course_id, assignment_id = ObjectId(), ObjectId(), ObjectId()
        enrollment_at = datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc)
        enrollment = {
            "_id": ObjectId(),
            "createdAt": enrollment_at,
            "studentId": str(student_id),
            "courseId": str(course_id),
        }
        policies = _MemoryAssignmentPolicies()
        submissions = _MemoryAssignmentSubmissions()
        policy = get_assignment_policy(
            policies,
            [submissions],
            student_id,
            course_id,
            assignment_id,
            enrollment,
            now=enrollment_at,
        )
        self.assertEqual(policy["deadlineAt"], enrollment_at + timedelta(days=15))

        for attempt_index in range(3):
            reviewed_at = enrollment_at + timedelta(days=attempt_index + 1)
            submission_id = ObjectId()
            policy["activeSubmissionId"] = str(submission_id)
            policies.documents[policy["_id"]]["activeSubmissionId"] = str(submission_id)
            submissions.documents[str(submission_id)] = {
                "_id": submission_id,
                "status": "rejected",
                "reviewStatus": "rejected",
                "reviewedAt": reviewed_at,
            }
            self.assertEqual(policy["attemptsUsed"], attempt_index)
            policy = get_assignment_policy(
                policies,
                [submissions],
                student_id,
                course_id,
                assignment_id,
                enrollment,
                now=reviewed_at + timedelta(seconds=1),
            )

        locked_state = assignment_policy_status(
            policy,
            now=reviewed_at + timedelta(seconds=2),
        )
        self.assertEqual(locked_state["attemptsUsed"], 3)
        self.assertEqual(locked_state["failedAttempts"], 3)
        self.assertTrue(locked_state["isLocked"])
        self.assertFalse(locked_state["canSubmit"])
        self.assertEqual(
            policy["lockoutUntil"],
            reviewed_at + timedelta(hours=24),
        )

        retry_at = policy["lockoutUntil"] + timedelta(seconds=1)
        policy = get_assignment_policy(
            policies,
            [submissions],
            student_id,
            course_id,
            assignment_id,
            enrollment,
            now=retry_at,
        )
        retry_state = assignment_policy_status(policy, now=retry_at)
        self.assertEqual(retry_state["attemptsUsed"], 0)
        self.assertEqual(retry_state["remainingAttempts"], 3)
        self.assertTrue(retry_state["canSubmit"])

        passing_submission_id = ObjectId()
        policies.documents[policy["_id"]]["activeSubmissionId"] = str(passing_submission_id)
        submissions.documents[str(passing_submission_id)] = {
            "_id": passing_submission_id,
            "status": "approved",
            "reviewStatus": "approved",
            "reviewedAt": retry_at + timedelta(minutes=1),
        }
        policy = get_assignment_policy(
            policies,
            [submissions],
            student_id,
            course_id,
            assignment_id,
            enrollment,
            now=retry_at + timedelta(minutes=2),
        )
        passed_state = assignment_policy_status(policy, now=retry_at + timedelta(minutes=2))
        self.assertEqual(passed_state["attemptsUsed"], 1)
        self.assertTrue(passed_state["hasPassed"])
        self.assertFalse(passed_state["canSubmit"])
        deadline_state = assignment_policy_status(
            policy,
            now=enrollment_at + timedelta(days=15),
        )
        self.assertTrue(deadline_state["deadlineExpired"])


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
