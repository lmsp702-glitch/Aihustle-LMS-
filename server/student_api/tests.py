from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import jwt
from bson import ObjectId
from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase
from PIL import Image
from pymongo.errors import DuplicateKeyError, PyMongoError
from rest_framework.test import APIClient


def _minimal_pdf_bytes():
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = []
    objects = [
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n",
        b"4 0 obj\n<< /Length 0 >>\nstream\nendstream\nendobj\n",
    ]
    for document in objects:
        offsets.append(len(pdf))
        pdf.extend(document)
    xref_offset = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode()
    )
    return bytes(pdf)


class StudentApiTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.user_id = ObjectId()
        self.user_document = {
            "_id": self.user_id,
            "email": "learner@example.com",
            "name": "External Learner",
            "role": "student",
            "accountType": "hustler",
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
            if name == "quiz_attempt_policies":
                documents = {}

                def find_one(query):
                    document = documents.get(query.get("_id"))
                    return dict(document) if document is not None else None

                def find_one_and_update(query, update, **kwargs):
                    policy_id = query.get("_id")
                    document = documents.get(policy_id)
                    if document is None and kwargs.get("upsert"):
                        document = dict(update.get("$setOnInsert", {}))
                        documents[policy_id] = document
                        return dict(document)
                    if document is None:
                        return None
                    for field, expected in query.items():
                        if field == "_id":
                            continue
                        actual = document.get(field)
                        if isinstance(expected, dict):
                            if "$lt" in expected and not actual < expected["$lt"]:
                                return None
                            if "$ne" in expected and actual == expected["$ne"]:
                                return None
                        elif actual != expected:
                            return None
                    for field, value in update.get("$set", {}).items():
                        document[field] = value
                    for field, value in update.get("$inc", {}).items():
                        document[field] = document.get(field, 0) + value
                    for field, value in update.get("$addToSet", {}).items():
                        values = document.setdefault(field, [])
                        if value not in values:
                            values.append(value)
                    return dict(document)

                collection.find_one.side_effect = find_one
                collection.find_one_and_update.side_effect = find_one_and_update
                collection._documents = documents
            if name == "assignment_attempt_policies":
                documents = {}

                def matches(document, query):
                    for field, expected in query.items():
                        if field == "$and":
                            if not all(matches(document, clause) for clause in expected):
                                return False
                            continue
                        if field == "$or":
                            if not any(matches(document, clause) for clause in expected):
                                return False
                            continue
                        actual = document.get(field)
                        if isinstance(expected, dict):
                            for operator, value in expected.items():
                                if operator == "$ne" and actual == value:
                                    return False
                                if operator == "$lt" and not actual < value:
                                    return False
                                if operator == "$lte" and not actual <= value:
                                    return False
                                if operator == "$gt" and not actual > value:
                                    return False
                        elif actual != expected:
                            return False
                    return True

                def find_one(query):
                    document = documents.get(query.get("_id"))
                    return dict(document) if document is not None and matches(document, query) else None

                def find_one_and_update(query, update, **kwargs):
                    policy_id = query.get("_id")
                    document = documents.get(policy_id)
                    if document is None and kwargs.get("upsert"):
                        document = dict(update.get("$setOnInsert", {}))
                        documents[policy_id] = document
                        return dict(document)
                    if document is None or not matches(document, query):
                        return None
                    document.update(update.get("$set", {}))
                    for field, value in update.get("$inc", {}).items():
                        document[field] = document.get(field, 0) + value
                    return dict(document)

                def update_one(query, update):
                    document = documents.get(query.get("_id"))
                    if document is not None and matches(document, query):
                        document.update(update.get("$set", {}))
                        return SimpleNamespace(modified_count=1)
                    return SimpleNamespace(modified_count=0)

                collection.find_one.side_effect = find_one
                collection.find_one_and_update.side_effect = find_one_and_update
                collection.update_one.side_effect = update_one
                collection._documents = documents
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
                        "correctOptionIndex": 1,
                        "correctAnswer": "B",
                    }],
                }],
            }],
        }
        cursor = self._collection("courses").find.return_value
        cursor.__iter__.return_value = [course]

        response = self._request("get", "/api/courses/")

        question = response.json()["courses"][0]["modules"][0]["quizzes"][0]["questions"][0]
        self.assertEqual(question["options"], ["A", "B"])
        self.assertNotIn("correctOptionIndices", question)
        self.assertNotIn("correctOptionIndex", question)
        self.assertNotIn("correctAnswer", question)

    def test_student_dashboard_omits_unsaved_quizzes_but_keeps_saved_quizzes(self):
        saved_quiz_id = ObjectId()
        course = {
            "_id": ObjectId(),
            "title": "Course with saved and unsaved quizzes",
            "status": "published",
            "quizzes": [
                {"title": "Unsaved course quiz"},
                {"_id": saved_quiz_id, "title": "Saved course quiz"},
            ],
            "modules": [{
                "quiz": {"title": "Unsaved legacy module quiz"},
                "contentItems": [
                    {
                        "type": "quiz",
                        "title": "Unsaved item quiz",
                        "quiz": {"title": "Unsaved item quiz"},
                    },
                    {
                        "type": "quiz",
                        "title": "Saved item quiz",
                        "quiz": {"_id": saved_quiz_id, "title": "Saved item quiz"},
                    },
                ],
            }],
        }
        self._collection("courses").find.return_value.__iter__.return_value = [course]

        response = self._request("get", "/api/courses/")

        self.assertEqual(response.status_code, 200)
        student_course = response.json()["courses"][0]
        self.assertEqual(
            [quiz["title"] for quiz in student_course["quizzes"]],
            ["Saved course quiz"],
        )
        module = student_course["modules"][0]
        self.assertNotIn("quiz", module)
        self.assertEqual(
            [item["title"] for item in module["contentItems"]],
            ["Saved item quiz"],
        )
        self.assertEqual(
            module["contentItems"][0]["quiz"]["_id"],
            str(saved_quiz_id),
        )

    def test_hustler_course_list_uses_published_status_and_does_not_enroll(self):
        published_id = ObjectId()
        published_course = {
            "_id": published_id,
            "title": "Published course with stale flags",
            "status": "published",
            "published": False,
            "isPublished": False,
            "is_published": False,
        }
        draft_course = {
            "_id": ObjectId(),
            "title": "Draft course",
            "status": "draft",
            "published": True,
            "isPublished": True,
            "is_published": True,
        }
        unpublished_course = {
            "_id": ObjectId(),
            "title": "Unpublished course",
            "status": "unpublished",
        }
        self._collection("courses").find.return_value.__iter__.return_value = [
            published_course,
            draft_course,
            unpublished_course,
        ]

        response = self._request("get", "/api/courses")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [course["_id"] for course in response.json()["courses"]],
            [str(published_id)],
        )
        self._collection("enrollments").find.assert_not_called()
        self._collection("enrollments").insert_one.assert_not_called()

    def test_college_course_list_keeps_existing_publication_flag_filter(self):
        self.user_document.update({
            "accountType": "college",
            "studentType": "college",
        })
        course = {
            "_id": ObjectId(),
            "title": "Published course with stale flags",
            "status": "published",
            "published": False,
        }
        self._collection("courses").find.return_value.limit.return_value = [course]

        response = self._request("get", "/api/courses")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["courses"], [])

    def test_hustler_course_list_returns_published_courses_past_old_limit(self):
        courses = [
            {"_id": ObjectId(), "title": f"Published course {index}", "status": "published"}
            for index in range(101)
        ]
        course_cursor = self._collection("courses").find.return_value
        course_cursor.__iter__.return_value = courses

        response = self._request("get", "/api/courses")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["courses"]), 101)
        course_cursor.limit.assert_not_called()

    def test_student_course_payload_exposes_saved_manual_transcript_cues(self):
        cues = [
            {"startTimeMs": 0, "endTimeMs": 2000, "text": "Opening line."},
            {"startTimeMs": 2000, "endTimeMs": 4000, "text": "Second line."},
        ]
        course = {
            "_id": ObjectId(),
            "title": "Course with manual transcript",
            "status": "published",
            "modules": [{
                "contentItems": [
                    {
                        "_id": "lesson-1",
                        "type": "video-lesson",
                        "transcriptSource": "manual",
                        "transcriptFormat": "srt",
                        "transcriptCues": cues,
                    },
                    {
                        "_id": "lesson-2",
                        "type": "video-lesson",
                        "transcriptSource": "manual",
                        "transcriptFormat": "text",
                        "transcriptText": "Plain transcript, first line.\nSecond line.",
                        "transcriptCues": [],
                    },
                ],
            }],
        }
        cursor = self._collection("courses").find.return_value
        cursor.__iter__.return_value = [course]

        response = self._request("get", "/api/courses/")

        self.assertEqual(response.status_code, 200)
        student_lessons = response.json()["courses"][0]["modules"][0]["contentItems"]
        self.assertEqual(student_lessons[0]["transcriptSource"], "manual")
        self.assertEqual(student_lessons[0]["transcriptCues"], cues)
        self.assertEqual(student_lessons[1]["transcriptText"], "Plain transcript, first line.\nSecond line.")
        self.assertEqual(student_lessons[1]["transcriptCues"], [])

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

    def test_completed_course_automatically_issues_certificate_with_template_snapshot(self):
        course_id = ObjectId()
        lesson_id = ObjectId()
        course = {
            "_id": course_id,
            "title": "Certificate course",
            "generateCertificate": True,
            "modules": [{"lessons": [{"_id": lesson_id, "title": "Final lesson"}]}],
        }
        enrollment = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "status": "completed",
            "courseProgress": 100,
            "completedLessonIds": [str(lesson_id)],
            "updatedAt": datetime(2026, 11, 27, tzinfo=timezone.utc),
        }
        template = {
            "_id": "active",
            "secureUrl": "https://res.cloudinary.com/test/image/upload/background-v1.png",
            "publicId": "aihustle-lms/certificate_template/admin/v1",
            "resourceType": "image",
            "format": "png",
            "originalName": "background-v1.png",
            "bytes": 128,
            "version": 1,
        }
        self._collection("courses").find_one.return_value = course
        self._collection("enrollments").find.return_value.limit.return_value = [enrollment]
        self._collection("certificate_templates").find_one.return_value = template

        response = self._request("get", "/api/certificates")

        self.assertEqual(response.status_code, 200)
        certificate = response.json()["certificates"][0]["certificate"]
        self.assertEqual(certificate["studentName"], "External Learner")
        self.assertEqual(certificate["courseName"], "Certificate course")
        self.assertTrue(certificate["certificateId"].startswith("AH-"))
        self.assertNotIn("templateSnapshot", certificate)
        saved = self._collection("certificates").insert_one.call_args.args[0]
        self.assertEqual(saved["templateSnapshot"]["secureUrl"], template["secureUrl"])
        self.assertEqual(saved["templateSnapshot"]["version"], 1)
        self.assertEqual(saved["renderVersion"], 1)
        self.assertEqual(saved["completedAt"], enrollment["updatedAt"])

        replacement = {
            **template,
            "secureUrl": "https://res.cloudinary.com/test/image/upload/background-v2.png",
            "version": 2,
        }
        self._collection("certificate_templates").find_one.return_value = replacement
        self._collection("certificates").find.return_value.limit.return_value = [saved]
        second_response = self._request("get", "/api/certificates")

        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(self._collection("certificates").insert_one.call_count, 1)
        self.assertEqual(saved["templateSnapshot"]["secureUrl"], template["secureUrl"])

    def test_generated_certificate_pdf_uses_its_saved_template_snapshot(self):
        certificate = {
            "_id": "course-completion-test",
            "certificateId": "AH-CERT123",
            "studentName": "External Learner",
            "courseName": "Certificate course",
            "completedAt": datetime(2026, 11, 28, tzinfo=timezone.utc),
            "renderVersion": 1,
            "templateSnapshot": {
                "secureUrl": "https://res.cloudinary.com/test/image/upload/background-v1.png",
            },
        }
        self._collection("certificates").find_one.return_value = certificate
        background = Image.new("RGB", (4, 3), "white")
        with patch("student_api.certificate_generation._download_template", return_value=background):
            response = self._request("get", "/api/certificates/AH-CERT123/pdf")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/pdf")
        self.assertIn(b"%PDF-", response.content[:10])
        self.assertIn("inline", response["Content-Disposition"])

    def test_quiz_start_assigns_saved_question_ids_and_configured_timer(self):
        course_id, quiz_id = ObjectId(), ObjectId()
        enrollment = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
        }
        questions = [
            {
                "prompt": f"Question {index + 1}",
                "options": ["A", "B", "C", "D"],
                "correctOptionIndices": [index % 4],
            }
            for index in range(5)
        ]
        course = {
            "_id": course_id,
            "quizzes": [{
                "_id": quiz_id,
                "passingPercentage": 70,
                "timeLimitMinutes": 12,
                "questions": questions,
            }],
        }
        self._collection("enrollments").find_one.return_value = enrollment
        self._collection("courses").find_one.return_value = course
        attempts = self._collection("quiz_attempts")
        attempts.insert_one.return_value.inserted_id = ObjectId()
        attempts.find.return_value.sort.return_value.limit.side_effect = lambda _limit: (
            [dict(attempts.insert_one.call_args.args[0])]
            if attempts.insert_one.called
            else []
        )

        response = self._request(
            "post",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/start",
            {"enrollmentId": str(enrollment["_id"])},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        saved_attempt = attempts.insert_one.call_args.args[0]
        saved_ids = [question["_id"] for question in saved_attempt["questions"]]
        self.assertTrue(all(isinstance(question_id, ObjectId) for question_id in saved_ids))
        self.assertEqual(len(set(saved_ids)), 5)
        self.assertEqual(
            [question["_id"] for question in response.json()["questions"]],
            [str(question_id) for question_id in saved_ids],
        )
        self.assertEqual(saved_attempt["timeLimitMinutes"], 12)
        self.assertEqual(response.json()["attempt"]["timeLimitMinutes"], 12)

    def test_quiz_policy_counts_only_completed_attempts_and_resets_after_24_hours(self):
        from student_api.views import (
            QUIZ_ATTEMPT_LOCK_DURATION,
            _quiz_attempt_policy,
            _quiz_policy_key,
            _record_completed_quiz_attempt,
            _quiz_status,
        )

        course_id, quiz_id = ObjectId(), ObjectId()
        user = SimpleNamespace(id=str(self.user_id))
        now = datetime.now(timezone.utc)
        policy_id = _quiz_policy_key(user, course_id, quiz_id)
        policies = self._collection("quiz_attempt_policies")
        policies._documents[policy_id] = {
            "_id": policy_id,
            "studentId": user.id,
            "courseId": str(course_id),
            "quizId": str(quiz_id),
            "cycleId": "attempt-cycle",
            "completedAttempts": 0,
            "completedAttemptIds": [],
            "lockedUntil": None,
            "activeAttemptId": None,
        }

        with patch("student_api.views.collection", side_effect=self._collection):
            completed = []
            for index in range(3):
                attempt = {"_id": ObjectId(), "status": "submitted"}
                completed.append(attempt)
                policy = _record_completed_quiz_attempt(
                    user,
                    course_id,
                    quiz_id,
                    attempt,
                    now + timedelta(minutes=index),
                )
                self.assertEqual(policy["completedAttempts"], index + 1)

            expected_lock = now + timedelta(minutes=2) + QUIZ_ATTEMPT_LOCK_DURATION
            self.assertEqual(policy["lockedUntil"], expected_lock)
            duplicate = _record_completed_quiz_attempt(
                user,
                course_id,
                quiz_id,
                completed[-1],
                now + timedelta(minutes=3),
            )
            self.assertEqual(duplicate["completedAttempts"], 3)

            status_data, _ = _quiz_status(user, course_id, quiz_id, {"passingPercentage": 70})
            self.assertEqual(status_data["attemptsUsed"], 3)
            self.assertEqual(status_data["attemptsRemaining"], 0)
            self.assertEqual(status_data["lockedUntil"], expected_lock)

            self._collection("courses").find_one.return_value = {
                "_id": course_id,
                "quizzes": [{
                    "_id": quiz_id,
                    "passingPercentage": 70,
                    "questions": [{
                        "_id": ObjectId(),
                        "options": ["A", "B"],
                        "correctOptionIndices": [0],
                    }],
                }],
            }
            self._collection("enrollments").find_one.return_value = {
                "_id": ObjectId(),
                "studentId": user.id,
                "courseId": str(course_id),
            }
            locked_start = self._request(
                "post",
                f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/start",
                {},
                format="json",
            )
            self.assertEqual(locked_start.status_code, 423)
            self._collection("quiz_attempts").insert_one.assert_not_called()

            expired = _quiz_attempt_policy(
                user,
                course_id,
                quiz_id,
                attempts=[],
                now=expected_lock + timedelta(seconds=1),
            )
            self.assertEqual(expired["completedAttempts"], 0)
            self.assertIsNone(expired["lockedUntil"])
            self.assertNotEqual(expired["cycleId"], "attempt-cycle")
            reset_start = self._request(
                "post",
                f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/start",
                {},
                format="json",
            )
            self.assertEqual(reset_start.status_code, 201)

            another_user = SimpleNamespace(id=str(ObjectId()))
            another_policy = _quiz_attempt_policy(
                another_user,
                course_id,
                quiz_id,
                attempts=[],
                now=now,
            )
            self.assertEqual(another_policy["completedAttempts"], 0)
            self.assertNotEqual(another_policy["_id"], policy_id)

    def test_another_hustler_cannot_submit_an_owned_attempt(self):
        course_id, quiz_id, attempt_id = ObjectId(), ObjectId(), ObjectId()
        other_user_id = ObjectId()
        other_user = {
            **self.user_document,
            "_id": other_user_id,
            "email": "another-learner@example.com",
            "accountType": "hustler",
        }
        token = jwt.encode(
            {"sub": str(other_user_id), "role": "student", "type": "access"},
            settings.SECRET_KEY,
            algorithm="HS256",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
        self.auth_users.find_one.return_value = other_user
        self._collection("courses").find_one.return_value = {
            "_id": course_id,
            "quizzes": [{"_id": quiz_id, "passingPercentage": 70, "questions": []}],
        }
        self._collection("enrollments").find_one.return_value = {
            "_id": ObjectId(),
            "studentId": str(other_user_id),
            "courseId": str(course_id),
        }
        attempts = self._collection("quiz_attempts")
        attempts.find_one.return_value = None

        response = self._request(
            "post",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/{attempt_id}/submit",
            {"answers": []},
            format="json",
        )

        self.assertEqual(response.status_code, 404)
        attempt_query = attempts.find_one.call_args.args[0]
        student_filter = attempt_query["$and"][0]["$or"]
        self.assertTrue(any(item.get("studentId") == str(other_user_id) for item in student_filter))

    def test_five_question_quiz_saves_independently_and_grades_admin_marks(self):
        course_id, quiz_id = ObjectId(), ObjectId()
        enrollment = {"_id": ObjectId(), "studentId": str(self.user_id), "courseId": str(course_id)}
        correct_indices = [0, 1, 2, 3, 3]
        marks = [1, 2, 3, 4, 5]
        course = {
            "_id": course_id,
            "quizzes": [{
                "_id": quiz_id,
                "passingPercentage": 70,
                "questions": [{
                    "prompt": f"Question {index + 1}",
                    "type": "multiple-choice",
                    "options": ["A", "B", "C", "D"],
                    "correctOptionIndices": [correct_indices[index]],
                    "marks": marks[index],
                } for index in range(5)],
            }],
        }
        self._collection("enrollments").find_one.return_value = enrollment
        self._collection("courses").find_one.return_value = course
        attempts = self._collection("quiz_attempts")
        attempt_state = {}
        attempts.find.return_value.sort.return_value.limit.side_effect = lambda _limit: (
            [dict(attempt_state["attempt"])] if attempt_state.get("attempt") else []
        )

        def insert_attempt(document):
            attempt_state["attempt"] = dict(document)
            return SimpleNamespace(inserted_id=document["_id"])

        attempts.insert_one.side_effect = insert_attempt
        attempts.find_one.side_effect = lambda _query: dict(attempt_state["attempt"])

        def update_attempt(_query, update, **_kwargs):
            current = dict(attempt_state["attempt"])
            if "$push" in update:
                current["answers"] = [
                    *current.get("answers", []),
                    update["$push"]["answers"],
                ]
            if "$set" in update:
                current.update(update["$set"])
            attempt_state["attempt"] = current
            return dict(current)

        attempts.find_one_and_update.side_effect = update_attempt

        start = self._request(
            "post",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/start",
            {"enrollmentId": str(enrollment["_id"])},
            format="json",
        )
        self.assertEqual(start.status_code, 201)
        questions = start.json()["questions"]
        self.assertEqual(len({question["_id"] for question in questions}), 5)
        self.assertTrue(all("correctOptionIndices" not in question for question in questions))
        selections = [0, 1, 2, 3, 0]
        policy_id = f"{self.user_id}:{course_id}:{quiz_id}"

        for question, selected_index in zip(questions, selections):
            saved = self._request(
                "patch",
                f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/{start.json()['attempt']['_id']}/answers",
                {"questionId": question["_id"], "selectedOptionIndices": [selected_index]},
                format="json",
            )
            self.assertEqual(saved.status_code, 200)
            self.assertEqual(saved.json()["attempt"]["status"], "started")
            self.assertNotIn("scorePercentage", saved.json()["attempt"])
            self.assertEqual(
                self._collection("quiz_attempt_policies")._documents[policy_id]["completedAttempts"],
                0,
            )

        saved_answers = attempt_state["attempt"]["answers"]
        self.assertEqual(len(saved_answers), 5)
        self.assertEqual(len({answer["questionId"] for answer in saved_answers}), 5)
        self.assertEqual(
            [answer["selectedOptionIndices"] for answer in saved_answers],
            [[0], [1], [2], [3], [0]],
        )

        submission = self._request(
            "post",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/{start.json()['attempt']['_id']}/submit",
            {"answers": [
                {"questionId": question["_id"], "selectedOptionIndices": [selected_index]}
                for question, selected_index in zip(questions, selections)
            ]},
            format="json",
        )
        self.assertEqual(submission.status_code, 200)
        result = submission.json()["attempt"]
        self.assertEqual(result["earnedPoints"], 10)
        self.assertEqual(result["totalPoints"], 15)
        self.assertEqual(result["scorePercentage"], 66.67)
        self.assertEqual(result["correctAnswers"], 4)
        self.assertEqual(result["incorrectAnswers"], 1)
        self.assertFalse(result["passed"])
        self.assertEqual(result["passingPercentage"], 70)
        self.assertEqual(
            self._collection("quiz_attempt_policies")._documents[policy_id]["completedAttempts"],
            1,
        )

    def test_quiz_answer_is_saved_to_its_question_without_duplicates(self):
        course_id, quiz_id, attempt_id, question_id = (ObjectId() for _ in range(4))
        enrollment = {"_id": ObjectId(), "studentId": str(self.user_id), "courseId": str(course_id)}
        course = {
            "_id": course_id,
            "quizzes": [{"_id": quiz_id, "passingPercentage": 70, "questions": [{
                "_id": question_id,
                "type": "multiple-choice",
                "options": ["A", "B", "C", "D"],
                "correctOptionIndices": [1],
            }]}],
        }
        attempt = {
            "_id": attempt_id,
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "quizId": str(quiz_id),
            "status": "started",
            "policyCycleId": "active-cycle",
            "questions": course["quizzes"][0]["questions"],
            "answers": [],
        }
        updated_attempt = {
            **attempt,
            "answers": [{"questionId": str(question_id), "selectedOptionIndices": [2]}],
        }
        self._collection("enrollments").find_one.return_value = enrollment
        self._collection("courses").find_one.return_value = course
        attempts = self._collection("quiz_attempts")
        attempts.find_one.return_value = attempt
        attempts.find.return_value.sort.return_value.limit.return_value = [attempt]
        attempts.find_one_and_update.return_value = updated_attempt
        policy_id = f"{self.user_id}:{course_id}:{quiz_id}"
        self._collection("quiz_attempt_policies")._documents[policy_id] = {
            "_id": policy_id,
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "quizId": str(quiz_id),
            "cycleId": "active-cycle",
            "completedAttempts": 0,
            "completedAttemptIds": [],
            "lockedUntil": None,
            "activeAttemptId": str(attempt_id),
        }

        response = self._request(
            "patch",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/{attempt_id}/answers",
            {"questionId": str(question_id), "selectedOptionIndices": [2]},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["answer"], {
            "questionId": str(question_id),
            "selectedOptionIndices": [2],
        })
        update = attempts.find_one_and_update.call_args.args[1]
        self.assertEqual(update["$push"]["answers"]["questionId"], str(question_id))
        self.assertEqual(update["$push"]["answers"]["selectedOptionIndices"], [2])
        self.assertNotIn("$addToSet", update)

        attempts.find_one.return_value = updated_attempt
        attempts.find_one_and_update.return_value = {
            **attempt,
            "answers": [{"questionId": str(question_id), "selectedOptionIndices": [3]}],
        }
        changed_response = self._request(
            "patch",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/{attempt_id}/answers",
            {"questionId": str(question_id), "selectedOptionIndices": [3]},
            format="json",
        )
        self.assertEqual(changed_response.status_code, 200)
        update_existing = attempts.find_one_and_update.call_args.args[1]
        self.assertEqual(update_existing["$set"]["answers.$.selectedOptionIndices"], [3])
        self.assertNotIn("$push", update_existing)

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
                "passingPercentage": 100,
                "questions": [{
                    "_id": question_id,
                    "prompt": "Choose the right answer",
                    "options": ["Wrong", "Right"],
                    "correctOptionIndex": 1,
                    "marks": 2,
                }],
            }],
        }
        self._collection("enrollments").find_one.return_value = enrollment
        self._collection("courses").find_one.return_value = course
        attempts = self._collection("quiz_attempts")
        attempt_state = {}
        attempts.find.return_value.sort.return_value.limit.side_effect = lambda _limit: (
            [dict(attempt_state["attempt"])] if attempt_state.get("attempt") else []
        )

        def insert_attempt(document):
            attempt_state["attempt"] = dict(document)
            return SimpleNamespace(inserted_id=document["_id"])

        attempts.insert_one.side_effect = insert_attempt

        start = self._request(
            "post",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/start",
            {"enrollmentId": str(enrollment["_id"])},
            format="json",
        )

        self.assertEqual(start.status_code, 201)
        self.assertNotIn("correctOptionIndices", start.json()["questions"][0])

        saved_attempt = dict(attempt_state["attempt"])
        attempt_id = saved_attempt["_id"]
        question_id = saved_attempt["questions"][0]["_id"]
        answer_saved_attempt = {
            **saved_attempt,
            "answers": [{
                "questionId": str(question_id),
                "selectedOptionIndices": [1],
            }],
        }
        updated_attempt = {
            **answer_saved_attempt,
            "status": "submitted",
            "answers": [{
                "questionId": str(question_id),
                "selectedOptionIndices": [1],
                "correctOptionIndices": [1],
            }],
            "earnedPoints": 2,
            "totalPoints": 2,
            "scorePercentage": 100,
            "correctAnswers": 1,
            "incorrectAnswers": 0,
            "passed": True,
        }
        attempt_state["attempt"] = saved_attempt
        attempts.find_one.return_value = saved_attempt

        def update_attempt(_query, update, **_kwargs):
            if update["$set"].get("status") == "submitted":
                attempt_state["attempt"] = updated_attempt
                return updated_attempt
            attempt_state["attempt"] = answer_saved_attempt
            return answer_saved_attempt

        attempts.find_one_and_update.side_effect = update_attempt

        duplicate_submission_update_count = attempts.find_one_and_update.call_count

        duplicate_submission = self._request(
            "post",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/{attempt_id}/submit",
            {
                "answers": [
                    {"questionId": str(question_id), "selectedOptionIndices": [1]},
                    {"questionId": str(question_id), "selectedOptionIndices": [0]},
                ],
            },
            format="json",
        )
        self.assertEqual(duplicate_submission.status_code, 400)
        self.assertEqual(attempts.find_one_and_update.call_count, duplicate_submission_update_count)

        unsaved_submission = self._request(
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
        self.assertEqual(unsaved_submission.status_code, 409)
        self.assertEqual(attempts.find_one_and_update.call_count, duplicate_submission_update_count)

        answer_save = self._request(
            "patch",
            f"/api/courses/{course_id}/quizzes/{quiz_id}/attempts/{attempt_id}/answers",
            {"questionId": str(question_id), "selectedOptionIndices": [1]},
            format="json",
        )
        self.assertEqual(answer_save.status_code, 200)
        attempts.find_one.return_value = answer_saved_attempt

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
        self.assertEqual(submission.json()["attempt"]["earnedPoints"], 2)
        self.assertEqual(submission.json()["attempt"]["totalPoints"], 2)
        self.assertEqual(submission.json()["attempt"]["scorePercentage"], 100)
        self.assertTrue(submission.json()["attempt"]["passed"])
        policy_id = f"{self.user_id}:{course_id}:{quiz_id}"
        self.assertEqual(
            self._collection("quiz_attempt_policies")._documents[policy_id]["completedAttempts"],
            1,
        )

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
                self.assertIn(response.status_code, {200, 400, 404, 405, 410})

    def test_student_can_create_an_enrollment_for_a_published_course(self):
        course_id = ObjectId()
        course = {
            "_id": course_id,
            "title": "Published course",
            "status": "published",
            "published": False,
            "isPublished": False,
            "is_published": False,
        }
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

    def test_assignment_pdf_flow_saves_missing_item_id_and_submission_metadata(self):
        course_id = ObjectId()
        course = {
            "_id": course_id,
            "modules": [{
                "contentItems": [{
                    "type": "assignment",
                    "title": "Assignment",
                }],
            }],
        }
        courses = self._collection("courses")
        courses.find_one.return_value = course

        def persist_course_update(_query, update, **_kwargs):
            course.update(update["$set"])
            return dict(course)

        courses.find_one_and_update.side_effect = persist_course_update
        enrollment_id = ObjectId()
        self._collection("enrollments").find_one.return_value = {
            "_id": enrollment_id,
            "studentId": str(self.user_id),
            "courseId": str(course_id),
        }
        submissions = self._collection("submissions")
        content_response = self._request(
            "get",
            f"/api/courses/{course_id}/learning-content",
        )
        self.assertEqual(content_response.status_code, 200)
        assignment_id = content_response.json()["course"]["modules"][0]["contentItems"][0]["_id"]
        self.assertEqual(course["modules"][0]["contentItems"][0]["_id"], ObjectId(assignment_id))
        submission_request_id = ObjectId()
        submissions.insert_one.return_value.inserted_id = submission_request_id
        pdf_bytes = _minimal_pdf_bytes()
        pdf = SimpleUploadedFile(
            "answer.pdf",
            pdf_bytes,
            content_type="application/pdf",
        )
        cloudinary_result = {
            "secure_url": "https://res.cloudinary.com/test-cloud/raw/upload/submission.pdf",
            "public_id": "aihustle-lms/assignment_submission/asset",
            "resource_type": "raw",
            "format": "pdf",
            "bytes": len(pdf_bytes),
        }

        with (
            patch("core.cloudinary_storage.configure_cloudinary"),
            patch("core.cloudinary_storage.uploader.upload", return_value=cloudinary_result) as upload,
        ):
            response = self._request(
                "post",
                f"/api/courses/{course_id}/assignments/{assignment_id}/submissions",
                {"file": pdf, "submissionRequestId": str(submission_request_id)},
                format="multipart",
            )

        self.assertEqual(response.status_code, 201)
        document = submissions.insert_one.call_args.args[0]
        self.assertEqual(document["fileUrl"], cloudinary_result["secure_url"])
        self.assertEqual(document["filePublicId"], cloudinary_result["public_id"])
        self.assertEqual(document["_id"], submission_request_id)
        self.assertEqual(document["status"], "submitted")
        self.assertEqual(document["attemptNumber"], 1)
        self.assertEqual(
            document["deadlineAt"],
            enrollment_id.generation_time + timedelta(days=15),
        )
        self.assertTrue(response.json()["submission"]["attemptState"]["hasPendingGrading"])
        policy_id = f"{self.user_id}:{course_id}:{assignment_id}"
        policy = self._collection("assignment_attempt_policies")._documents[policy_id]
        self.assertEqual(policy["attemptsUsed"], 0)
        self.assertEqual(policy["activeSubmissionId"], str(submission_request_id))
        self.assertNotIn("fileId", document)
        self.assertNotIn("fileContent", document)
        upload.assert_called_once()
        options = upload.call_args.kwargs
        self.assertEqual(options["resource_type"], "raw")
        self.assertTrue(options["folder"].endswith(f"{course_id}/{self.user_id}"))
        self.assertEqual(upload.call_args.args[0].name, "answer.pdf")
        self.assertTrue(pdf_bytes.startswith(b"%PDF-1.4"))

    def test_student_course_content_exposes_admin_review_result(self):
        course_id = ObjectId()
        assignment_id = ObjectId()
        submission_id = ObjectId()
        course = {
            "_id": course_id,
            "title": "Python Fundamentals",
            "modules": [{
                "contentItems": [{
                    "_id": assignment_id,
                    "type": "assignment",
                    "title": "Build a calculator",
                    "points": 100,
                }],
            }],
        }
        self._collection("courses").find_one.return_value = course
        self._collection("enrollments").find_one.return_value = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
        }
        reviewed_submission = {
            "_id": submission_id,
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "assignmentId": str(assignment_id),
            "status": "approved",
            "reviewStatus": "approved",
            "gradingStatus": "Admin Reviewed",
            "finalMarks": 87,
            "maximumMarks": 100,
            "reviewComment": "Clear and correct solution.",
        }
        self._collection("submissions").find.return_value.limit.return_value = [
            reviewed_submission
        ]

        response = self._request(
            "get",
            f"/api/courses/{course_id}/learning-content",
        )

        self.assertEqual(response.status_code, 200)
        student_result = response.json()["assignmentSubmissions"][0]
        self.assertEqual(student_result["reviewStatus"], "approved")
        self.assertEqual(student_result["finalMarks"], 87)
        self.assertEqual(student_result["reviewComment"], "Clear and correct solution.")

    def test_assignment_submission_is_blocked_after_the_enrollment_deadline(self):
        course_id, assignment_id = ObjectId(), ObjectId()
        enrollment = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "createdAt": datetime.now(timezone.utc) - timedelta(days=16),
        }
        self._collection("courses").find_one.return_value = {
            "_id": course_id,
            "assignments": [{"_id": assignment_id, "title": "Assignment"}],
        }
        self._collection("enrollments").find_one.return_value = enrollment

        with patch("student_api.views.upload_media") as upload:
            response = self._request(
                "post",
                f"/api/courses/{course_id}/assignments/{assignment_id}/submissions",
                {"file": SimpleUploadedFile("answer.pdf", b"%PDF-1.4 content", "application/pdf")},
                format="multipart",
            )

        self.assertEqual(response.status_code, 410)
        self.assertIn("15-day assignment deadline", response.json()["message"])
        upload.assert_not_called()

    def test_assignment_submission_is_blocked_while_an_admin_review_is_pending(self):
        course_id, assignment_id, pending_id = ObjectId(), ObjectId(), ObjectId()
        now = datetime.now(timezone.utc)
        enrollment = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "createdAt": now - timedelta(days=1),
        }
        self._collection("courses").find_one.return_value = {
            "_id": course_id,
            "assignments": [{"_id": assignment_id, "title": "Assignment"}],
        }
        self._collection("enrollments").find_one.return_value = enrollment
        policy_id = f"{self.user_id}:{course_id}:{assignment_id}"
        self._collection("assignment_attempt_policies")._documents[policy_id] = {
            "_id": policy_id,
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "assignmentId": str(assignment_id),
            "enrollmentAt": enrollment["createdAt"],
            "deadlineAt": enrollment["createdAt"] + timedelta(days=15),
            "cycleNumber": 1,
            "attemptsUsed": 0,
            "failedAttempts": 0,
            "hasPassed": False,
            "lockoutUntil": None,
            "activeSubmissionId": str(pending_id),
        }

        with patch("student_api.views.upload_media") as upload:
            response = self._request(
                "post",
                f"/api/courses/{course_id}/assignments/{assignment_id}/submissions",
                {"file": SimpleUploadedFile("answer.pdf", b"%PDF-1.4 content", "application/pdf")},
                format="multipart",
            )

        self.assertEqual(response.status_code, 409)
        self.assertIn("waiting for Admin review", response.json()["message"])
        upload.assert_not_called()

    def test_expired_cooldown_resets_attempt_cycle_before_the_enrollment_deadline(self):
        course_id, assignment_id = ObjectId(), ObjectId()
        now = datetime.now(timezone.utc)
        enrollment = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "createdAt": now - timedelta(days=2),
        }
        self._collection("courses").find_one.return_value = {
            "_id": course_id,
            "assignments": [{"_id": assignment_id, "title": "Assignment"}],
        }
        self._collection("enrollments").find_one.return_value = enrollment
        policy_id = f"{self.user_id}:{course_id}:{assignment_id}"
        self._collection("assignment_attempt_policies")._documents[policy_id] = {
            "_id": policy_id,
            "studentId": str(self.user_id),
            "courseId": str(course_id),
            "assignmentId": str(assignment_id),
            "enrollmentAt": enrollment["createdAt"],
            "deadlineAt": enrollment["createdAt"] + timedelta(days=15),
            "cycleNumber": 1,
            "attemptsUsed": 3,
            "failedAttempts": 3,
            "hasPassed": False,
            "lockoutUntil": now - timedelta(seconds=1),
            "activeSubmissionId": None,
        }
        metadata = {
            "secureUrl": "https://res.cloudinary.com/test-cloud/raw/upload/answer.pdf",
            "publicId": "aihustle-lms/assignment_submission/answer",
            "resourceType": "raw",
            "format": "pdf",
            "bytes": 12,
            "originalName": "answer.pdf",
        }

        with patch("student_api.views.upload_media", return_value=metadata):
            response = self._request(
                "post",
                f"/api/courses/{course_id}/assignments/{assignment_id}/submissions",
                {"file": SimpleUploadedFile("answer.pdf", b"%PDF-1.4 content", "application/pdf")},
                format="multipart",
            )

        self.assertEqual(response.status_code, 201)
        submission = self._collection("submissions").insert_one.call_args.args[0]
        self.assertEqual(submission["attemptNumber"], 1)
        self.assertEqual(submission["attemptCycle"], 2)
        policy = self._collection("assignment_attempt_policies")._documents[policy_id]
        self.assertEqual(policy["attemptsUsed"], 0)
        self.assertEqual(policy["failedAttempts"], 0)
        self.assertEqual(policy["cycleNumber"], 2)
        self.assertEqual(policy["activeSubmissionId"], str(submission["_id"]))

    def test_ai_human_reevaluation_request_is_disabled(self):
        response = self._request(
            "post",
            f"/api/assignment-submissions/{ObjectId()}/human-review-requests",
            {"reasons": ["AI misunderstood the answer."]},
            format="json",
        )

        self.assertEqual(response.status_code, 410)
        self.assertIn("reviewed manually", response.json()["message"])
        self.assertNotIn("submissions", self.collections)

    def test_assignment_submission_retry_returns_existing_record(self):
        course_id = ObjectId()
        assignment_id = ObjectId()
        request_id = ObjectId()
        self._collection("courses").find_one.return_value = {
            "_id": course_id,
            "modules": [{
                "contentItems": [{
                    "_id": assignment_id,
                    "type": "assignment",
                    "title": "Assignment",
                }],
            }],
        }
        self._collection("enrollments").find_one.return_value = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
        }
        submissions = self._collection("submissions")
        stored_submission = {}

        def insert_once(document):
            if stored_submission:
                raise DuplicateKeyError("submission request already saved")
            stored_submission.update(document)
            return SimpleNamespace(inserted_id=document["_id"])

        submissions.insert_one.side_effect = insert_once
        submissions.find_one.side_effect = lambda _query: dict(stored_submission) or None
        first_upload = {
            "secureUrl": "https://res.cloudinary.com/test-cloud/raw/upload/first.pdf",
            "publicId": "aihustle-lms/assignment_submission/first",
            "resourceType": "raw",
            "format": "pdf",
            "bytes": 12,
            "originalName": "answer.pdf",
        }
        retry_upload = {
            **first_upload,
            "secureUrl": "https://res.cloudinary.com/test-cloud/raw/upload/retry.pdf",
            "publicId": "aihustle-lms/assignment_submission/retry",
        }
        pdf_content = b"%PDF-1.4 test document"

        with (
            patch("student_api.views.upload_media", side_effect=[first_upload, retry_upload]) as upload,
            patch("student_api.views.delete_media") as delete_media,
        ):
            first_response = self._request(
                "post",
                f"/api/courses/{course_id}/assignments/{assignment_id}/submissions",
                {
                    "file": SimpleUploadedFile("answer.pdf", pdf_content, "application/pdf"),
                    "submissionRequestId": str(request_id),
                },
                format="multipart",
            )
            retry_response = self._request(
                "post",
                f"/api/courses/{course_id}/assignments/{assignment_id}/submissions",
                {
                    "file": SimpleUploadedFile("answer.pdf", pdf_content, "application/pdf"),
                    "submissionRequestId": str(request_id),
                },
                format="multipart",
            )

        self.assertEqual(first_response.status_code, 201)
        self.assertEqual(retry_response.status_code, 200)
        self.assertEqual(retry_response.json()["submission"]["_id"], str(request_id))
        self.assertEqual(submissions.insert_one.call_count, 1)
        self.assertEqual(stored_submission["_id"], request_id)
        upload.assert_called_once()
        delete_media.assert_not_called()

    def test_assignment_database_failure_returns_json_error_and_cleans_upload(self):
        course_id = ObjectId()
        assignment_id = ObjectId()
        self._collection("courses").find_one.return_value = {
            "_id": course_id,
            "assignments": [{"_id": assignment_id, "title": "Assignment"}],
        }
        self._collection("enrollments").find_one.return_value = {
            "_id": ObjectId(),
            "studentId": str(self.user_id),
            "courseId": str(course_id),
        }
        self._collection("submissions").insert_one.side_effect = PyMongoError("database unavailable")
        metadata = {
            "secureUrl": "https://res.cloudinary.com/test-cloud/raw/upload/answer.pdf",
            "publicId": "aihustle-lms/assignment_submission/answer",
            "resourceType": "raw",
            "format": "pdf",
            "bytes": 12,
            "originalName": "answer.pdf",
        }

        with (
            patch("student_api.views.upload_media", return_value=metadata),
            patch("student_api.views.delete_media") as delete_media,
        ):
            response = self._request(
                "post",
                f"/api/courses/{course_id}/assignments/{assignment_id}/submissions",
                {"file": SimpleUploadedFile("answer.pdf", b"%PDF-1.4 content", "application/pdf")},
                format="multipart",
            )

        self.assertEqual(response.status_code, 503)
        self.assertIn("could not be saved", response.json()["message"])
        delete_media.assert_called_once_with(metadata["publicId"], "raw")

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
