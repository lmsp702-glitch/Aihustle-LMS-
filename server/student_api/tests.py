import jwt
from bson import ObjectId
from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase
from rest_framework.test import APIClient
from unittest.mock import MagicMock, patch


class StudentApiTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.user_id = ObjectId()
        self.user_document = {
            "_id": self.user_id,
            "email": "learner@example.com",
            "name": "External Learner",
            "role": "student",
            "accountType": "external",
            "status": "approved",
            "approvalStatus": "approved",
            "is_active": True,
        }
        token = jwt.encode(
            {"sub": str(self.user_id), "role": "student", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
        self.auth_users = MagicMock()
        self.auth_users.find_one.return_value = self.user_document
        self.collections = {}

    def _collection(self, name):
        if name not in self.collections:
            collection = MagicMock()
            cursor = MagicMock()
            cursor.limit.return_value = []
            cursor.sort.return_value = cursor
            collection.find.return_value = cursor
            collection.find_one.return_value = None
            self.collections[name] = collection
        return self.collections[name]

    def _request(self, method, path, *args, **kwargs):
        with patch("authentication.jwt.collection", return_value=self.auth_users), patch(
            "student_api.views.collection", side_effect=self._collection
        ), patch("core.views.collection", side_effect=self._collection):
            return getattr(self.client, method)(path, *args, **kwargs)

    def test_dashboard_endpoints_return_expected_empty_json_shapes(self):
        cases = [
            ("/api/enrollments/me", "enrollments"),
            ("/api/courses/recommendations", "recommendations"),
            ("/api/learning/summary", "summary"),
            ("/api/certificates", "certificates"),
            ("/api/notifications/me", "notifications"),
            ("/api/referrals/me", "codes"),
            ("/api/courses", "courses"),
            ("/api/courses/", "courses"),
        ]
        for path, key in cases:
            with self.subTest(path=path):
                response = self._request("get", path)
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response["Content-Type"].startswith("application/json"))
                self.assertIn(key, response.json())
                if key == "summary":
                    self.assertEqual(response.json()[key]["enrolledCourses"], 0)
                    self.assertEqual(response.json()[key]["totalLessons"], 0)
                else:
                    self.assertEqual(response.json()[key], [])

        activity = self._request(
            "get",
            "/api/learning/activity?start=2025-01-01&end=2025-01-07",
        )
        self.assertEqual(activity.status_code, 200)
        self.assertEqual(len(activity.json()["days"]), 7)
        self.assertTrue(all(day["seconds"] == 0 for day in activity.json()["days"]))

    def test_unauthenticated_student_api_returns_json_401(self):
        self.client.credentials()
        response = self.client.get("/api/learning/summary")

        self.assertEqual(response.status_code, 401)
        self.assertTrue(response["Content-Type"].startswith("application/json"))

    def test_main_admin_can_load_own_notifications_without_being_logged_out(self):
        self.user_document["role"] = "main_admin"
        token = jwt.encode(
            {"sub": str(self.user_id), "role": "main_admin", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

        response = self._request("get", "/api/notifications/me")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"notifications": [], "unreadCount": 0})

    def test_unmatched_api_route_returns_json_404(self):
        self.client.credentials()
        response = self.client.get("/api/not-a-student-endpoint")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"message": "API route not found."})

    def test_student_course_payload_hides_quiz_answer_keys(self):
        course = {
            "_id": ObjectId(),
            "title": "Course with a quiz",
            "status": "published",
            "modules": [{
                "quizzes": [{
                    "questions": [{
                        "_id": ObjectId(),
                        "prompt": "Question",
                        "options": ["A", "B"],
                        "correctOptionIndices": [1],
                        "correctAnswer": "B",
                    }],
                }],
            }],
        }
        cursor = self._collection("courses").find.return_value
        cursor.limit.return_value = [course]

        response = self._request("get", "/api/courses/")

        question = response.json()["courses"][0]["modules"][0]["quizzes"][0]["questions"][0]
        self.assertEqual(question["options"], ["A", "B"])
        self.assertNotIn("correctOptionIndices", question)
        self.assertNotIn("correctAnswer", question)

    def test_certificate_page_includes_in_progress_enrollment_requirements(self):
        course_id = ObjectId()
        lesson_id = ObjectId()
        course = {
            "_id": course_id,
            "title": "Learning course",
            "modules": [{"lessons": [{"_id": lesson_id, "title": "First lesson"}]}],
        }
        enrollment = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "courseProgress": 0,
            "completedLessonIds": [],
        }
        self._collection("courses").find_one.return_value = course
        enrollment_cursor = self._collection("enrollments").find.return_value
        enrollment_cursor.limit.return_value = [enrollment]

        response = self._request("get", "/api/certificates")

        self.assertEqual(response.status_code, 200)
        course_status = response.json()["certificates"][0]
        self.assertEqual(course_status["courseName"], "Learning course")
        self.assertIsNone(course_status["certificate"])
        self.assertEqual(course_status["pendingRequirements"][0]["id"], str(lesson_id))

    def test_quiz_attempt_withholds_answers_until_submission(self):
        course_id = ObjectId()
        quiz_id = ObjectId()
        question_id = ObjectId()
        enrollment = {"_id": ObjectId(), "studentId": str(self.user_id), "courseId": str(course_id)}
        course = {
            "_id": course_id,
            "quizzes": [{
                "_id": quiz_id,
                "title": "Quiz",
                "questions": [{
                    "_id": question_id,
                    "prompt": "Choose the right answer",
                    "options": ["Wrong", "Right"],
                    "correctOptionIndices": [1],
                    "points": 2,
                }],
            }],
        }
        self._collection("enrollments").find_one.return_value = enrollment
        self._collection("courses").find_one.return_value = course
        attempts = self._collection("quiz_attempts")
        attempt_id = ObjectId()
        attempts.insert_one.return_value.inserted_id = attempt_id

        start = self._request(
            "post",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/start",
            {"enrollmentId": str(enrollment["_id"])},
            format="json",
        )

        self.assertEqual(start.status_code, 201)
        self.assertNotIn("correctOptionIndices", start.json()["questions"][0])

        saved_attempt = {
            "_id": attempt_id,
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "quizId": str(quiz_id),
            "status": "started",
            "questions": course["quizzes"][0]["questions"],
        }
        updated_attempt = {
            **saved_attempt,
            "status": "submitted",
            "answers": [{
                "questionId": str(question_id),
                "selectedOptionIndices": [1],
                "correctOptionIndices": [1],
            }],
            "scorePercentage": 100,
            "correctAnswers": 1,
            "incorrectAnswers": 0,
            "passed": True,
        }
        attempts.find_one.return_value = saved_attempt
        attempts.find.return_value.limit.return_value = [updated_attempt]
        attempts.find_one_and_update.return_value = updated_attempt

        submission = self._request(
            "post",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/{attempt_id}/submit",
            {
                "answers": [{
                    "questionId": str(question_id),
                    "selectedOptionIndices": [1],
                }],
            },
            format="json",
        )

        self.assertEqual(submission.status_code, 200)
        self.assertEqual(submission.json()["attempt"]["answers"][0]["correctOptionIndices"], [1])
        self.assertEqual(submission.json()["attempt"]["correctAnswers"], 1)

    def test_student_api_error_routes_return_json_not_html(self):
        object_id = "000000000000000000000001"
        requests = [
            ("patch", f"/api/enrollments/{object_id}/progress", {"lessonId": "lesson"}),
            ("post", f"/api/enrollments/{object_id}/learning-activity", {}),
            ("get", f"/api/courses/{object_id}/learning-content", None),
            ("get", f"/api/certificates/{object_id}/pdf", None),
            ("patch", "/api/notifications/read-all", {}),
            ("patch", f"/api/notifications/{object_id}/read", {}),
            ("delete", f"/api/notifications/{object_id}", None),
            ("post", f"/api/courses/{object_id}/assignments/{object_id}/submissions", {}),
            ("post", f"/api/assignment-submissions/{object_id}/human-review-requests", {}),
            ("get", f"/api/assignment-submissions/{object_id}/download", None),
            ("get", f"/api/courses/{object_id}/quizzes/{object_id}/attempts/status", None),
            ("post", f"/api/courses/{object_id}/quizzes/{object_id}/attempts/start", {}),
            ("post", f"/api/courses/{object_id}/quizzes/{object_id}/attempts/{object_id}/submit", {}),
            ("post", f"/api/courses/{object_id}/attention-checks/{object_id}/start", {}),
            ("post", f"/api/courses/{object_id}/attention-checks/{object_id}/submit", {"responseId": object_id}),
            ("get", f"/api/courses/{object_id}/resources/{object_id}/file", None),
        ]
        for method, path, body in requests:
            with self.subTest(method=method, path=path):
                if body is None:
                    response = self._request(method, path)
                else:
                    response = self._request(method, path, body, format="json")
                self.assertFalse(response["Content-Type"].startswith("text/html"))
                self.assertIn(response.status_code, {200, 400, 404, 405})

    def test_student_can_create_an_enrollment_for_a_published_course(self):
        course_id = ObjectId()
        course = {"_id": course_id, "title": "Published course", "status": "published"}
        self._collection("courses").find_one.return_value = course
        enrollment_collection = self._collection("enrollments")
        enrollment_collection.insert_one.return_value.inserted_id = ObjectId()

        response = self._request(
            "post",
            "/api/enrollments",
            {"courseId": str(course_id)},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["enrollment"]["status"], "in-progress")
        self.assertEqual(response.json()["enrollment"]["courseId"]["title"], "Published course")
        self.assertEqual(enrollment_collection.insert_one.call_count, 1)

    def test_student_progress_updates_only_owned_course_lessons(self):
        course_id = ObjectId()
        lesson_id = ObjectId()
        enrollment = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "completedLessonIds": [],
            "startedLessonIds": [],
            "lessonPlaybackPositions": {},
            "lessonWatchedPositions": {},
        }
        course = {
            "_id": course_id,
            "modules": [{"lessons": [{"_id": lesson_id}]}],
        }
        self._collection("enrollments").find_one.return_value = enrollment
        self._collection("courses").find_one.return_value = course
        self._collection("enrollments").find_one_and_update.return_value = {
            **enrollment,
            "lessonPlaybackPositions": {str(lesson_id): 12},
            "lessonWatchedPositions": {str(lesson_id): 12},
            "startedLessonIds": [str(lesson_id)],
        }

        response = self._request(
            "patch",
            f"/api/enrollments/{enrollment['_id']}/progress",
            {"lessonId": str(lesson_id), "positionSeconds": 12, "started": True},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["maxPositionSeconds"], 12)
        self.assertEqual(
            self._collection("enrollments").find_one_and_update.call_count,
            1,
        )

    def test_referral_generation_enforces_the_daily_limit(self):
        codes = self._collection("referral_codes")
        codes.count_documents.side_effect = [5, 5]

        response = self._request(
            "post",
            "/api/referrals/generate",
            {"requestId": "request-1"},
            format="json",
        )

        self.assertEqual(response.status_code, 429)
        codes.insert_one.assert_not_called()

    @patch(
        "student_api.views.upload_media",
        return_value={
            "secureUrl": "https://res.cloudinary.com/test-cloud/raw/upload/submission.pdf",
            "publicId": "aihustle-lms/assignment_submission/asset",
            "resourceType": "raw",
            "format": "pdf",
            "bytes": 12,
            "originalName": "answer.pdf",
        },
    )
    def test_assignment_pdf_is_saved_as_cloudinary_metadata_not_file_data(self, upload):
        course_id = ObjectId()
        assignment_id = ObjectId()
        course = {
            "_id": course_id,
            "assignments": [{"_id": assignment_id, "title": "Assignment"}],
        }
        self._collection("courses").find_one.return_value = course
        self._collection("enrollments").find_one.return_value = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
        }
        submissions = self._collection("submissions")
        submissions.insert_one.return_value.inserted_id = ObjectId()
        pdf = SimpleUploadedFile(
            "answer.pdf",
            b"%PDF-1.4 test document",
            content_type="application/pdf",
        )

        response = self._request(
            "post",
            f"/api/courses/{course_id}/assignments/{assignment_id}/submissions",
            {"file": pdf},
            format="multipart",
        )

        self.assertEqual(response.status_code, 201)
        document = submissions.insert_one.call_args.args[0]
        self.assertEqual(document["fileUrl"], upload.return_value["secureUrl"])
        self.assertEqual(document["filePublicId"], upload.return_value["publicId"])
        self.assertNotIn("fileId", document)
        self.assertNotIn("fileContent", document)
        upload.assert_called_once()
        self.assertEqual(upload.call_args.args[1], "assignment_submission")
        self.assertEqual(upload.call_args.kwargs["owner_id"], str(self.user_id))
        self.assertEqual(upload.call_args.kwargs["course_id"], str(course_id))
        self.assertEqual(upload.call_args.args[0].name, "answer.pdf")

    @patch(
        "student_api.views.upload_media",
        return_value={
            "secureUrl": "https://res.cloudinary.com/test-cloud/image/upload/avatar.png",
            "publicId": "aihustle-lms/profile_image/user/avatar",
            "resourceType": "image",
            "format": "png",
            "bytes": 12,
            "originalName": "avatar.png",
            "width": 1,
            "height": 1,
        },
    )
    def test_profile_avatar_upload_updates_user_cloudinary_fields(self, upload):
        users = self._collection("users")
        users.update_one.return_value.matched_count = 1
        avatar = SimpleUploadedFile(
            "avatar.png",
            b"\x89PNG\r\n\x1a\nmore",
            content_type="image/png",
        )

        response = self._request(
            "post",
            "/api/student/profile/avatar",
            {"avatar": avatar},
            format="multipart",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["avatarUrl"], upload.return_value["secureUrl"])
        update = users.update_one.call_args.args[1]["$set"]
        self.assertEqual(update["avatarPublicId"], upload.return_value["publicId"])
        self.assertNotIn("file", update)
        upload.assert_called_once()
