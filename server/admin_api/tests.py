import json
from datetime import datetime, timedelta, timezone
from io import BytesIO
from unittest.mock import MagicMock, patch

import jwt
from bson import ObjectId
from cloudinary.exceptions import NotFound as CloudinaryNotFound
from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from PIL import Image
from rest_framework.test import APIClient
from pymongo.errors import PyMongoError

from core.cloudinary_storage import CloudinaryStorageError


class AdminCloudinaryApiTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.user_id = ObjectId()
        self.user_document = {
            "_id": self.user_id,
            "email": "admin@example.com",
            "name": "Admin",
            "role": "main_admin",
            "is_active": True,
        }
        token = jwt.encode(
            {"sub": str(self.user_id), "role": "main_admin", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

    def _authenticated_request(self, method, path, *args, **kwargs):
        with patch(
            "authentication.jwt.collection",
            return_value=MagicMock(find_one=MagicMock(return_value=self.user_document)),
        ):
            return getattr(self.client, method)(path, *args, **kwargs)

    def _video_upload_path(self, course_id, module_id, lesson_id, action):
        return (
            f"/api/admin/courses/{course_id}/modules/{module_id}/lessons/"
            f"{lesson_id}/media/video/{action}"
        )

    def _pending_video_upload(self, upload_id, course_id, module_id, lesson_id, **overrides):
        now = datetime.now(timezone.utc)
        return {
            "_id": upload_id,
            "ownerId": str(self.user_id),
            "purpose": "course_video",
            "courseId": str(course_id),
            "moduleId": str(module_id),
            "lessonId": str(lesson_id),
            "publicId": "aihustle-lms/course_video/course/module/admin/video-asset",
            "resourceType": "video",
            "originalName": "lesson.mp4",
            "declaredBytes": 64,
            "status": "awaiting_direct_upload",
            "createdAt": now - timedelta(minutes=1),
            "signatureExpiresAt": now + timedelta(minutes=50),
            **overrides,
        }

    def _transcript_path(self, course_id, module_id, lesson_id):
        return (
            f"/api/admin/courses/{course_id}/modules/{module_id}/lessons/"
            f"{lesson_id}/media/transcript"
        )

    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_manual_transcript_is_saved_and_updated_on_the_existing_lesson(
        self,
        collection,
        find_course,
    ):
        course_id, module_id = ObjectId(), ObjectId()
        lesson_id = "lesson-1"
        lesson = {
            "_id": lesson_id,
            "type": "video-lesson",
            "videoUrl": "https://res.cloudinary.com/test/video/upload/lesson.mp4",
            "videoPublicId": "aihustle-lms/course_video/lesson",
        }
        find_course.return_value = {
            "_id": course_id,
            "modules": [{"_id": module_id, "contentItems": [lesson]}],
        }
        collection.return_value.update_one.return_value.matched_count = 1
        path = self._transcript_path(course_id, module_id, lesson_id)

        first_text = "1\n00:00:00,000 --> 00:00:02,000\nFirst version."
        first_response = self._authenticated_request(
            "put",
            path,
            {"lesson": lesson, "transcript": first_text},
            format="json",
        )
        updated_text = (
            "1\n00:00:00,000 --> 00:00:02,000\nUpdated opening.\n\n"
            "2\n00:00:02,000 --> 00:00:04,000\nSecond cue."
        )
        updated_response = self._authenticated_request(
            "put",
            path,
            {"lesson": lesson, "transcript": updated_text},
            format="json",
        )

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(updated_response.status_code, 200)
        self.assertEqual(updated_response.json()["transcriptSource"], "manual")
        self.assertEqual(
            updated_response.json()["transcriptCues"],
            [
                {"startTimeMs": 0, "endTimeMs": 2000, "text": "Updated opening."},
                {"startTimeMs": 2000, "endTimeMs": 4000, "text": "Second cue."},
            ],
        )
        self.assertEqual(collection.return_value.update_one.call_count, 2)
        query, update = collection.return_value.update_one.call_args.args
        self.assertEqual(query["_id"], course_id)
        self.assertEqual(query["modules.0._id"], module_id)
        self.assertEqual(query["modules.0.contentItems.0._id"], lesson_id)
        saved = update["$set"]
        self.assertEqual(saved["modules.0.contentItems.0.transcriptSource"], "manual")
        self.assertEqual(saved["modules.0.contentItems.0.transcriptFormat"], "srt")
        self.assertEqual(saved["modules.0.contentItems.0.transcriptBytes"], len(updated_text.encode("utf-8")))
        self.assertEqual(saved["modules.0.contentItems.0.transcriptCues"], updated_response.json()["transcriptCues"])
        self.assertEqual(saved["modules.0.contentItems.0.transcriptPublicId"], "")
        collection.return_value.insert_one.assert_not_called()

    def test_manual_transcript_rejects_empty_and_invalid_srt_text(self):
        course_id, module_id, lesson_id = ObjectId(), ObjectId(), "lesson-1"
        lesson = {"_id": lesson_id, "type": "video-lesson"}
        path = self._transcript_path(course_id, module_id, lesson_id)
        for transcript in (" \r\n ", "00:00:00 --> 00:00:02\nInvalid timestamp cue."):
            with self.subTest(transcript=transcript):
                response = self._authenticated_request(
                    "put",
                    path,
                    {"lesson": lesson, "transcript": transcript},
                    format="json",
                )
                self.assertEqual(response.status_code, 400)
                self.assertIn("transcript", response.json()["message"].lower())

    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_manual_plain_text_is_saved_without_timestamp_cues(
        self,
        collection,
        find_course,
    ):
        course_id, module_id = ObjectId(), ObjectId()
        lesson_id = "lesson-plain"
        lesson = {
            "_id": lesson_id,
            "type": "video-lesson",
            "videoUrl": "https://res.cloudinary.com/test/video/upload/lesson.mp4",
            "videoPublicId": "aihustle-lms/course_video/lesson",
        }
        find_course.return_value = {
            "_id": course_id,
            "modules": [{"_id": module_id, "contentItems": [lesson]}],
        }
        collection.return_value.update_one.return_value.matched_count = 1
        transcript = "A plain transcript line.\n\nA second paragraph."

        response = self._authenticated_request(
            "put",
            self._transcript_path(course_id, module_id, lesson_id),
            {"lesson": lesson, "transcript": transcript},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["transcriptFormat"], "text")
        self.assertEqual(response.json()["transcriptText"], transcript)
        self.assertEqual(response.json()["transcriptCues"], [])
        saved = collection.return_value.update_one.call_args.args[1]["$set"]
        self.assertEqual(saved["modules.0.contentItems.0.transcriptText"], transcript)
        self.assertEqual(saved["modules.0.contentItems.0.transcriptCues"], [])
        self.assertEqual(saved["modules.0.contentItems.0.transcriptSource"], "manual")

    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_manual_transcript_attaches_a_new_unsaved_lesson_to_its_module(
        self,
        collection,
        find_course,
    ):
        course_id, module_id = ObjectId(), ObjectId()
        lesson_id = "new-lesson"
        lesson = {
            "_id": lesson_id,
            "type": "video-lesson",
            "title": "New lesson",
            "videoUrl": "https://res.cloudinary.com/test/video/upload/lesson.mp4",
            "videoPublicId": "aihustle-lms/course_video/lesson",
        }
        find_course.return_value = {
            "_id": course_id,
            "modules": [{"_id": module_id, "contentItems": []}],
        }
        collection.return_value.update_one.return_value.matched_count = 1

        response = self._authenticated_request(
            "put",
            self._transcript_path(course_id, module_id, lesson_id),
            {
                "lesson": lesson,
                "transcript": "1\n00:00:00,000 --> 00:00:02,000\nNew lesson cue.",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        query, update = collection.return_value.update_one.call_args.args
        self.assertEqual(query["_id"], course_id)
        self.assertEqual(query["modules.0._id"], module_id)
        self.assertEqual(query["modules.0.contentItems._id"], {"$ne": lesson_id})
        inserted_lesson = update["$push"]["modules.0.contentItems"]
        self.assertEqual(inserted_lesson["_id"], lesson_id)
        self.assertEqual(inserted_lesson["transcriptSource"], "manual")

    @patch("admin_api.media_views._find_course")
    def test_non_admin_cannot_save_a_manual_transcript(self, find_course):
        self.user_document = {**self.user_document, "role": "student"}
        token = jwt.encode(
            {"sub": str(self.user_id), "role": "student", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self._authenticated_request(
            "put",
            self._transcript_path(ObjectId(), ObjectId(), "lesson-1"),
            {
                "lesson": {"_id": "lesson-1", "type": "video-lesson"},
                "transcript": "1\n00:00:00,000 --> 00:00:01,000\nCue.",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 403)
        find_course.assert_not_called()

    @patch("admin_api.media_views.upload_media")
    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_existing_srt_transcript_upload_still_saves_cloudinary_cues(
        self,
        collection,
        find_course,
        upload,
    ):
        course_id, module_id = ObjectId(), ObjectId()
        lesson_id = "lesson-1"
        lesson = {
            "_id": lesson_id,
            "type": "video-lesson",
            "videoUrl": "https://res.cloudinary.com/test/video/upload/lesson.mp4",
            "videoPublicId": "aihustle-lms/course_video/lesson",
        }
        find_course.return_value = {
            "_id": course_id,
            "modules": [{"_id": module_id, "contentItems": [lesson]}],
        }
        collection.return_value.insert_one.return_value.inserted_id = ObjectId()
        collection.return_value.update_one.return_value.matched_count = 1
        upload.return_value = {
            "secureUrl": "https://res.cloudinary.com/test/raw/upload/lesson.srt",
            "publicId": "aihustle-lms/course_transcript/lesson",
            "resourceType": "raw",
            "format": "srt",
            "bytes": 43,
            "originalName": "lesson.srt",
            "width": None,
            "height": None,
            "duration": None,
            "version": 1,
        }
        transcript = SimpleUploadedFile(
            "lesson.srt",
            b"1\n00:00:00,000 --> 00:00:02,000\nA transcript cue.",
            content_type="text/plain",
        )

        response = self._authenticated_request(
            "post",
            self._transcript_path(course_id, module_id, lesson_id),
            {"file": transcript, "lesson": json.dumps(lesson)},
            format="multipart",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["transcriptSource"], "srt")
        self.assertEqual(response.json()["transcriptText"], "")
        self.assertEqual(response.json()["transcriptCues"][0]["text"], "A transcript cue.")
        upload.assert_called_once()
        saved = collection.return_value.update_one.call_args.args[1]["$set"]
        self.assertEqual(saved["modules.0.contentItems.0.transcriptSource"], "srt")
        self.assertEqual(saved["modules.0.contentItems.0.transcriptText"], "")

    @patch("admin_api.media_views.check_cloudinary_connection", return_value={"status": "ok"})
    def test_cloudinary_health_does_not_expose_credentials(self, check_connection):
        response = self._authenticated_request("get", "/api/admin/cloudinary/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"connected": True})
        self.assertNotIn("api_secret", response.content.decode().lower())
        check_connection.assert_called_once_with()

    @patch(
        "admin_api.media_views.create_signed_upload",
        return_value={
            "cloudName": "new-cloud",
            "apiKey": "public-key",
            "timestamp": 123,
            "folder": "aihustle-lms/course-thumbnail",
            "publicId": "aihustle-lms/course-thumbnail/asset",
            "signature": "signed-value",
        },
    )
    @patch("admin_api.media_views.collection")
    def test_thumbnail_signature_response_never_contains_the_api_secret(self, collection, create_signature):
        response = self._authenticated_request(
            "post",
            "/api/admin/course-assets/signature",
            {"resourceType": "image"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["apiKey"], "public-key")
        self.assertNotIn("apiSecret", response.json())
        self.assertNotIn("api_secret", response.content.decode().lower())
        collection.return_value.insert_one.assert_called_once()
        create_signature.assert_called_once_with()

    @patch("admin_api.media_views.upload_media")
    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_course_video_upload_returns_and_stores_cloudinary_metadata(
        self,
        collection,
        find_course,
        upload,
    ):
        course_id = ObjectId()
        module_id = ObjectId()
        find_course.return_value = {
            "_id": course_id,
            "modules": [{"_id": module_id, "title": "Module"}],
        }
        upload.return_value = {
            "secureUrl": "https://res.cloudinary.com/new-cloud/video/upload/lesson.mp4",
            "publicId": "aihustle-lms/course_video/course/module/asset",
            "resourceType": "video",
            "format": "mp4",
            "bytes": 128,
            "originalName": "lesson.mp4",
            "width": 640,
            "height": 360,
            "duration": 12.5,
            "version": 1,
        }
        collection.return_value.find_one.return_value = None
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake",
            content_type="video/mp4",
        )

        with self.assertLogs("course_video_upload", level="INFO") as upload_logs:
            response = self._authenticated_request(
                "post",
                f"/api/admin/courses/{course_id}/modules/{module_id}/media/video",
                {"file": video, "lessonId": "lesson-1", "lastModified": "1700000000000"},
                format="multipart",
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["resourceType"], "video")
        self.assertEqual(response.json()["publicId"], upload.return_value["publicId"])
        stored_asset = collection.return_value.update_one.call_args.args[1]["$set"]
        self.assertEqual(stored_asset["secureUrl"], upload.return_value["secureUrl"])
        self.assertEqual(stored_asset["courseId"], str(course_id))
        self.assertEqual(stored_asset["moduleId"], str(module_id))
        self.assertEqual(stored_asset["lessonId"], "lesson-1")
        self.assertEqual(len(stored_asset["uploadKey"]), 64)
        self.assertEqual(collection.return_value.update_one.call_args.args[0], {"_id": stored_asset["uploadKey"]})
        self.assertNotIn("_id", collection.return_value.update_one.call_args.args[1]["$set"])
        self.assertEqual(upload.call_args.kwargs["idempotency_key"], stored_asset["uploadKey"])
        self.assertNotIn("api_secret", repr(stored_asset).lower())
        upload.assert_called_once()
        stages = {record.getMessage().split("stage=", 1)[1].split()[0] for record in upload_logs.records}
        self.assertTrue({
            "request_received",
            "multipart_parse_completed",
            "media_storage_started",
            "mongodb_save_completed",
            "response_completed",
        }.issubset(stages))

    @patch("admin_api.media_views.upload_media")
    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_completed_course_video_retry_returns_saved_asset_without_upload(
        self,
        collection,
        find_course,
        upload,
    ):
        course_id = ObjectId()
        module_id = ObjectId()
        find_course.return_value = {"_id": course_id, "modules": [{"_id": module_id}]}
        collection.return_value.find_one.return_value = {
            "secureUrl": "https://res.cloudinary.com/new-cloud/video/upload/lesson.mp4",
            "publicId": "aihustle-lms/course_video/course/module/asset",
            "resourceType": "video",
            "format": "mp4",
            "bytes": 128,
            "originalName": "lesson.mp4",
            "duration": 12.5,
            "status": "uploaded",
        }
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake",
            content_type="video/mp4",
        )

        response = self._authenticated_request(
            "post",
            f"/api/admin/courses/{course_id}/modules/{module_id}/media/video",
            {"file": video, "lessonId": "lesson-1", "lastModified": "1700000000000"},
            format="multipart",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["publicId"], collection.return_value.find_one.return_value["publicId"])
        upload.assert_not_called()
        collection.return_value.update_one.assert_not_called()

    @patch("admin_api.media_views.upload_media", side_effect=CloudinaryStorageError("Cloudinary upload failed: invalid signature"))
    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_course_video_upload_returns_cloudinary_error_detail(self, collection, find_course, upload):
        course_id = ObjectId()
        module_id = ObjectId()
        find_course.return_value = {"_id": course_id, "modules": [{"_id": module_id}]}
        collection.return_value.find_one.return_value = None
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake",
            content_type="video/mp4",
        )

        response = self._authenticated_request(
            "post",
            f"/api/admin/courses/{course_id}/modules/{module_id}/media/video",
            {"file": video, "lessonId": "lesson-1", "lastModified": "1700000000000"},
            format="multipart",
        )

        self.assertEqual(response.status_code, 503)
        self.assertIn("invalid signature", response.json()["message"])
        upload.assert_called_once()

    @patch("admin_api.media_views.delete_media")
    @patch("admin_api.media_views.upload_media")
    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_course_video_upload_returns_mongodb_error_detail(
        self,
        collection,
        find_course,
        upload,
        delete_media,
    ):
        course_id = ObjectId()
        module_id = ObjectId()
        find_course.return_value = {"_id": course_id, "modules": [{"_id": module_id}]}
        collection.return_value.find_one.return_value = None
        collection.return_value.update_one.side_effect = PyMongoError("replica set unavailable")
        upload.return_value = {
            "secureUrl": "https://res.cloudinary.com/new-cloud/video/upload/lesson.mp4",
            "publicId": "aihustle-lms/course_video/course/module/asset",
            "resourceType": "video",
            "format": "mp4",
            "bytes": 128,
            "originalName": "lesson.mp4",
            "duration": 12.5,
        }
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake",
            content_type="video/mp4",
        )

        response = self._authenticated_request(
            "post",
            f"/api/admin/courses/{course_id}/modules/{module_id}/media/video",
            {"file": video, "lessonId": "lesson-1", "lastModified": "1700000000000"},
            format="multipart",
        )

        self.assertEqual(response.status_code, 503)
        self.assertIn("replica set unavailable", response.json()["message"])
        delete_media.assert_called_once_with(upload.return_value["publicId"], "video")

    @patch("admin_api.media_views.upload_media")
    @patch("admin_api.media_views._find_course", return_value={"_id": ObjectId(), "modules": []})
    def test_course_video_upload_rejects_a_module_not_yet_saved(self, find_course, upload):
        course_id = ObjectId()
        module_id = ObjectId()
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake",
            content_type="video/mp4",
        )

        response = self._authenticated_request(
            "post",
            f"/api/admin/courses/{course_id}/modules/{module_id}/media/video",
            {"file": video, "lessonId": "lesson-1", "lastModified": "1700000000000"},
            format="multipart",
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["message"], "Course module not found.")
        find_course.assert_called_once_with(str(course_id))
        upload.assert_not_called()

    @patch(
        "admin_api.media_views.create_signed_course_video_upload",
        return_value={
            "cloudName": "test-cloud",
            "apiKey": "public-key",
            "timestamp": 123,
            "publicId": "aihustle-lms/course_video/course/module/admin/video-asset",
            "filenameOverride": "lesson.mp4",
            "overwrite": "false",
            "type": "upload",
            "resourceType": "video",
            "signature": "signed-value",
        },
    )
    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_video_signature_is_admin_scoped_and_persists_pending_association(
        self,
        collection,
        find_course,
        create_signature,
    ):
        course_id, module_id, lesson_id = str(ObjectId()), str(ObjectId()), str(ObjectId())
        find_course.return_value = {"modules": [{"_id": module_id}]}

        response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "signature"),
            {"fileName": "lesson.mp4", "fileSize": 64},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["apiKey"], "public-key")
        self.assertEqual(body["resourceType"], "video")
        self.assertEqual(body["overwrite"], "false")
        self.assertNotIn("apiSecret", body)
        self.assertNotIn("test-secret", response.content.decode())
        create_signature.assert_called_once_with(
            str(self.user_id),
            course_id,
            module_id,
            "lesson.mp4",
        )
        pending = collection.return_value.insert_one.call_args.args[0]
        self.assertEqual(pending["ownerId"], str(self.user_id))
        self.assertEqual(pending["courseId"], course_id)
        self.assertEqual(pending["moduleId"], module_id)
        self.assertEqual(pending["lessonId"], lesson_id)
        self.assertEqual(pending["publicId"], body["publicId"])
        self.assertEqual(pending["status"], "awaiting_direct_upload")
        self.assertEqual(body["uploadId"], str(pending["_id"]))

    @patch("admin_api.media_views.create_signed_course_video_upload")
    @patch("admin_api.media_views.collection")
    def test_video_signature_rejects_unsupported_file_before_signing(self, collection, create_signature):
        course_id, module_id, lesson_id = str(ObjectId()), str(ObjectId()), str(ObjectId())

        response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "signature"),
            {"fileName": "payload.exe", "fileSize": 64},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        create_signature.assert_not_called()
        collection.assert_not_called()

    def test_video_signature_requires_main_admin(self):
        self.user_document = {**self.user_document, "role": "student"}
        token = jwt.encode(
            {"sub": str(self.user_id), "role": "student", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self._authenticated_request(
            "post",
            self._video_upload_path("course", "module", "lesson", "signature"),
            {"fileName": "lesson.mp4", "fileSize": 64},
            format="json",
        )

        self.assertEqual(response.status_code, 403)

    def test_video_upload_endpoints_require_authentication(self):
        course_id, module_id, lesson_id = str(ObjectId()), str(ObjectId()), str(ObjectId())
        self.client.credentials()

        signature_response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "signature"),
            {"fileName": "lesson.mp4", "fileSize": 64},
            format="json",
        )
        verify_response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "verify"),
            {"uploadId": str(ObjectId())},
            format="json",
        )

        self.assertEqual(signature_response.status_code, 401)
        self.assertEqual(verify_response.status_code, 401)

    @patch("admin_api.media_views.is_cloudinary_delivery_url", return_value=True)
    @patch("admin_api.media_views.get_media_metadata")
    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_video_verification_persists_only_cloudinary_metadata(
        self,
        collection,
        find_course,
        get_metadata,
        is_delivery_url,
    ):
        course_id, module_id, lesson_id = "course", "module", "lesson"
        upload_id = ObjectId()
        pending = self._pending_video_upload(upload_id, course_id, module_id, lesson_id)
        collection.return_value.find_one.return_value = pending
        collection.return_value.update_one.return_value.matched_count = 1
        find_course.return_value = {"modules": [{"_id": module_id}]}
        get_metadata.return_value = {
            "secureUrl": "https://res.cloudinary.com/test-cloud/video/upload/video-asset.mp4",
            "publicId": pending["publicId"],
            "resourceType": "video",
            "format": "mp4",
            "bytes": 64,
            "originalName": "lesson.mp4",
            "width": 640,
            "height": 360,
            "duration": 12,
            "version": 4,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

        response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "verify"),
            {
                "uploadId": str(upload_id),
                "publicId": "attacker/asset",
                "secureUrl": "https://untrusted.example/video.mp4",
                "bytes": 1,
                "format": "jpg",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["url"], get_metadata.return_value["secureUrl"])
        self.assertEqual(response.json()["publicId"], pending["publicId"])
        self.assertTrue(response.json()["verified"])
        get_metadata.assert_called_once_with(pending["publicId"], "video")
        stored = collection.return_value.update_one.call_args.args[1]["$set"]
        self.assertEqual(stored["secureUrl"], get_metadata.return_value["secureUrl"])
        self.assertEqual(stored["bytes"], 64)
        self.assertEqual(stored["status"], "uploaded")
        query = collection.return_value.update_one.call_args.args[0]
        self.assertEqual(query["ownerId"], str(self.user_id))
        self.assertEqual(query["courseId"], course_id)
        self.assertEqual(query["moduleId"], module_id)
        self.assertEqual(query["lessonId"], lesson_id)
        self.assertNotIn("secureUrl", query)

    @patch("admin_api.media_views.get_media_metadata")
    @patch("admin_api.media_views._find_course")
    @patch("admin_api.media_views.collection")
    def test_video_verification_rejects_expired_upload_without_cloudinary_lookup(
        self,
        collection,
        find_course,
        get_metadata,
    ):
        course_id, module_id, lesson_id = str(ObjectId()), str(ObjectId()), str(ObjectId())
        upload_id = ObjectId()
        pending = self._pending_video_upload(
            upload_id,
            course_id,
            module_id,
            lesson_id,
            signatureExpiresAt=datetime.now(timezone.utc) - timedelta(minutes=1),
        )
        collection.return_value.find_one.return_value = pending

        response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "verify"),
            {"uploadId": str(upload_id)},
            format="json",
        )

        self.assertEqual(response.status_code, 410)
        self.assertEqual(collection.return_value.update_one.call_args.args[1]["$set"]["status"], "expired")
        get_metadata.assert_not_called()
        find_course.assert_not_called()

    @patch("admin_api.media_views.get_media_metadata")
    @patch("admin_api.media_views.collection")
    def test_video_verification_is_idempotent_after_persistence(self, collection, get_metadata):
        course_id, module_id, lesson_id = str(ObjectId()), str(ObjectId()), str(ObjectId())
        upload_id = ObjectId()
        saved = self._pending_video_upload(
            upload_id,
            course_id,
            module_id,
            lesson_id,
            status="uploaded",
            secureUrl="https://res.cloudinary.com/test-cloud/video/upload/video.mp4",
            format="mp4",
            bytes=64,
            duration=12,
        )
        collection.return_value.find_one.return_value = saved

        response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "verify"),
            {"uploadId": str(upload_id)},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["verified"])
        self.assertEqual(response.json()["url"], saved["secureUrl"])
        get_metadata.assert_not_called()
        collection.return_value.update_one.assert_not_called()

    @patch("admin_api.media_views.is_cloudinary_delivery_url", return_value=True)
    @patch("admin_api.media_views.get_media_metadata")
    @patch("admin_api.media_views._find_course", return_value={"modules": [{"_id": "module"}]})
    @patch("admin_api.media_views.collection")
    def test_video_verification_rejects_wrong_cloudinary_resource_type(
        self,
        collection,
        find_course,
        get_metadata,
        is_delivery_url,
    ):
        course_id, module_id, lesson_id = "course", "module", "lesson"
        upload_id = ObjectId()
        pending = self._pending_video_upload(upload_id, course_id, module_id, lesson_id)
        collection.return_value.find_one.return_value = pending
        get_metadata.return_value = {
            "secureUrl": "https://res.cloudinary.com/test-cloud/image/upload/video-asset.jpg",
            "publicId": pending["publicId"],
            "resourceType": "image",
            "format": "jpg",
            "bytes": 64,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

        response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "verify"),
            {"uploadId": str(upload_id)},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(collection.return_value.update_one.call_args.args[1]["$set"]["status"], "rejected")

    @patch("admin_api.media_views.is_cloudinary_delivery_url", return_value=True)
    @patch("admin_api.media_views.get_media_metadata")
    @patch("admin_api.media_views._find_course", return_value={"modules": [{"_id": "module"}]})
    @patch("admin_api.media_views.collection")
    def test_video_verification_rejects_a_cloudinary_size_mismatch(
        self,
        collection,
        find_course,
        get_metadata,
        is_delivery_url,
    ):
        course_id, module_id, lesson_id = "course", "module", "lesson"
        upload_id = ObjectId()
        pending = self._pending_video_upload(upload_id, course_id, module_id, lesson_id)
        collection.return_value.find_one.return_value = pending
        get_metadata.return_value = {
            "secureUrl": "https://res.cloudinary.com/test-cloud/video/upload/video-asset.mp4",
            "publicId": pending["publicId"],
            "resourceType": "video",
            "format": "mp4",
            "bytes": 65,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

        response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "verify"),
            {"uploadId": str(upload_id)},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("size does not match", response.json()["message"])
        self.assertEqual(collection.return_value.update_one.call_args.args[1]["$set"]["status"], "rejected")

    @patch("admin_api.media_views.is_cloudinary_delivery_url", return_value=True)
    @patch("admin_api.media_views.get_media_metadata")
    @patch("admin_api.media_views._find_course", return_value={"modules": [{"_id": "module"}]})
    @patch("admin_api.media_views.collection")
    def test_video_verification_reports_mongodb_persistence_failure(
        self,
        collection,
        find_course,
        get_metadata,
        is_delivery_url,
    ):
        course_id, module_id, lesson_id = "course", "module", "lesson"
        upload_id = ObjectId()
        pending = self._pending_video_upload(upload_id, course_id, module_id, lesson_id)
        collection.return_value.find_one.return_value = pending
        collection.return_value.update_one.side_effect = PyMongoError("replica set unavailable")
        get_metadata.return_value = {
            "secureUrl": "https://res.cloudinary.com/test-cloud/video/upload/video-asset.mp4",
            "publicId": pending["publicId"],
            "resourceType": "video",
            "format": "mp4",
            "bytes": 64,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

        response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "verify"),
            {"uploadId": str(upload_id)},
            format="json",
        )

        self.assertEqual(response.status_code, 503)
        self.assertIn("replica set unavailable", response.json()["message"])

    @patch("admin_api.media_views.get_media_metadata")
    @patch("admin_api.media_views._find_course", return_value={"modules": [{"_id": "module"}]})
    @patch("admin_api.media_views.collection")
    def test_video_verification_reports_incomplete_cloudinary_upload(
        self,
        collection,
        find_course,
        get_metadata,
    ):
        course_id, module_id, lesson_id = "course", "module", "lesson"
        upload_id = ObjectId()
        pending = self._pending_video_upload(upload_id, course_id, module_id, lesson_id)
        collection.return_value.find_one.return_value = pending
        not_found = CloudinaryNotFound("asset not found")
        storage_error = CloudinaryStorageError("Cloudinary media metadata could not be retrieved.")
        storage_error.__cause__ = not_found
        get_metadata.side_effect = storage_error

        response = self._authenticated_request(
            "post",
            self._video_upload_path(course_id, module_id, lesson_id, "verify"),
            {"uploadId": str(upload_id)},
            format="json",
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn("not completed", response.json()["message"])
        collection.return_value.update_one.assert_not_called()

    @patch("admin_api.media_views.create_signed_upload")
    def test_non_admin_cannot_request_a_cloudinary_signature(self, create_signature):
        self.user_document = {**self.user_document, "role": "student"}
        token = jwt.encode(
            {"sub": str(self.user_id), "role": "student", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self._authenticated_request(
            "post",
            "/api/admin/course-assets/signature",
            {"resourceType": "image"},
            format="json",
        )

        self.assertEqual(response.status_code, 403)
        create_signature.assert_not_called()

    @patch("admin_api.media_views.delete_media")
    def test_course_asset_delete_cannot_target_student_media(self, delete):
        response = self._authenticated_request(
            "post",
            "/api/admin/course-assets/delete",
            {
                "publicId": "aihustle-lms/profile_image/student-1/avatar",
                "resourceType": "image",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        delete.assert_not_called()


class AdminCourseDirectoryApiTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin_id = ObjectId()
        self.admin_document = {
            "_id": self.admin_id,
            "email": "admin@example.com",
            "name": "Admin",
            "role": "main_admin",
            "is_active": True,
        }
        token = jwt.encode(
            {"sub": str(self.admin_id), "role": "main_admin", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
        self.payload = {
            "title": "Python for Beginners",
            "description": "Learn Python fundamentals by building practical projects.",
            "detailedDescription": "",
            "category": "Python",
            "difficulty": "beginner",
            "thumbnailUrl": "",
            "thumbnailPublicId": "",
            "learningObjectives": [],
            "prerequisites": [],
            "tags": [],
            "skills": [],
            "practicalBenefits": [],
            "estimatedDurationMinutes": 0,
            "generateCertificate": True,
            "assignments": [],
            "quizzes": [],
            "status": "draft",
            "modules": [],
        }

    def _request(self, method, path, *args, **kwargs):
        with patch(
            "authentication.jwt.collection",
            return_value=MagicMock(find_one=MagicMock(return_value=self.admin_document)),
        ):
            return getattr(self.client, method)(path, *args, **kwargs)

    @patch("admin_api.directory_views.collection")
    def test_main_admin_can_create_course_and_receives_id_for_builder(self, collection):
        course_id = ObjectId()
        collection.return_value.insert_one.return_value.inserted_id = course_id

        response = self._request(
            "post",
            "/api/admin/courses",
            self.payload,
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["course"]["_id"], str(course_id))
        inserted_course = collection.return_value.insert_one.call_args.args[0]
        self.assertEqual(inserted_course["title"], self.payload["title"])
        self.assertEqual(inserted_course["created_by"], str(self.admin_id))
        self.assertEqual(inserted_course["status"], "draft")

    @patch("admin_api.directory_views.collection")
    def test_course_create_assigns_saved_ids_to_module_assignments(self, collection):
        course_id = ObjectId()
        collection.return_value.insert_one.return_value.inserted_id = course_id
        payload = {
            **self.payload,
            "modules": [{
                "title": "Module 1",
                "description": "",
                "contentItems": [{
                    "type": "assignment",
                    "title": "Build a calculator",
                    "description": "Submit the completed work.",
                    "points": 100,
                    "passingMarks": 65,
                }],
            }],
        }

        response = self._request(
            "post",
            "/api/admin/courses",
            payload,
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        saved_assignment = collection.return_value.insert_one.call_args.args[0][
            "modules"
        ][0]["contentItems"][0]
        self.assertIsInstance(saved_assignment["_id"], ObjectId)
        self.assertEqual(
            response.json()["course"]["modules"][0]["contentItems"][0]["_id"],
            str(saved_assignment["_id"]),
        )
        self.assertEqual(saved_assignment["points"], 100)
        self.assertEqual(saved_assignment["passingMarks"], 65)

    @patch("admin_api.directory_views.collection")
    def test_course_create_does_not_invent_missing_passing_marks(self, collection):
        collection.return_value.insert_one.return_value.inserted_id = ObjectId()
        payload = {
            **self.payload,
            "modules": [{
                "title": "Module 1",
                "contentItems": [{
                    "type": "assignment",
                    "title": "Legacy assignment",
                    "points": 100,
                }],
            }],
        }

        response = self._request("post", "/api/admin/courses", payload, format="json")

        self.assertEqual(response.status_code, 201)
        saved_assignment = collection.return_value.insert_one.call_args.args[0][
            "modules"
        ][0]["contentItems"][0]
        self.assertNotIn("passingMarks", saved_assignment)

    @patch("admin_api.directory_views.collection")
    def test_course_create_rejects_passing_marks_above_total(self, collection):
        payload = {
            **self.payload,
            "modules": [{
                "title": "Module 1",
                "contentItems": [{
                    "type": "assignment",
                    "title": "Invalid assignment",
                    "points": 100,
                    "passingMarks": 101,
                }],
            }],
        }

        response = self._request("post", "/api/admin/courses", payload, format="json")

        self.assertEqual(response.status_code, 400)
        self.assertIn("assignmentMarks", response.json())
        collection.assert_not_called()

    @patch("admin_api.directory_views.collection")
    def test_course_validation_errors_are_returned_without_database_write(self, collection):
        payload = {**self.payload, "description": "Too short"}

        response = self._request(
            "post",
            "/api/admin/courses",
            payload,
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("description", response.json())
        collection.assert_not_called()

    @patch("admin_api.directory_views.collection")
    def test_main_admin_can_save_course_draft_to_existing_id(self, collection):
        course_id = ObjectId()
        collection.return_value.find_one_and_update.return_value = {
            "_id": course_id,
            **self.payload,
        }

        response = self._request(
            "put",
            f"/api/admin/courses/{course_id}",
            self.payload,
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["course"]["_id"], str(course_id))
        query = collection.return_value.find_one_and_update.call_args.args[0]
        self.assertEqual(query, {"_id": course_id})

    @patch("admin_api.directory_views.collection")
    def test_main_admin_can_toggle_course_status(self, collection):
        course_id = ObjectId()
        collection.return_value.find_one_and_update.side_effect = [
            {"_id": course_id, "status": "draft", "published": False},
            {"_id": course_id, "status": "published", "published": True},
        ]

        draft_response = self._request(
            "patch",
            f"/api/admin/courses/{course_id}/status",
            {"status": "draft"},
            format="json",
        )
        publish_response = self._request(
            "patch",
            f"/api/admin/courses/{course_id}/status",
            {"status": "published"},
            format="json",
        )

        self.assertEqual(draft_response.status_code, 200)
        self.assertEqual(draft_response.json()["course"]["status"], "draft")
        self.assertEqual(publish_response.status_code, 200)
        self.assertEqual(publish_response.json()["course"]["status"], "published")
        self.assertEqual(publish_response.json()["message"], "Course published.")
        updates = collection.return_value.find_one_and_update.call_args_list
        self.assertEqual(updates[0].args[0], {"_id": course_id})
        self.assertEqual(
            {
                key: updates[0].args[1]["$set"][key]
                for key in ("status", "published", "isPublished", "is_published")
            },
            {
                "status": "draft",
                "published": False,
                "isPublished": False,
                "is_published": False,
            },
        )
        self.assertEqual(
            {
                key: updates[1].args[1]["$set"][key]
                for key in ("status", "published", "isPublished", "is_published")
            },
            {
                "status": "published",
                "published": True,
                "isPublished": True,
                "is_published": True,
            },
        )

    @patch("admin_api.directory_views.collection")
    def test_course_status_rejects_invalid_values_without_database_write(self, collection):
        response = self._request(
            "patch",
            f"/api/admin/courses/{ObjectId()}/status",
            {"status": "archived"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        collection.assert_not_called()

    @patch("admin_api.directory_views.collection")
    def test_course_save_persists_uploaded_video_on_its_lesson(self, collection):
        course_id = ObjectId()
        module_id = str(ObjectId())
        lesson_id = str(ObjectId())
        video_url = "https://res.cloudinary.com/test-cloud/video/upload/lesson.mp4"
        video_public_id = "aihustle-lms/course_video/course/module/lesson"
        payload = {
            **self.payload,
            "modules": [{
                "_id": module_id,
                "title": "Module 1",
                "lessons": [],
                "contentItems": [{
                    "_id": lesson_id,
                    "type": "video-lesson",
                    "title": "Lesson 1",
                    "videoUrl": video_url,
                    "videoPublicId": video_public_id,
                    "videoFileName": "lesson.mp4",
                    "videoFormat": "mp4",
                    "videoBytes": 16,
                }],
            }],
        }
        collection.return_value.find_one_and_update.return_value = {
            "_id": course_id,
            **payload,
        }

        response = self._request(
            "put",
            f"/api/admin/courses/{course_id}",
            payload,
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        update = collection.return_value.find_one_and_update.call_args.args[1]["$set"]
        saved_lesson = update["modules"][0]["contentItems"][0]
        self.assertEqual(saved_lesson["_id"], lesson_id)
        self.assertEqual(saved_lesson["videoUrl"], video_url)
        self.assertEqual(saved_lesson["videoPublicId"], video_public_id)

    def test_admin_saved_module_quiz_loads_and_starts_for_student(self):
        course_id, module_id = ObjectId(), ObjectId()
        stored_course = {}

        def insert_course(document):
            stored_course.update(document)
            stored_course["_id"] = course_id
            result = MagicMock()
            result.inserted_id = course_id
            return result

        def update_course(_query, update, **_kwargs):
            stored_course.update(update["$set"])
            return stored_course

        course_collection = MagicMock()
        course_collection.insert_one.side_effect = insert_course
        course_collection.find_one_and_update.side_effect = update_course
        with patch("admin_api.directory_views.collection", return_value=course_collection):
            create_response = self._request(
                "post",
                "/api/admin/courses",
                self.payload,
                format="json",
            )
            self.assertEqual(create_response.status_code, 201)
            course_id = ObjectId(create_response.json()["course"]["_id"])

            quiz_data = {
                "_localId": "temporary-frontend-quiz-key",
                "title": "Module quiz",
                "passingPercentage": 70,
                "maxAttempts": 3,
                "timeLimitMinutes": 10,
                "questions": [{
                    "_localId": "temporary-frontend-question-key",
                    "prompt": "Which option is correct?",
                    "options": ["Incorrect", "Correct"],
                    "correctOptionIndices": [1],
                    "marks": 1,
                }],
            }
            update_payload = {
                **self.payload,
                "status": "published",
                "modules": [{
                    "_id": str(module_id),
                    "title": "Module 1",
                    "description": "",
                    "lessons": [],
                    "quiz": dict(quiz_data),
                    "contentItems": [{
                        "type": "quiz",
                        "title": "Module quiz",
                        "quiz": dict(quiz_data),
                        "order": 0,
                    }],
                }],
            }
            save_response = self._request(
                "put",
                f"/api/admin/courses/{course_id}",
                update_payload,
                format="json",
            )

        self.assertEqual(save_response.status_code, 200)
        saved_module = stored_course["modules"][0]
        saved_module_quiz = saved_module["quiz"]
        saved_item_quiz = saved_module["contentItems"][0]["quiz"]
        self.assertIsInstance(saved_module_quiz["_id"], ObjectId)
        self.assertEqual(saved_module_quiz["_id"], saved_item_quiz["_id"])
        self.assertIsInstance(saved_module_quiz["questions"][0]["_id"], ObjectId)
        self.assertEqual(
            saved_module_quiz["questions"][0]["_id"],
            saved_item_quiz["questions"][0]["_id"],
        )
        self.assertNotIn("_localId", saved_module_quiz["questions"][0])
        self.assertNotEqual(str(saved_item_quiz["_id"]), "temporary-frontend-quiz-key")
        self.assertNotIn("_localId", saved_item_quiz)
        self.assertEqual(
            save_response.json()["course"]["modules"][0]["contentItems"][0]["quiz"]["_id"],
            str(saved_item_quiz["_id"]),
        )

        student_id, enrollment_id, attempt_id = ObjectId(), ObjectId(), ObjectId()
        student_document = {
            "_id": student_id,
            "email": "learner@example.com",
            "name": "Learner",
            "role": "student",
            "is_active": True,
        }
        student_token = jwt.encode(
            {"sub": str(student_id), "role": "student", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        student_client = APIClient()
        student_client.credentials(HTTP_AUTHORIZATION=f"Bearer {student_token}")
        enrollment = {
            "_id": enrollment_id,
            "studentId": str(student_id),
            "courseId": str(course_id),
            "status": "in-progress",
        }
        student_courses = MagicMock()
        student_courses.find.return_value.limit.return_value = [stored_course]
        student_courses.find_one.side_effect = lambda query: (
            stored_course
            if query.get("_id") in {course_id, str(course_id)}
            else None
        )
        student_enrollments = MagicMock()
        student_enrollments.find_one.return_value = enrollment
        student_attempts = MagicMock()
        current_attempt = {}

        def insert_student_attempt(document):
            current_attempt.update(document)
            return MagicMock(inserted_id=document["_id"])

        student_attempts.find.return_value.sort.return_value.limit.side_effect = lambda _limit: (
            [dict(current_attempt)] if current_attempt else []
        )
        student_attempts.insert_one.side_effect = insert_student_attempt
        student_attempt_policies = MagicMock()
        policy_state = {}

        def find_policy(query):
            return dict(policy_state) if policy_state.get("_id") == query.get("_id") else None

        def update_policy(query, update, **kwargs):
            if not policy_state and kwargs.get("upsert"):
                policy_state.update(update["$setOnInsert"])
                return dict(policy_state)
            if policy_state.get("_id") != query.get("_id"):
                return None
            for field, value in update.get("$set", {}).items():
                policy_state[field] = value
            return dict(policy_state)

        student_attempt_policies.find_one.side_effect = find_policy
        student_attempt_policies.find_one_and_update.side_effect = update_policy
        student_assignments = MagicMock()
        student_assignments.find.return_value.limit.return_value = []
        student_collections = {
            "courses": student_courses,
            "enrollments": student_enrollments,
            "quiz_attempts": student_attempts,
            "quiz_attempt_policies": student_attempt_policies,
            "assignments": student_assignments,
        }

        with (
            patch(
                "authentication.jwt.collection",
                return_value=MagicMock(
                    find_one=MagicMock(return_value=student_document)
                ),
            ),
            patch(
                "student_api.views.collection",
                side_effect=lambda name: student_collections[name],
            ),
        ):
            course_response = student_client.get("/api/courses/")
            learning_response = student_client.get(
                f"/api/courses/{course_id}/learning-content"
            )
            quiz_id = (
                course_response.json()["courses"][0]["modules"][0]
                ["contentItems"][0]["quiz"]["_id"]
            )
            start_response = student_client.post(
                f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/start",
                {"enrollmentId": str(enrollment_id)},
                format="json",
            )

        self.assertEqual(course_response.status_code, 200)
        self.assertEqual(learning_response.status_code, 200)
        loaded_quiz = (
            learning_response.json()["course"]["modules"][0]
            ["contentItems"][0]["quiz"]
        )
        self.assertEqual(loaded_quiz["_id"], str(saved_item_quiz["_id"]))
        self.assertEqual(start_response.status_code, 201)
        self.assertEqual(
            student_attempts.insert_one.call_args.args[0]["quizId"],
            str(saved_item_quiz["_id"]),
        )
        self.assertNotIn(
            "correctOptionIndices",
            start_response.json()["questions"][0],
        )

    @patch("admin_api.directory_views.collection")
    def test_course_update_supports_legacy_string_object_ids(self, collection):
        course_id = str(ObjectId())
        collection.return_value.find_one_and_update.side_effect = (
            None,
            {"_id": course_id, **self.payload},
        )

        response = self._request(
            "put",
            f"/api/admin/courses/{course_id}",
            self.payload,
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        calls = collection.return_value.find_one_and_update.call_args_list
        self.assertEqual(calls[0].args[0], {"_id": ObjectId(course_id)})
        self.assertEqual(calls[1].args[0], {"_id": course_id})

    @patch("admin_api.directory_views.collection", side_effect=PyMongoError("database detail"))
    def test_course_database_failure_returns_safe_actionable_error(self, collection):
        response = self._request(
            "post",
            "/api/admin/courses",
            self.payload,
            format="json",
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json()["message"],
            "MongoDB could not save the course. Please try again.",
        )
        self.assertNotIn("database detail", response.content.decode())


class AdminQuizQuestionGenerationApiTests(SimpleTestCase):
    path = "/api/admin/courses/generate-quiz-questions"

    def setUp(self):
        self.client = APIClient()
        self.admin_id = ObjectId()
        self.admin_document = {
            "_id": self.admin_id,
            "email": "admin@example.com",
            "name": "Admin",
            "role": "main_admin",
            "is_active": True,
        }
        token = jwt.encode(
            {"sub": str(self.admin_id), "role": "main_admin", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
        self.payload = {
            "lessonContent": "The water cycle includes evaporation, condensation, and precipitation.",
            "questionCount": 3,
            "difficulty": "intermediate",
            "questionTypes": ["multiple-choice", "multiple-select", "true-false"],
        }

    def _request(self, method, *args, **kwargs):
        with patch(
            "authentication.jwt.collection",
            return_value=MagicMock(find_one=MagicMock(return_value=self.admin_document)),
        ):
            return getattr(self.client, method)(self.path, *args, **kwargs)

    def _generated_questions(self):
        return [
            {
                "type": "multiple-choice",
                "prompt": "Which process changes liquid water into vapor?",
                "options": ["Condensation", "Evaporation"],
                "correctOptionIndices": [1],
                "explanation": "Evaporation changes liquid water into vapor.",
            },
            {
                "type": "multiple-select",
                "prompt": "Which are stages of the water cycle?",
                "options": ["Evaporation", "Photosynthesis", "Precipitation"],
                "correctOptionIndices": [0, 2],
                "explanation": "Evaporation and precipitation are stages of the cycle.",
            },
            {
                "type": "true-false",
                "prompt": "Condensation forms clouds.",
                "options": ["True", "False"],
                "correctOptionIndices": [0],
                "explanation": "Condensation forms cloud droplets.",
            },
        ]

    def _mock_gemini_client(self, response_text):
        client = MagicMock()
        client.models.generate_content.return_value.text = response_text
        return client

    def test_admin_post_generates_expected_types_and_count(self):
        gemini_client = self._mock_gemini_client(
            json.dumps({"questions": self._generated_questions()})
        )
        with (
            override_settings(GEMINI_API_KEY="test-key"),
            patch(
                "admin_api.quiz_generation_views.genai.Client",
                return_value=gemini_client,
            ) as gemini_client_factory,
        ):
            response = self._request("post", self.payload, format="json")

        self.assertEqual(response.status_code, 200)
        questions = response.json()["questions"]
        self.assertEqual(len(questions), self.payload["questionCount"])
        self.assertEqual(
            [question["type"] for question in questions],
            self.payload["questionTypes"],
        )
        self.assertEqual(questions[0]["correctOptionIndices"], [1])
        self.assertEqual(questions[1]["correctOptionIndices"], [0, 2])
        self.assertEqual(questions[2]["options"], ["True", "False"])
        gemini_client.models.generate_content.assert_called_once()
        request = gemini_client.models.generate_content.call_args.kwargs
        self.assertEqual(request["model"], settings.GEMINI_MODEL)
        self.assertIn("exactly 3 questions", request["contents"])
        self.assertIn(
            "multiple-select",
            request["config"].response_schema["properties"]["questions"]["items"]["properties"]["type"]["enum"],
        )
        self.assertEqual(request["config"].thinking_config.thinking_level, "LOW")
        gemini_client.close.assert_called_once()
        http_options = gemini_client_factory.call_args.kwargs["http_options"]
        self.assertEqual(http_options.timeout, 120_000)
        self.assertEqual(http_options.retry_options.attempts, 1)

    def test_generation_requires_authenticated_main_admin(self):
        self.client.credentials()
        response = self.client.post(self.path, self.payload, format="json")
        self.assertEqual(response.status_code, 401)

        self.admin_document["role"] = "college_admin"
        token = jwt.encode(
            {"sub": str(self.admin_id), "role": "college_admin", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
        response = self._request("post", self.payload, format="json")
        self.assertEqual(response.status_code, 403)

    def test_missing_gemini_key_returns_configuration_error(self):
        with (
            override_settings(GEMINI_API_KEY=""),
            patch("admin_api.quiz_generation_views.genai.Client") as gemini_client,
        ):
            response = self._request("post", self.payload, format="json")

        self.assertEqual(response.status_code, 503)
        self.assertIn("GEMINI_API_KEY", response.json()["message"])
        gemini_client.assert_not_called()

    def test_invalid_gemini_output_returns_safe_error(self):
        gemini_client = self._mock_gemini_client("not valid JSON")
        with (
            override_settings(GEMINI_API_KEY="test-key"),
            patch("admin_api.quiz_generation_views.genai.Client", return_value=gemini_client),
        ):
            response = self._request("post", self.payload, format="json")

        self.assertEqual(response.status_code, 502)
        self.assertIn("invalid question data", response.json()["message"])

    def test_gemini_quota_error_returns_retryable_status_without_provider_details(self):
        class QuotaError(Exception):
            code = 429

        gemini_client = MagicMock()
        gemini_client.models.generate_content.side_effect = QuotaError("private provider detail")
        with (
            override_settings(GEMINI_API_KEY="test-key"),
            patch("admin_api.quiz_generation_views.genai.Client", return_value=gemini_client),
        ):
            response = self._request("post", self.payload, format="json")

        self.assertEqual(response.status_code, 429)
        self.assertIn("quota", response.json()["message"].lower())
        self.assertNotIn("private provider detail", response.content.decode())

    def test_gemini_service_outage_returns_retryable_status(self):
        class ServiceUnavailableError(Exception):
            code = 503

        gemini_client = MagicMock()
        gemini_client.models.generate_content.side_effect = ServiceUnavailableError(
            "private provider detail test-key"
        )
        with (
            override_settings(
                GEMINI_API_KEY="test-key",
                GEMINI_MODEL="gemini-primary-test",
                GEMINI_FALLBACK_MODEL="gemini-fallback-test",
            ),
            patch("admin_api.quiz_generation_views.genai.Client", return_value=gemini_client),
            patch("admin_api.quiz_generation_views.time.sleep") as sleep,
            patch("admin_api.quiz_generation_views.random.uniform", return_value=0.25),
            self.assertLogs("admin_api.quiz_generation_views", level="WARNING") as logs,
        ):
            response = self._request("post", self.payload, format="json")

        self.assertEqual(response.status_code, 503)
        self.assertIn("temporarily unavailable", response.json()["message"])
        self.assertNotIn("private provider detail", response.content.decode())
        self.assertEqual(gemini_client.models.generate_content.call_count, 4)
        self.assertEqual(sleep.call_count, 3)
        self.assertEqual(
            [call.kwargs["model"] for call in gemini_client.models.generate_content.call_args_list],
            ["gemini-primary-test", "gemini-fallback-test", "gemini-fallback-test", "gemini-fallback-test"],
        )
        self.assertTrue(any("private provider detail" in entry for entry in logs.output))
        self.assertTrue(all("test-key" not in entry for entry in logs.output))

    def test_gemini_primary_503_uses_fallback_model_and_returns_questions(self):
        class ServiceUnavailableError(Exception):
            code = 503

        response_text = json.dumps({"questions": self._generated_questions()})
        gemini_client = self._mock_gemini_client(response_text)
        gemini_client.models.generate_content.side_effect = [
            ServiceUnavailableError("temporary overload"),
            MagicMock(text=response_text),
        ]
        with (
            override_settings(
                GEMINI_API_KEY="test-key",
                GEMINI_MODEL="gemini-primary-test",
                GEMINI_FALLBACK_MODEL="gemini-fallback-test",
            ),
            patch("admin_api.quiz_generation_views.genai.Client", return_value=gemini_client),
            patch("admin_api.quiz_generation_views.time.sleep") as sleep,
            patch("admin_api.quiz_generation_views.random.uniform", return_value=0.5),
        ):
            response = self._request("post", self.payload, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["questions"]), self.payload["questionCount"])
        self.assertEqual(gemini_client.models.generate_content.call_count, 2)
        requests = gemini_client.models.generate_content.call_args_list
        self.assertEqual(
            [call.kwargs["model"] for call in requests],
            ["gemini-primary-test", "gemini-fallback-test"],
        )
        self.assertEqual(requests[0].kwargs["contents"], requests[1].kwargs["contents"])
        self.assertEqual(
            requests[0].kwargs["config"].response_schema,
            requests[1].kwargs["config"].response_schema,
        )
        self.assertEqual(requests[1].kwargs["config"].thinking_config.thinking_level, "LOW")
        sleep.assert_called_once_with(0.5)

    def test_gemini_primary_503_does_not_repeat_if_fallback_matches_primary(self):
        class ServiceUnavailableError(Exception):
            code = 503

        gemini_client = MagicMock()
        gemini_client.models.generate_content.side_effect = ServiceUnavailableError(
            "temporary overload"
        )
        with (
            override_settings(
                GEMINI_API_KEY="test-key",
                GEMINI_MODEL="gemini-same-test",
                GEMINI_FALLBACK_MODEL="gemini-same-test",
            ),
            patch("admin_api.quiz_generation_views.genai.Client", return_value=gemini_client),
            patch("admin_api.quiz_generation_views.time.sleep") as sleep,
        ):
            response = self._request("post", self.payload, format="json")

        self.assertEqual(response.status_code, 503)
        gemini_client.models.generate_content.assert_called_once()
        sleep.assert_not_called()

    def test_gemini_504_returns_timeout_without_retrying(self):
        class GatewayTimeoutError(Exception):
            code = 504

        gemini_client = MagicMock()
        gemini_client.models.generate_content.side_effect = GatewayTimeoutError("provider timed out")
        with (
            override_settings(GEMINI_API_KEY="test-key"),
            patch("admin_api.quiz_generation_views.genai.Client", return_value=gemini_client),
            patch("admin_api.quiz_generation_views.time.sleep") as sleep,
        ):
            response = self._request("post", self.payload, format="json")

        self.assertEqual(response.status_code, 504)
        self.assertIn("timed out", response.json()["message"])
        gemini_client.models.generate_content.assert_called_once()
        sleep.assert_not_called()

    def test_gemini_transport_timeout_returns_timeout_without_retrying(self):
        from httpx import ReadTimeout

        gemini_client = MagicMock()
        gemini_client.models.generate_content.side_effect = ReadTimeout("read timed out")
        with (
            override_settings(GEMINI_API_KEY="test-key"),
            patch("admin_api.quiz_generation_views.genai.Client", return_value=gemini_client),
            patch("admin_api.quiz_generation_views.time.sleep") as sleep,
        ):
            response = self._request("post", self.payload, format="json")

        self.assertEqual(response.status_code, 504)
        gemini_client.models.generate_content.assert_called_once()
        sleep.assert_not_called()

    def test_invalid_request_is_rejected_before_gemini_call(self):
        payload = {**self.payload, "questionCount": 0}
        with (
            override_settings(GEMINI_API_KEY="test-key"),
            patch("admin_api.quiz_generation_views.genai.Client") as gemini_client,
        ):
            response = self._request("post", payload, format="json")

        self.assertEqual(response.status_code, 400)
        gemini_client.assert_not_called()


class HustlerApprovalApiTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin_id = ObjectId()
        self.admin_document = {
            "_id": self.admin_id,
            "email": "admin@example.com",
            "name": "Admin",
            "role": "main_admin",
            "is_active": True,
        }
        token = jwt.encode(
            {"sub": str(self.admin_id), "role": "main_admin", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

    def _request(self, method, path, *args, **kwargs):
        with patch(
            "authentication.jwt.collection",
            return_value=MagicMock(find_one=MagicMock(return_value=self.admin_document)),
        ):
            return getattr(self.client, method)(path, *args, **kwargs)

    @patch("admin_api.approval_views.collection")
    def test_approval_list_returns_paginated_hustlers(self, collection):
        student = {
            "_id": ObjectId(),
            "name": "External Learner",
            "email": "learner@example.com",
            "accountType": "external",
            "role": "student",
            "created_at": None,
            "password_hash": "must-not-leak",
        }
        users = collection.return_value
        users.count_documents.side_effect = (2, 1)
        cursor = MagicMock()
        cursor.sort.return_value = cursor
        cursor.skip.return_value = cursor
        cursor.limit.return_value = cursor
        cursor.__iter__.return_value = iter([student])
        users.find.return_value = cursor

        response = self._request(
            "get",
            "/api/admin/independent-student-approvals?status=pending&page=1&pageSize=25",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["total"], 1)
        self.assertEqual(response.json()["pendingCount"], 2)
        self.assertEqual(response.json()["students"][0]["approvalStatus"], "pending")
        self.assertEqual(response.json()["students"][0]["accountType"], "hustler")
        self.assertEqual(response.json()["students"][0]["_id"], str(student["_id"]))
        self.assertNotIn("password_hash", response.content.decode())

    @patch("admin_api.approval_views.collection")
    def test_approval_details_return_registration_fields_without_password(self, collection):
        student_id = ObjectId()
        collection.return_value.find_one.return_value = {
            "_id": student_id,
            "name": "External Learner",
            "email": "learner@example.com",
            "accountType": "external",
            "role": "student",
            "registrationDetails": {"location": "Remote"},
            "password_hash": "must-not-leak",
        }

        response = self._request(
            "get",
            f"/api/admin/independent-students/{student_id}/approval-details",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["student"]["registrationDetails"]["location"], "Remote")
        self.assertEqual(response.json()["student"]["approvalStatus"], "pending")
        self.assertNotIn("password_hash", response.content.decode())

    @patch("admin_api.approval_views.collection")
    def test_admin_can_approve_pending_hustler(self, collection):
        student_id = ObjectId()
        users = collection.return_value
        users.find_one_and_update.return_value = {
            "_id": student_id,
            "accountType": "external",
            "role": "student",
            "approvalStatus": "approved",
        }

        response = self._request(
            "patch",
            f"/api/admin/independent-students/{student_id}/approval",
            {"decision": "approve"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("approved", response.json()["message"])
        criteria = users.find_one_and_update.call_args.args[0]
        self.assertEqual(criteria["approvalStatus"]["$nin"], ["approved", "rejected"])
        update = users.find_one_and_update.call_args.args[1]["$set"]
        self.assertEqual(update["approvalStatus"], "approved")
        self.assertEqual(update["status"], "approved")
        self.assertEqual(update["approvedBy"], str(self.admin_id))

    @patch("admin_api.approval_views.collection")
    def test_admin_can_reject_pending_hustler_with_reason(self, collection):
        student_id = ObjectId()
        users = collection.return_value
        users.find_one_and_update.return_value = {
            "_id": student_id,
            "accountType": "external",
            "role": "student",
            "approvalStatus": "rejected",
        }

        response = self._request(
            "patch",
            f"/api/admin/independent-students/{student_id}/approval",
            {"decision": "reject", "reason": "Incomplete application"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        update = users.find_one_and_update.call_args.args[1]["$set"]
        self.assertEqual(update["approvalStatus"], "rejected")
        self.assertEqual(update["status"], "rejected")
        self.assertEqual(update["rejectionReason"], "Incomplete application")

    @patch("admin_api.approval_views.collection")
    def test_college_admin_cannot_review_hustler_applications(self, collection):
        self.admin_document = {**self.admin_document, "role": "college_admin"}
        token = jwt.encode(
            {"sub": str(self.admin_id), "role": "college_admin", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self._request(
            "get",
            "/api/admin/independent-student-approvals",
        )

        self.assertEqual(response.status_code, 403)
        collection.assert_not_called()

    @patch("admin_api.dashboard_views.collection")
    def test_admin_overview_returns_real_collection_totals_and_recent_records(self, collection):
        users = MagicMock()
        colleges = MagicMock()
        courses = MagicMock()
        enrollments = MagicMock()
        student = {
            "_id": ObjectId(),
            "name": "Learner",
            "email": "learner@example.com",
            "role": "student",
            "studentType": "independent",
            "status": "pending",
        }
        course = {"_id": ObjectId(), "title": "Course", "status": "draft"}
        user_cursor = MagicMock()
        user_cursor.sort.return_value = user_cursor
        user_cursor.limit.return_value = user_cursor
        user_cursor.__iter__.return_value = iter([student])
        users.find.return_value = user_cursor
        course_cursor = MagicMock()
        course_cursor.sort.return_value = course_cursor
        course_cursor.limit.return_value = course_cursor
        course_cursor.__iter__.return_value = iter([course])
        courses.find.return_value = course_cursor
        users.count_documents.return_value = 2
        colleges.count_documents.return_value = 1
        courses.count_documents.return_value = 3
        enrollments.aggregate.return_value = []
        collections = {
            "users": users,
            "colleges": colleges,
            "courses": courses,
            "enrollments": enrollments,
        }
        collection.side_effect = collections.__getitem__

        response = self._request("get", "/api/admin/overview")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["stats"], {
            "totalStudents": 2,
            "totalColleges": 1,
            "totalCourses": 3,
        })
        self.assertEqual(response.json()["recentRegistrations"][0]["fullName"], "Learner")
        self.assertEqual(response.json()["recentCourses"][0]["title"], "Course")
        self.assertEqual(response.json()["courseCompletion"]["totalEnrollments"], 0)

    @patch("admin_api.dashboard_views.collection")
    def test_admin_engagement_returns_requested_period_buckets(self, collection):
        collection.return_value.count_documents.return_value = 0

        response = self._request("get", "/api/admin/engagement?period=7d")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["period"], "7d")
        self.assertEqual(len(response.json()["engagement"]), 7)
        self.assertTrue(all(item["count"] == 0 for item in response.json()["engagement"]))
        self.assertEqual(collection.return_value.count_documents.call_count, 7)

    @patch("admin_api.directory_views.collection")
    def test_student_directory_returns_safe_paginated_student_records(self, collection):
        users = collection.return_value
        cursor = MagicMock()
        cursor.sort.return_value = cursor
        cursor.skip.return_value = cursor
        cursor.limit.return_value = cursor
        cursor.__iter__.return_value = iter([{
            "_id": ObjectId(),
            "name": "Learner",
            "email": "learner@example.com",
            "role": "student",
            "accountType": "external",
            "approvalStatus": "pending",
            "password_hash": "must-not-leak",
        }])
        users.find.return_value = cursor
        users.count_documents.return_value = 1

        response = self._request(
            "get",
            "/api/admin/students?page=1&pageSize=25&tab=independent",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["total"], 1)
        self.assertEqual(response.json()["students"][0]["studentType"], "independent")
        self.assertEqual(response.json()["students"][0]["approvalStatus"], "pending")
        self.assertNotIn("password_hash", response.content.decode())

    @patch("admin_api.directory_views.collection")
    def test_course_directory_returns_courses_and_expected_statistics(self, collection):
        courses = MagicMock()
        enrollments = MagicMock()
        course = {
            "_id": ObjectId(),
            "title": "Published course",
            "status": "published",
            "modules": [{"lessons": [{"_id": ObjectId()}]}],
        }
        cursor = MagicMock()
        cursor.limit.return_value = cursor
        cursor.__iter__.return_value = iter([course])
        courses.find.return_value = cursor
        enrollments.distinct.return_value = ["student-1"]
        collection.side_effect = lambda name: {
            "courses": courses,
            "enrollments": enrollments,
        }[name]

        response = self._request("get", "/api/admin/courses")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["courses"][0]["_id"], str(course["_id"]))
        self.assertEqual(response.json()["courses"][0]["modules"][0]["lessons"][0]["_id"], str(course["modules"][0]["lessons"][0]["_id"]))
        self.assertEqual(response.json()["stats"], {
            "totalCourses": 1,
            "publishedCourses": 1,
            "draftCourses": 0,
            "totalEnrolledStudents": 1,
        })

    @patch("admin_api.directory_views.collection")
    def test_college_directory_returns_json_records(self, collection):
        collection.return_value.find.return_value.limit.return_value = [{
            "_id": ObjectId(),
            "name": "College",
        }]

        response = self._request("get", "/api/admin/colleges")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["colleges"][0]["name"], "College")
        self.assertEqual(
            response.json()["colleges"][0]["id"],
            response.json()["colleges"][0]["_id"],
        )

    @patch("admin_api.directory_views.collection")
    def test_enrollment_directory_resolves_student_and_course_references(self, collection):
        student_id = ObjectId()
        course_id = ObjectId()
        user_cursor = MagicMock()
        user_cursor.limit.return_value = [{
            "_id": student_id,
            "name": "Learner",
            "role": "student",
        }]
        course_cursor = MagicMock()
        course_cursor.limit.return_value = [{
            "_id": course_id,
            "title": "Course",
        }]
        enrollment_cursor = MagicMock()
        enrollment_cursor.sort.return_value = enrollment_cursor
        enrollment_cursor.limit.return_value = [{
            "_id": ObjectId(),
            "userId": student_id,
            "courseId": str(course_id),
            "status": "in-progress",
        }]
        users = MagicMock(find=MagicMock(return_value=user_cursor))
        courses = MagicMock(find=MagicMock(return_value=course_cursor))
        enrollments = MagicMock(find=MagicMock(return_value=enrollment_cursor))
        collection.side_effect = lambda name: {
            "users": users,
            "courses": courses,
            "enrollments": enrollments,
        }[name]

        response = self._request("get", "/api/admin/enrollments")

        self.assertEqual(response.status_code, 200)
        item = response.json()["enrollments"][0]
        self.assertEqual(item["userId"]["name"], "Learner")
        self.assertEqual(item["courseId"]["title"], "Course")
        self.assertEqual(item["status"], "in-progress")


class AdminAssignmentReviewApiTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin_id = ObjectId()
        admin = {
            "_id": self.admin_id,
            "email": "admin@example.com",
            "name": "Admin",
            "role": "main_admin",
            "is_active": True,
        }
        token = jwt.encode(
            {"sub": str(self.admin_id), "role": "main_admin", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
        self.admin_document = admin
        self.student_id = ObjectId()
        self.course_id = ObjectId()
        self.assignment_id = ObjectId()
        self.submission_id = ObjectId()
        self.student = {
            "_id": self.student_id,
            "role": "student",
            "accountType": "hustler",
            "name": "Python Learner",
            "email": "learner@example.com",
        }
        self.college_student_id = ObjectId()
        self.college_student = {
            "_id": self.college_student_id,
            "role": "student",
            "accountType": "college",
            "studentType": "college",
            "name": "College Learner",
        }
        self.course = {
            "_id": self.course_id,
            "title": "Python Fundamentals",
            "modules": [{
                "contentItems": [{
                    "_id": self.assignment_id,
                    "type": "assignment",
                    "title": "Build a calculator",
                    "points": 100,
                    "passingMarks": 70,
                }],
            }],
        }
        self.enrollment = {
            "_id": ObjectId(),
            "studentId": str(self.student_id),
            "courseId": str(self.course_id),
            "createdAt": datetime.now(timezone.utc) - timedelta(days=1),
        }
        self.submission = {
            "_id": self.submission_id,
            "studentId": str(self.student_id),
            "courseId": str(self.course_id),
            "assignmentId": str(self.assignment_id),
            "fileName": "python_assignment.pdf",
            "fileUrl": "https://res.cloudinary.com/test-cloud/raw/upload/submission.pdf",
            "fileResourceType": "raw",
            "fileType": "application/pdf",
            "fileSize": 128,
            "status": "submitted",
            "submittedAt": datetime.now(timezone.utc),
        }

    def _request(self, method, path, *args, **kwargs):
        with patch(
            "authentication.jwt.collection",
            return_value=MagicMock(find_one=MagicMock(return_value=self.admin_document)),
        ):
            return getattr(self.client, method)(path, *args, **kwargs)

    def _collection_side_effect(self, name):
        if name == "users":
            def find_student(query):
                requested_ids = {
                    str(clause.get("_id"))
                    for clause in query.get("$or", [])
                    if "_id" in clause
                }
                known_students = {
                    str(self.student_id): self.student,
                    str(self.college_student_id): self.college_student,
                }
                return next(
                    (known_students[value] for value in requested_ids if value in known_students),
                    None,
                )
            return MagicMock(find_one=MagicMock(side_effect=find_student))
        if name == "courses":
            def find_course(query):
                requested_id = str(query.get("_id"))
                return self.course if requested_id == str(self.course_id) else None
            return MagicMock(find_one=MagicMock(side_effect=find_course))
        if name == "assignment_submissions":
            cursor = MagicMock()
            cursor.sort.return_value = []
            return MagicMock(find=MagicMock(return_value=cursor), find_one=MagicMock(return_value=None))
        if name == "enrollments":
            return MagicMock(find_one=MagicMock(return_value=self.enrollment))
        if name == "assignments":
            return MagicMock(find_one=MagicMock(return_value=None))
        raise AssertionError(f"Unexpected Mongo collection: {name}")

    def _review_policy_store(self):
        enrollment_at = self.enrollment["createdAt"]
        policy = {
            "_id": f"{self.student_id}:{self.course_id}:{self.assignment_id}",
            "studentId": str(self.student_id),
            "courseId": str(self.course_id),
            "assignmentId": str(self.assignment_id),
            "enrollmentId": str(self.enrollment["_id"]),
            "enrollmentAt": enrollment_at,
            "deadlineAt": enrollment_at + timedelta(days=15),
            "cycleNumber": 1,
            "attemptsUsed": 0,
            "failedAttempts": 0,
            "hasPassed": False,
            "lockoutUntil": None,
            "activeSubmissionId": str(self.submission_id),
        }
        policies = MagicMock()
        policies.find_one.return_value = policy

        def update_policy(query, update, **_kwargs):
            for key, value in query.items():
                if key == "$or":
                    continue
                if key == "hasPassed" and isinstance(value, dict) and value.get("$ne") is True:
                    if policy.get(key) is True:
                        return None
                elif isinstance(value, dict):
                    if "$lt" in value and not policy.get(key) < value["$lt"]:
                        return None
                elif policy.get(key) != value:
                    return None
            policy.update(update.get("$set", {}))
            return dict(policy)

        policies.find_one_and_update.side_effect = update_policy
        return policies, policy

    def _review_database(self, collection):
        stored = dict(self.submission)
        submissions = MagicMock()
        submissions.find_one.side_effect = lambda _query: dict(stored)

        def update_submission(_query, update, **_kwargs):
            stored.update(update.get("$set", {}))
            return dict(stored)

        submissions.find_one_and_update.side_effect = update_submission
        policies, policy = self._review_policy_store()
        collection.side_effect = lambda name: (
            submissions if name == "submissions"
            else policies if name == "assignment_attempt_policies"
            else self._collection_side_effect(name)
        )
        return submissions, policies, policy, stored

    @patch("admin_api.assignment_review_views.collection")
    def test_admin_lists_hustler_assignment_with_student_course_file_and_status(self, collection):
        cursor = MagicMock()
        college_submission = {
            **self.submission,
            "_id": ObjectId(),
            "studentId": str(self.college_student_id),
        }
        cursor.sort.return_value = [self.submission, college_submission]
        submissions = MagicMock(find=MagicMock(return_value=cursor))
        collection.side_effect = lambda name: (
            submissions if name == "submissions" else self._collection_side_effect(name)
        )

        response = self._request("get", "/api/admin/assignment-reviews")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["reviews"]), 1)
        review = response.json()["reviews"][0]
        self.assertEqual(review["studentName"], "Python Learner")
        self.assertEqual(review["courseName"], "Python Fundamentals")
        self.assertEqual(review["assignmentTitle"], "Build a calculator")
        self.assertEqual(review["fileName"], "python_assignment.pdf")
        self.assertEqual(review["status"], "submitted")
        self.assertEqual(review["maximumMarks"], 100)
        self.assertEqual(review["passingMarks"], 70)

    @patch("admin_api.assignment_review_views.collection")
    def test_admin_review_reads_legacy_snake_case_mark_fields(self, collection):
        assignment = self.course["modules"][0]["contentItems"][0]
        assignment.pop("points")
        assignment.pop("passingMarks")
        assignment["maximum_marks"] = 100
        assignment["passing_marks"] = 70
        cursor = MagicMock()
        cursor.sort.return_value = [self.submission]
        submissions = MagicMock(find=MagicMock(return_value=cursor))
        collection.side_effect = lambda name: (
            submissions if name == "submissions" else self._collection_side_effect(name)
        )

        response = self._request("get", "/api/admin/assignment-reviews")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["reviews"][0]["maximumMarks"], 100)
        self.assertEqual(response.json()["reviews"][0]["passingMarks"], 70)

    @patch("admin_api.assignment_review_views.collection")
    def test_admin_can_save_manual_marks_feedback_and_decision(self, collection):
        submissions, _policies, policy, stored = self._review_database(collection)

        response = self._request(
            "put",
            f"/api/admin/assignment-reviews/{self.submission_id}",
            {
                "decision": "approved",
                "marks": 70,
                "feedback": "Clear and correct solution.",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["review"]["status"], "approved")
        self.assertEqual(response.json()["review"]["marks"], 70)
        self.assertEqual(response.json()["review"]["feedback"], "Clear and correct solution.")
        stored_update = submissions.find_one_and_update.call_args.args[1]["$set"]
        self.assertEqual(stored_update["reviewedBy"], str(self.admin_id))
        self.assertEqual(stored_update["gradingStatus"], "Admin Reviewed")
        self.assertEqual(stored_update["attemptNumber"], 1)
        self.assertEqual(stored_update["academicStatus"], "Passed")
        self.assertEqual(stored["reviewDate"], stored["reviewedAt"])
        self.assertEqual(policy["attemptsUsed"], 1)
        self.assertTrue(policy["hasPassed"])
        self.assertIsNone(policy["activeSubmissionId"])

    @patch("admin_api.assignment_review_views.collection")
    def test_admin_can_reject_submission_and_save_marks_and_feedback(self, collection):
        submissions, _policies, policy, stored = self._review_database(collection)

        response = self._request(
            "put",
            f"/api/admin/assignment-reviews/{self.submission_id}",
            {
                "decision": "rejected",
                "marks": 42,
                "feedback": "Please correct the calculation output.",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["review"]["status"], "rejected")
        self.assertEqual(response.json()["review"]["marks"], 42)
        self.assertEqual(
            submissions.find_one_and_update.call_args.args[1]["$set"]["reviewStatus"],
            "rejected",
        )
        self.assertEqual(stored["academicStatus"], "Failed")
        self.assertEqual(stored["attemptNumber"], 1)
        self.assertEqual(policy["attemptsUsed"], 1)
        self.assertEqual(policy["failedAttempts"], 1)
        self.assertFalse(policy["hasPassed"])
        self.assertIsNone(policy["lockoutUntil"])

    @patch("admin_api.assignment_review_views.is_cloudinary_delivery_url", return_value=True)
    @patch("admin_api.assignment_review_views.collection")
    def test_admin_can_download_hustler_submission_file(self, collection, is_cloudinary_url):
        collection.side_effect = lambda name: (
            MagicMock(find_one=MagicMock(return_value=self.submission))
            if name == "submissions"
            else self._collection_side_effect(name)
        )

        response = self._request(
            "get",
            f"/api/admin/assignment-reviews/{self.submission_id}/file",
        )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], self.submission["fileUrl"])
        is_cloudinary_url.assert_called_once_with(self.submission["fileUrl"])

    @patch("admin_api.assignment_review_views.collection")
    def test_admin_review_rejects_marks_above_assignment_points(self, collection):
        submissions = MagicMock(find_one=MagicMock(return_value=self.submission))
        collection.side_effect = lambda name: (
            submissions if name == "submissions" else self._collection_side_effect(name)
        )

        response = self._request(
            "put",
            f"/api/admin/assignment-reviews/{self.submission_id}",
            {"decision": "approved", "marks": 101, "feedback": "Review"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        submissions.find_one_and_update.assert_not_called()

    @patch("admin_api.assignment_review_views.collection")
    def test_admin_decision_must_match_configured_passing_marks(self, collection):
        submissions, _policies, policy, _stored = self._review_database(collection)

        response = self._request(
            "put",
            f"/api/admin/assignment-reviews/{self.submission_id}",
            {"decision": "approved", "marks": 69, "feedback": "Just below passing."},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("passing mark of 70", response.json()["message"])
        submissions.find_one_and_update.assert_not_called()
        self.assertEqual(policy["attemptsUsed"], 0)

    @patch("admin_api.assignment_review_views.collection")
    def test_admin_requires_passing_marks_to_be_configured(self, collection):
        self.course["modules"][0]["contentItems"][0].pop("passingMarks")
        submissions = MagicMock(find_one=MagicMock(return_value=self.submission))
        collection.side_effect = lambda name: (
            submissions if name == "submissions" else self._collection_side_effect(name)
        )

        response = self._request(
            "put",
            f"/api/admin/assignment-reviews/{self.submission_id}",
            {"decision": "approved", "marks": 87, "feedback": "Review"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Configure valid passing marks", response.json()["message"])
        submissions.find_one_and_update.assert_not_called()

    @patch("admin_api.assignment_review_views.collection")
    def test_admin_rejects_passing_marks_above_total_marks(self, collection):
        self.course["modules"][0]["contentItems"][0]["passingMarks"] = 101
        submissions = MagicMock(find_one=MagicMock(return_value=self.submission))
        collection.side_effect = lambda name: (
            submissions if name == "submissions" else self._collection_side_effect(name)
        )

        response = self._request(
            "put",
            f"/api/admin/assignment-reviews/{self.submission_id}",
            {"decision": "approved", "marks": 100, "feedback": "Reviewed."},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Configure valid passing marks", response.json()["message"])
        submissions.find_one_and_update.assert_not_called()


class AdminSettingsApiTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin_id = ObjectId()
        self.admin_document = {
            "_id": self.admin_id,
            "email": "admin@example.com",
            "name": "Platform Admin",
            "fullName": "Platform Admin",
            "username": "platform.admin",
            "password_hash": make_password("old-password"),
            "role": "main_admin",
            "is_active": True,
        }
        token = jwt.encode(
            {"sub": str(self.admin_id), "role": "main_admin", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

    def _request(self, method, path, *args, **kwargs):
        with patch(
            "authentication.jwt.collection",
            return_value=MagicMock(find_one=MagicMock(return_value=self.admin_document)),
        ):
            return getattr(self.client, method)(path, *args, **kwargs)

    def _settings_request(self, method, path, collections, *args, **kwargs):
        with patch(
            "authentication.jwt.collection",
            return_value=MagicMock(find_one=MagicMock(return_value=self.admin_document)),
        ), patch(
            "admin_api.settings_views.collection",
            side_effect=lambda name: collections[name],
        ):
            return getattr(self.client, method)(path, *args, **kwargs)

    def test_settings_get_returns_defaults_and_admin_account(self):
        users = MagicMock(find_one=MagicMock(return_value=self.admin_document))
        admin_settings = MagicMock(find_one=MagicMock(return_value=None))

        response = self._settings_request(
            "get",
            "/api/admin/settings",
            {"users": users, "admin_settings": admin_settings},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["settings"]["organization"], {"name": "", "address": ""})
        self.assertEqual(
            response.json()["settings"]["attendance"]["workingDays"],
            ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        )
        self.assertEqual(response.json()["account"]["name"], "Platform Admin")
        self.assertEqual(response.json()["account"]["username"], "platform.admin")
        self.assertEqual(response.json()["account"]["email"], "admin@example.com")
        self.assertEqual(response.json()["account"]["accountType"], "Platform Admin")
        self.assertNotIn("password_hash", response.json()["account"])

    def test_settings_get_loads_saved_configuration(self):
        stored_settings = {
            "_id": "platform",
            "organization": {"name": "aiHustle", "address": "123 Learning Way"},
            "attendance": {
                "workingDays": ["Monday", "Wednesday", "Friday"],
                "weekStartsOn": "Sunday",
                "shiftStart": "10:00",
                "shiftEnd": "18:00",
            },
            "appearance": {"theme": "dark", "tableDensity": "compact"},
        }
        users = MagicMock(find_one=MagicMock(return_value=self.admin_document))
        admin_settings = MagicMock(find_one=MagicMock(return_value=stored_settings))

        response = self._settings_request(
            "get",
            "/api/admin/settings",
            {"users": users, "admin_settings": admin_settings},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["settings"]["organization"], stored_settings["organization"])
        self.assertEqual(response.json()["settings"]["attendance"], stored_settings["attendance"])
        self.assertEqual(response.json()["settings"]["appearance"], stored_settings["appearance"])

    def test_settings_put_saves_organization_attendance_appearance_and_admin_name(self):
        updated_admin = {**self.admin_document, "name": "Updated Admin", "fullName": "Updated Admin"}
        users = MagicMock(
            update_one=MagicMock(return_value=MagicMock(matched_count=1)),
            find_one=MagicMock(return_value=updated_admin),
        )
        admin_settings = MagicMock(update_one=MagicMock())
        payload = {
            "organization": {"name": "aiHustle", "address": "123 Learning Way"},
            "attendance": {
                "workingDays": ["Monday", "Tuesday", "Wednesday"],
                "weekStartsOn": "Monday",
                "shiftStart": "08:30",
                "shiftEnd": "16:30",
            },
            "appearance": {"theme": "dark", "tableDensity": "compact"},
            "name": "Updated Admin",
        }

        response = self._settings_request(
            "put",
            "/api/admin/settings",
            {"users": users, "admin_settings": admin_settings},
            payload,
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["settings"]["organization"], payload["organization"])
        self.assertEqual(response.json()["settings"]["attendance"], payload["attendance"])
        self.assertEqual(response.json()["settings"]["appearance"], payload["appearance"])
        self.assertEqual(response.json()["account"]["name"], "Updated Admin")
        users.update_one.assert_called_once_with(
            {"_id": self.admin_id},
            {"$set": {"name": "Updated Admin", "fullName": "Updated Admin"}},
        )
        query, update = admin_settings.update_one.call_args.args
        self.assertEqual(query, {"_id": "platform"})
        self.assertEqual(update["$set"]["attendance"], payload["attendance"])
        self.assertTrue(admin_settings.update_one.call_args.kwargs["upsert"])

    def test_settings_put_rejects_duplicate_working_days(self):
        users = MagicMock()
        admin_settings = MagicMock()
        payload = {
            "organization": {"name": "", "address": ""},
            "attendance": {
                "workingDays": ["Monday", "Monday"],
                "weekStartsOn": "Monday",
                "shiftStart": "09:00",
                "shiftEnd": "17:00",
            },
            "appearance": {"theme": "light", "tableDensity": "comfortable"},
            "name": "Platform Admin",
        }

        response = self._settings_request(
            "put",
            "/api/admin/settings",
            {"users": users, "admin_settings": admin_settings},
            payload,
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        users.update_one.assert_not_called()
        admin_settings.update_one.assert_not_called()

    def test_password_change_updates_the_existing_password_hash(self):
        users = MagicMock(
            find_one=MagicMock(return_value=self.admin_document),
            update_one=MagicMock(return_value=MagicMock(matched_count=1)),
        )

        response = self._settings_request(
            "post",
            "/api/admin/settings/password",
            {"users": users},
            {"currentPassword": "old-password", "newPassword": "new-password-123"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        password_hash = users.update_one.call_args.args[1]["$set"]["password_hash"]
        self.assertTrue(check_password("new-password-123", password_hash))

    def test_password_change_rejects_incorrect_current_password(self):
        users = MagicMock(
            find_one=MagicMock(return_value=self.admin_document),
            update_one=MagicMock(return_value=MagicMock(matched_count=1)),
        )

        response = self._settings_request(
            "post",
            "/api/admin/settings/password",
            {"users": users},
            {"currentPassword": "wrong-password", "newPassword": "new-password-123"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        users.update_one.assert_not_called()

    @patch(
        "admin_api.settings_views.upload_media",
        return_value={
            "secureUrl": "https://res.cloudinary.com/test/image/upload/avatar.png",
            "publicId": "aihustle-lms/profile_image/admin/avatar",
            "resourceType": "image",
            "format": "png",
            "bytes": 16,
            "originalName": "avatar.png",
            "width": 1,
            "height": 1,
        },
    )
    def test_avatar_upload_saves_cloudinary_metadata_to_admin_user(self, upload):
        users = MagicMock(
            find_one=MagicMock(return_value=self.admin_document),
            update_one=MagicMock(return_value=MagicMock(matched_count=1)),
        )
        avatar = SimpleUploadedFile(
            "avatar.png",
            b"\x89PNG\r\n\x1a\nmore",
            content_type="image/png",
        )

        response = self._settings_request(
            "post",
            "/api/admin/settings/avatar",
            {"users": users},
            {"avatar": avatar},
            format="multipart",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["avatarUrl"], upload.return_value["secureUrl"])
        upload.assert_called_once()
        self.assertEqual(
            users.update_one.call_args.args[1]["$set"]["avatarPublicId"],
            upload.return_value["publicId"],
        )

    def test_settings_are_forbidden_to_non_admin_accounts(self):
        student = {
            **self.admin_document,
            "role": "student",
        }
        token = jwt.encode(
            {"sub": str(self.admin_id), "role": "student", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
        with patch(
            "authentication.jwt.collection",
            return_value=MagicMock(find_one=MagicMock(return_value=student)),
        ):
            response = self.client.get("/api/admin/settings")

        self.assertEqual(response.status_code, 403)

    def test_admin_profile_update_saves_name_and_normalized_username(self):
        updated_admin = {
            **self.admin_document,
            "name": "Updated Platform Admin",
            "fullName": "Updated Platform Admin",
            "username": "new.admin",
        }
        users = MagicMock(
            find_one=MagicMock(side_effect=[self.admin_document, None, updated_admin]),
            update_one=MagicMock(return_value=MagicMock(matched_count=1)),
        )

        response = self._settings_request(
            "patch",
            "/api/admin/settings/profile",
            {"users": users},
            {"displayName": "Updated Platform Admin", "username": "New.Admin"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["account"]["name"], "Updated Platform Admin")
        self.assertEqual(response.json()["account"]["username"], "new.admin")
        self.assertEqual(response.json()["account"]["email"], "admin@example.com")
        self.assertEqual(
            users.update_one.call_args.args[1]["$set"],
            {
                "name": "Updated Platform Admin",
                "fullName": "Updated Platform Admin",
                "username": "new.admin",
            },
        )

    def test_admin_profile_update_rejects_an_existing_username(self):
        duplicate_user = {"_id": ObjectId(), "username": "already.used"}
        users = MagicMock(find_one=MagicMock(side_effect=[self.admin_document, duplicate_user]))

        response = self._settings_request(
            "patch",
            "/api/admin/settings/profile",
            {"users": users},
            {"displayName": "Platform Admin", "username": "Already.Used"},
            format="json",
        )

        self.assertEqual(response.status_code, 409)
        users.update_one.assert_not_called()

    def test_platform_super_admin_account_deletion_is_forbidden(self):
        users = MagicMock()

        response = self._settings_request(
            "delete",
            "/api/admin/settings/account",
            {"users": users},
        )

        self.assertEqual(response.status_code, 403)
        self.assertIn("cannot be deleted", response.json()["message"].lower())
        users.delete_one.assert_not_called()


class AdminCertificateTemplateApiTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin_id = ObjectId()
        self.admin_document = {
            "_id": self.admin_id,
            "email": "admin@example.com",
            "name": "Platform Admin",
            "role": "main_admin",
            "is_active": True,
        }
        token = jwt.encode(
            {"sub": str(self.admin_id), "role": "main_admin", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

    def _request(self, method, path, *args, **kwargs):
        with patch(
            "authentication.jwt.collection",
            return_value=MagicMock(find_one=MagicMock(return_value=self.admin_document)),
        ):
            return getattr(self.client, method)(path, *args, **kwargs)

    def test_template_get_returns_active_cloudinary_metadata(self):
        template = {
            "_id": "active",
            "secureUrl": "https://res.cloudinary.com/test/image/upload/background.png",
            "originalName": "background.png",
            "format": "png",
            "bytes": 128,
        }
        templates = MagicMock(find_one=MagicMock(return_value=template))
        with patch("admin_api.certificate_views.collection", return_value=templates):
            response = self._request("get", "/api/admin/certificate-template")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["uploaded"])
        self.assertEqual(response.json()["secureUrl"], template["secureUrl"])
        self.assertEqual(response.json()["fileName"], "background.png")

    @patch(
        "admin_api.certificate_views.upload_media",
        return_value={
            "secureUrl": "https://res.cloudinary.com/test/image/upload/certificate.png",
            "publicId": "aihustle-lms/certificate_template/platform/background",
            "resourceType": "image",
            "format": "png",
            "bytes": 128,
            "originalName": "certificate.png",
            "width": 1200,
            "height": 800,
            "version": 4,
        },
    )
    @patch("admin_api.certificate_views.delete_media")
    def test_template_upload_saves_cloudinary_metadata_without_deleting_old_assets(
        self,
        delete_media,
        upload_media,
    ):
        templates = MagicMock(update_one=MagicMock())
        image_buffer = BytesIO()
        Image.new("RGB", (4, 3), "white").save(image_buffer, format="PNG")
        template_file = SimpleUploadedFile(
            "certificate.png",
            image_buffer.getvalue(),
            content_type="image/png",
        )
        with patch("admin_api.certificate_views.collection", return_value=templates):
            response = self._request(
                "post",
                "/api/admin/certificate-template",
                {"template": template_file},
                format="multipart",
            )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["uploaded"])
        self.assertEqual(response.json()["secureUrl"], upload_media.return_value["secureUrl"])
        upload_media.assert_called_once()
        self.assertEqual(upload_media.call_args.args[0].name, "certificate.png")
        self.assertEqual(upload_media.call_args.args[1], "certificate_template")
        self.assertEqual(upload_media.call_args.kwargs["owner_id"], str(self.admin_id))
        saved = templates.update_one.call_args.args[1]["$set"]
        self.assertEqual(saved["publicId"], upload_media.return_value["publicId"])
        self.assertEqual(saved["originalName"], "certificate.png")
        self.assertTrue(templates.update_one.call_args.kwargs["upsert"])
        delete_media.assert_not_called()

    def test_template_upload_rejects_non_image_files_before_cloudinary(self):
        templates = MagicMock()
        pdf_file = SimpleUploadedFile("certificate.pdf", b"%PDF-1.4", content_type="application/pdf")
        with patch("admin_api.certificate_views.collection", return_value=templates), patch(
            "admin_api.certificate_views.upload_media"
        ) as upload_media:
            response = self._request(
                "post",
                "/api/admin/certificate-template",
                {"template": pdf_file},
                format="multipart",
            )

        self.assertEqual(response.status_code, 400)
        upload_media.assert_not_called()
        templates.update_one.assert_not_called()
