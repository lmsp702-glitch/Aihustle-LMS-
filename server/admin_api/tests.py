import jwt
from bson import ObjectId
from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase
from rest_framework.test import APIClient
from unittest.mock import MagicMock, patch


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
        video = SimpleUploadedFile(
            "lesson.mp4",
            b"\x00\x00\x00\x18ftypisomfake",
            content_type="video/mp4",
        )

        response = self._authenticated_request(
            "post",
            f"/api/admin/courses/{course_id}/modules/{module_id}/media/video",
            {"file": video},
            format="multipart",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["resourceType"], "video")
        self.assertEqual(response.json()["publicId"], upload.return_value["publicId"])
        stored_asset = collection.return_value.insert_one.call_args.args[0]
        self.assertEqual(stored_asset["secureUrl"], upload.return_value["secureUrl"])
        self.assertEqual(stored_asset["courseId"], str(course_id))
        self.assertNotIn("api_secret", repr(stored_asset).lower())
        upload.assert_called_once()

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


class ExternalStudentApprovalApiTests(SimpleTestCase):
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
    def test_approval_list_returns_paginated_external_users(self, collection):
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
    def test_admin_can_approve_pending_external_user(self, collection):
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
    def test_admin_can_reject_pending_external_user_with_reason(self, collection):
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
    def test_college_admin_cannot_review_external_user_applications(self, collection):
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
