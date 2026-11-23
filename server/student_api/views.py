import secrets
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from bson import ObjectId
from bson.errors import InvalidId
from django.http import FileResponse
from gridfs import GridFSBucket
from gridfs.errors import NoFile
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from rest_framework import status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from core.mongo import serialize_document
from core.mongodb import collection, get_database


def _id_value(value):
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, dict):
        return {key: _id_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_id_value(item) for item in value]
    return value


def _document(document):
    if document is None:
        return None
    result = _id_value(dict(document))
    if "_id" in result:
        result.setdefault("id", result["_id"])
    return result


def _remove_quiz_answers(value):
    sensitive_keys = {
        "correctOptionIndices",
        "correctAnswer",
        "correctAnswerIndex",
        "correctAnswers",
        "answerKey",
    }
    if isinstance(value, dict):
        return {
            key: _remove_quiz_answers(item)
            for key, item in value.items()
            if key not in sensitive_keys
        }
    if isinstance(value, list):
        return [_remove_quiz_answers(item) for item in value]
    return value


def _object_id(value):
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError):
        return None


def _user_query(user):
    values = [user.id]
    object_id = _object_id(user.id)
    if object_id is not None:
        values.append(object_id)
    return {
        "$or": [
            {field: value}
            for field in ("studentId", "student_id", "userId", "user_id")
            for value in values
        ]
    }


def _combine(*queries):
    return {"$and": list(queries)}


def _course_query(course_id):
    values = [str(course_id)]
    object_id = _object_id(course_id)
    if object_id is not None:
        values.append(object_id)
    return {
        "$or": [
            {field: value}
            for field in ("courseId", "course_id")
            for value in values
        ]
    }


def _course_document(course_id):
    object_id = _object_id(course_id)
    candidates = []
    if object_id is not None:
        candidates.append({"_id": object_id})
    candidates.append({"_id": str(course_id)})
    for query in candidates:
        course = collection("courses").find_one(query)
        if course is not None:
            return course
    return None


def _is_published(course):
    if course.get("published") is False or course.get("isPublished") is False:
        return False
    if course.get("is_published") is False:
        return False
    state = str(course.get("status", "")).strip().lower()
    return state not in {"draft", "unpublished", "inactive", "rejected", "archived"}


def _public_course(course):
    result = _remove_quiz_answers(_document(course))
    if result is None:
        return None
    result.setdefault("title", result.get("name", "Course"))
    result.setdefault("name", result["title"])
    return result


def _course_lessons(course):
    lessons = []
    seen = set()
    for module in course.get("modules", []) or []:
        if not isinstance(module, dict):
            continue
        candidates = []
        candidates.extend(module.get("lessons", []) or [])
        candidates.extend(module.get("videoLessons", []) or [])
        for item in module.get("contentItems", []) or []:
            if not isinstance(item, dict):
                continue
            if str(item.get("type", "")).lower() in {"video-lesson", "video_lesson", "lesson"}:
                candidates.append(item.get("lesson") or item)
        for lesson in candidates:
            if not isinstance(lesson, dict):
                continue
            key = str(lesson.get("_id") or id(lesson))
            if key not in seen:
                seen.add(key)
                lessons.append(lesson)
    return lessons


def _course_assignments(course_id, course=None):
    assignments = []
    if course:
        embedded = course.get("assignments", [])
        if isinstance(embedded, list):
            assignments.extend(item for item in embedded if isinstance(item, dict))
        for module in course.get("modules", []) or []:
            if not isinstance(module, dict):
                continue
            assignments.extend(
                item for item in module.get("assignments", []) or []
                if isinstance(item, dict)
            )
    query = _course_query(course_id)
    assignments.extend(
        list(collection("assignments").find(query).limit(200))
    )
    unique = {}
    for assignment in assignments:
        key = str(assignment.get("_id") or assignment.get("id") or assignment.get("title"))
        unique[key] = assignment
    return list(unique.values())


def _course_quizzes(course):
    quizzes = []
    quizzes.extend(item for item in course.get("quizzes", []) or [] if isinstance(item, dict))
    for module in course.get("modules", []) or []:
        if not isinstance(module, dict):
            continue
        if isinstance(module.get("quiz"), dict):
            quizzes.append(module["quiz"])
        for item in module.get("contentItems", []) or []:
            if isinstance(item, dict) and item.get("type") == "quiz":
                quizzes.append(item.get("quiz") or item)
    unique = {}
    for quiz in quizzes:
        key = str(quiz.get("_id") or quiz.get("id") or quiz.get("title"))
        unique[key] = quiz
    return list(unique.values())


def _quiz_attempts_for(user, course_id, quiz_id):
    query = _combine(
        _user_query(user),
        _course_query(course_id),
        {"$or": [{"quizId": str(quiz_id)}, {"quiz_id": str(quiz_id)}]},
    )
    return list(
        collection("quiz_attempts").find(query).sort("createdAt", -1).limit(100)
    )


def _student_submissions(user, course_id, course):
    assignment_ids = []
    for assignment in _course_assignments(course_id, course):
        assignment_id = assignment.get("_id") or assignment.get("id")
        if assignment_id:
            assignment_ids.append(str(assignment_id))
    if not assignment_ids:
        return []
    user_query = _user_query(user)
    assignment_query = {
        "$or": [
            {"assignmentId": {"$in": assignment_ids}},
            {"assignment_id": {"$in": assignment_ids}},
        ]
    }
    records = []
    for name in ("assignment_submissions", "submissions"):
        records.extend(
            list(collection(name).find(_combine(user_query, assignment_query)).limit(200))
        )
    unique = {}
    for record in records:
        unique[str(record.get("_id"))] = _document(record)
    return list(unique.values())


def _student_quiz_attempts(user, course_id):
    query = _combine(_user_query(user), _course_query(course_id))
    attempts = []
    for item in collection("quiz_attempts").find(query).sort("createdAt", -1).limit(200):
        record = _document(item)
        for question in record.get("questions", []) or []:
            if isinstance(question, dict):
                for key in ("correctOptionIndices", "correctAnswer", "correctAnswerIndex", "answer"):
                    question.pop(key, None)
        attempts.append(record)
    return attempts


def _enrollment_query(user, enrollment_id=None, course_id=None):
    filters = [_user_query(user)]
    if enrollment_id:
        object_id = _object_id(enrollment_id)
        if object_id is None:
            return None
        filters.append({"_id": object_id})
    if course_id:
        filters.append(_course_query(course_id))
    return _combine(*filters)


def _owned_enrollment(user, enrollment_id, course_id=None):
    query = _enrollment_query(user, enrollment_id=enrollment_id, course_id=course_id)
    if query is None:
        return None
    return collection("enrollments").find_one(query)


def _enrollment_course_id(enrollment):
    value = enrollment.get("courseId", enrollment.get("course_id"))
    if isinstance(value, dict):
        return value.get("_id") or value.get("id")
    return value


def _decorate_enrollment(user, enrollment):
    result = _document(enrollment)
    course_id = _enrollment_course_id(enrollment)
    course = _course_document(course_id) if course_id else None
    result["courseId"] = _public_course(course) if course else _id_value(
        enrollment.get("courseId", enrollment.get("course_id"))
    )
    result["assignmentSubmissions"] = _student_submissions(user, course_id, course) if course_id else []
    result["quizAttempts"] = _student_quiz_attempts(user, course_id) if course_id else []
    return result


def _active_user(request):
    if getattr(request.user, "role", None) != "student":
        return Response(
            {"message": "Student account access is required."},
            status=status.HTTP_403_FORBIDDEN,
        )
    return None


def _public_assignment(assignment):
    result = _document(assignment)
    result.setdefault("title", result.get("name", "Assignment"))
    result.setdefault("courseId", result.get("course_id"))
    return result


def _activity_date(value):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


class StudentAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        denied = _active_user(request)
        if denied:
            self.permission_denied(request, message=denied.data["message"])


class EnrollmentListCreateView(StudentAPIView):
    parser_classes = [JSONParser]

    def get(self, request):
        enrollments = collection("enrollments").find(_user_query(request.user)).sort(
            "createdAt", -1
        ).limit(200)
        return Response({
            "enrollments": [_decorate_enrollment(request.user, item) for item in enrollments]
        })

    def post(self, request):
        course_id = request.data.get("courseId")
        course = _course_document(course_id) if course_id else None
        if course is None or not _is_published(course):
            return Response(
                {"message": "This course is not available for enrollment."},
                status=status.HTTP_404_NOT_FOUND,
            )
        normalized_course_id = str(course["_id"])
        existing = collection("enrollments").find_one(
            _enrollment_query(request.user, course_id=normalized_course_id)
        )
        if existing:
            return Response({"enrollment": _decorate_enrollment(request.user, existing)})
        now = datetime.now(timezone.utc)
        document = {
            "studentId": request.user.id,
            "courseId": normalized_course_id,
            "status": "in-progress",
            "courseProgress": 0,
            "completedLessonIds": [],
            "startedLessonIds": [],
            "lessonPlaybackPositions": {},
            "lessonWatchedPositions": {},
            "createdAt": now,
            "updatedAt": now,
        }
        try:
            result = collection("enrollments").insert_one(document)
        except DuplicateKeyError:
            existing = collection("enrollments").find_one(
                _enrollment_query(request.user, course_id=normalized_course_id)
            )
            if existing is None:
                raise
            return Response({"enrollment": _decorate_enrollment(request.user, existing)})
        document["_id"] = result.inserted_id
        return Response(
            {"enrollment": _decorate_enrollment(request.user, document)},
            status=status.HTTP_201_CREATED,
        )


class EnrollmentProgressView(StudentAPIView):
    parser_classes = [JSONParser]

    def patch(self, request, enrollment_id):
        enrollment = _owned_enrollment(request.user, enrollment_id)
        if enrollment is None:
            return Response({"message": "Enrollment not found."}, status=status.HTTP_404_NOT_FOUND)
        lesson_id = str(request.data.get("lessonId", "")).strip()
        if not lesson_id:
            return Response({"message": "Lesson ID is required."}, status=status.HTTP_400_BAD_REQUEST)
        course_id = _enrollment_course_id(enrollment)
        course = _course_document(course_id)
        lesson_ids = {
            str(lesson.get("_id"))
            for lesson in _course_lessons(course or {})
            if lesson.get("_id")
        }
        if lesson_ids and lesson_id not in lesson_ids:
            return Response({"message": "Lesson does not belong to this course."}, status=status.HTTP_400_BAD_REQUEST)

        updates = {}
        position = request.data.get("positionSeconds")
        if position is not None:
            try:
                position = float(position)
            except (TypeError, ValueError):
                return Response({"message": "Playback position must be numeric."}, status=status.HTTP_400_BAD_REQUEST)
            if position < 0:
                return Response({"message": "Playback position cannot be negative."}, status=status.HTTP_400_BAD_REQUEST)
            updates[f"lessonPlaybackPositions.{lesson_id}"] = position
            watched = float(enrollment.get("lessonWatchedPositions", {}).get(lesson_id, 0) or 0)
            updates[f"lessonWatchedPositions.{lesson_id}"] = max(watched, position)
        if request.data.get("started") is True:
            updates["startedLessonIds"] = sorted(set(enrollment.get("startedLessonIds", [])) | {lesson_id})
        completed_ids = set(map(str, enrollment.get("completedLessonIds", [])))
        if request.data.get("completed") is True:
            try:
                duration = float(request.data.get("videoDurationSeconds", 0))
                completed_position = float(request.data.get("positionSeconds", 0))
            except (TypeError, ValueError):
                return Response({"message": "Video completion details are invalid."}, status=status.HTTP_400_BAD_REQUEST)
            if duration <= 0 or completed_position + 1 < duration:
                return Response({"message": "Watch the entire video before completing this lesson."}, status=status.HTTP_400_BAD_REQUEST)
            completed_ids.add(lesson_id)
            updates["completedLessonIds"] = sorted(completed_ids)
            updates["startedLessonIds"] = sorted(set(enrollment.get("startedLessonIds", [])) | {lesson_id})
        elif request.data.get("completed") is False:
            completed_ids.discard(lesson_id)
            updates["completedLessonIds"] = sorted(completed_ids)
        lessons = _course_lessons(course or {})
        total_lessons = len(lessons)
        completed_count = len(completed_ids)
        progress = round(completed_count * 100 / total_lessons) if total_lessons else 0
        updates["courseProgress"] = progress
        updates["status"] = "completed" if total_lessons and progress >= 100 else "in-progress"
        updates["updatedAt"] = datetime.now(timezone.utc)
        updated = collection("enrollments").find_one_and_update(
            {"_id": enrollment["_id"], **_user_query(request.user)},
            {"$set": updates},
            return_document=ReturnDocument.AFTER,
        )
        updated = updated or {**enrollment, **updates}
        return Response({
            "maxPositionSeconds": updates.get(
                f"lessonWatchedPositions.{lesson_id}",
                enrollment.get("lessonWatchedPositions", {}).get(lesson_id, 0),
            ),
            "lessonPlaybackPositions": updated.get("lessonPlaybackPositions", {}),
            "lessonWatchedPositions": updated.get("lessonWatchedPositions", {}),
            "completedLessonIds": updated.get("completedLessonIds", []),
            "status": updated.get("status", "in-progress"),
            "courseProgress": updated.get("courseProgress", 0),
        })


class EnrollmentLearningActivityView(StudentAPIView):
    parser_classes = [JSONParser]

    def post(self, request, enrollment_id):
        enrollment = _owned_enrollment(request.user, enrollment_id)
        if enrollment is None:
            return Response({"message": "Enrollment not found."}, status=status.HTTP_404_NOT_FOUND)
        lesson_id = str(request.data.get("lessonId", "")).strip()
        try:
            seconds = int(request.data.get("seconds"))
        except (TypeError, ValueError):
            seconds = 0
        activity_date = _activity_date(request.data.get("activityDate"))
        if not lesson_id or not 1 <= seconds <= 60 or activity_date is None:
            return Response({"message": "Learning activity details are invalid."}, status=status.HTTP_400_BAD_REQUEST)
        query = {
            "studentId": request.user.id,
            "activityDate": activity_date.isoformat(),
            "lessonId": lesson_id,
        }
        collection("learning_activity").update_one(
            query,
            {
                "$inc": {"seconds": seconds},
                "$set": {"updatedAt": datetime.now(timezone.utc)},
                "$setOnInsert": {"createdAt": datetime.now(timezone.utc)},
            },
            upsert=True,
        )
        return Response({"recorded": True, "seconds": seconds})


class CourseRecommendationsView(StudentAPIView):
    def get(self, request):
        courses = [
            item for item in collection("courses").find().limit(500)
            if _is_published(item)
        ]
        enrollments = list(collection("enrollments").find(_user_query(request.user)).limit(500))
        enrolled_ids = {str(_enrollment_course_id(item)) for item in enrollments}
        completed_ids = {
            str(_enrollment_course_id(item))
            for item in enrollments
            if item.get("status") == "completed" or float(item.get("courseProgress", 0) or 0) >= 100
        }
        available = [item for item in courses if str(item["_id"]) not in enrolled_ids]
        recommendations = []
        for course in available[:20]:
            public = _public_course(course)
            recommendations.append({
                **public,
                "id": public["_id"],
                "title": public.get("title", "Course"),
                "category": public.get("category") or "",
                "difficulty": public.get("difficulty") or "",
                "thumbnailUrl": public.get("thumbnailUrl") or public.get("thumbnail_url"),
                "estimatedDurationMinutes": public.get("estimatedDurationMinutes", 0),
                "basedOnCourses": [],
            })
        return Response({
            "recommendations": recommendations,
            "completedCourseCount": len(completed_ids),
            "availableCourseCount": len(courses),
            "allAvailableCoursesCompleted": bool(courses) and len(completed_ids) >= len(courses),
        })


class StudentCourseListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        documents = list(collection("courses").find().limit(100))
        if request.user.role != "student":
            return Response([serialize_document(item) for item in documents])
        courses = [_public_course(item) for item in documents if _is_published(item)]
        return Response({"courses": courses})


class StudentLearningSummaryView(StudentAPIView):
    def get(self, request):
        enrollments = list(collection("enrollments").find(_user_query(request.user)).limit(500))
        completed_lessons = 0
        total_lessons = 0
        in_progress_lessons = 0
        completed_courses = 0
        pending_assignments = 0
        for enrollment in enrollments:
            course_id = _enrollment_course_id(enrollment)
            course = _course_document(course_id) if course_id else None
            lessons = _course_lessons(course or {})
            completed_ids = set(map(str, enrollment.get("completedLessonIds", [])))
            completed = sum(1 for lesson in lessons if str(lesson.get("_id")) in completed_ids)
            total_lessons += len(lessons)
            completed_lessons += completed
            started_ids = set(map(str, enrollment.get("startedLessonIds", [])))
            in_progress_lessons += sum(
                1 for lesson in lessons
                if str(lesson.get("_id")) in started_ids and str(lesson.get("_id")) not in completed_ids
            )
            if enrollment.get("status") == "completed" or (lessons and completed >= len(lessons)):
                completed_courses += 1
            if course:
                submissions = _student_submissions(request.user, course_id, course)
                submitted_ids = {
                    str(item.get("assignmentId") or item.get("assignment_id"))
                    for item in submissions
                    if item.get("status") not in {"returned", "resubmit"}
                }
                pending_assignments += sum(
                    1 for assignment in _course_assignments(course_id, course)
                    if str(assignment.get("_id") or assignment.get("id")) not in submitted_ids
                )
        total_days = {
            item.get("activityDate") or item.get("date")
            for item in collection("learning_activity").find(_user_query(request.user)).limit(1000)
            if int(item.get("seconds", 0) or 0) > 0
        }
        today = datetime.now(timezone.utc).date()
        learning_streak = 0
        cursor = today
        while cursor.isoformat() in total_days:
            learning_streak += 1
            cursor -= timedelta(days=1)
        return Response({"summary": {
            "enrolledCourses": len(enrollments),
            "pendingAssignments": pending_assignments,
            "completedCourses": completed_courses,
            "learningStreak": learning_streak,
            "completedLessons": completed_lessons,
            "inProgressLessons": in_progress_lessons,
            "notStartedLessons": max(0, total_lessons - completed_lessons - in_progress_lessons),
            "totalLessons": total_lessons,
            "completionPercentage": round(completed_lessons * 100 / total_lessons) if total_lessons else 0,
        }})


class StudentLearningActivityView(StudentAPIView):
    def get(self, request):
        start = _activity_date(request.query_params.get("start"))
        end = _activity_date(request.query_params.get("end"))
        if start is None or end is None or end < start or (end - start).days > 120:
            return Response({"message": "A valid activity date range is required."}, status=status.HTTP_400_BAD_REQUEST)
        days = {}
        cursor = start
        while cursor <= end:
            days[cursor.isoformat()] = {"date": cursor.isoformat(), "seconds": 0, "videosWatched": 0, "lessonsCompleted": 0, "_lessons": set()}
            cursor += timedelta(days=1)
        for item in collection("learning_activity").find(_user_query(request.user)).limit(5000):
            key = item.get("activityDate") or item.get("date")
            if key not in days:
                continue
            day = days[key]
            day["seconds"] += int(item.get("seconds", 0) or 0)
            if item.get("lessonId"):
                day["_lessons"].add(str(item["lessonId"]))
            if item.get("type") == "lesson_completed":
                day["lessonsCompleted"] += 1
        for day in days.values():
            day["videosWatched"] = len(day.pop("_lessons"))
        return Response({"days": list(days.values())})


class CourseLearningContentView(StudentAPIView):
    def get(self, request, course_id):
        enrollment = collection("enrollments").find_one(
            _enrollment_query(request.user, course_id=course_id)
        )
        if enrollment is None:
            return Response({"message": "Enrollment not found."}, status=status.HTTP_404_NOT_FOUND)
        course_id = _enrollment_course_id(enrollment)
        course = _course_document(course_id)
        if course is None:
            return Response({"message": "Course not found."}, status=status.HTTP_404_NOT_FOUND)
        assignment_submissions = _student_submissions(request.user, course_id, course)
        quiz_attempts = _student_quiz_attempts(request.user, course_id)
        decorated = _decorate_enrollment(request.user, enrollment)
        return Response({
            "course": _public_course(course),
            "enrollment": {**decorated, "courseId": _public_course(course)},
            "assignmentSubmissions": assignment_submissions,
            "quizAttempts": quiz_attempts,
        })


class StudentCertificatesView(StudentAPIView):
    def get(self, request):
        certificate_records = list(
            collection("certificates").find(_user_query(request.user)).sort(
                "issuedAt", -1
            ).limit(200)
        )
        certificates_by_course = {}
        for item in certificate_records:
            course_id = item.get("courseId") or item.get("course_id")
            if course_id:
                certificates_by_course[str(course_id)] = item

        certificates = []
        seen_course_ids = set()
        enrollments = collection("enrollments").find(_user_query(request.user)).sort(
            "createdAt", -1
        ).limit(200)
        for enrollment in enrollments:
            course_id = _enrollment_course_id(enrollment)
            if not course_id:
                continue
            course_key = str(course_id)
            course = _course_document(course_id)
            if course is None:
                continue
            seen_course_ids.add(course_key)
            lessons = _course_lessons(course)
            completed_ids = set(map(str, enrollment.get("completedLessonIds", [])))
            pending = [
                {
                    "type": "video",
                    "id": str(lesson.get("_id")),
                    "title": lesson.get("title") or "Video lesson",
                }
                for lesson in lessons
                if lesson.get("_id") and str(lesson.get("_id")) not in completed_ids
            ]
            for quiz in _course_quizzes(course):
                quiz_id = quiz.get("_id") or quiz.get("id")
                if not quiz_id:
                    continue
                attempts = _quiz_attempts_for(
                    request.user,
                    course_id,
                    quiz_id,
                )
                if not any(item.get("passed") is True for item in attempts):
                    pending.append({
                        "type": "quiz",
                        "id": str(quiz_id),
                        "title": quiz.get("title") or "Quiz",
                    })
            submissions = _student_submissions(request.user, course_id, course)
            submissions_by_assignment = {}
            for submission in submissions:
                assignment_id = submission.get("assignmentId") or submission.get("assignment_id")
                if assignment_id:
                    submissions_by_assignment[str(assignment_id)] = submission
            for assignment in _course_assignments(course_id, course):
                assignment_id = assignment.get("_id") or assignment.get("id")
                if not assignment_id:
                    continue
                submission = submissions_by_assignment.get(str(assignment_id))
                submission_status = str((submission or {}).get("status", "")).lower()
                if submission_status not in {"graded", "approved", "completed"}:
                    pending.append({
                        "type": "assignment",
                        "id": str(assignment_id),
                        "title": assignment.get("title") or "Assignment",
                        "status": (
                            "resubmit"
                            if submission_status in {"returned", "resubmit"}
                            else "awaiting-review"
                            if submission is not None
                            else "not-submitted"
                        ),
                    })

            raw_certificate = certificates_by_course.get(course_key)
            certificate = _document(raw_certificate)
            if certificate is not None:
                certificate.setdefault(
                    "certificateId",
                    certificate.get("certificate_id") or certificate.get("_id"),
                )
                certificate.setdefault("courseName", course.get("title") or course.get("name") or "Course")
                certificate.setdefault("completedAt", certificate.get("issuedAt") or certificate.get("issued_at"))
            progress = enrollment.get("courseProgress")
            if progress is None:
                progress = round(
                    len(completed_ids) * 100 / len(lessons)
                ) if lessons else 0
            certificates.append({
                "courseId": course_key,
                "courseName": course.get("title") or course.get("name") or "Course",
                "thumbnailUrl": course.get("thumbnailUrl") or course.get("thumbnail_url"),
                "progress": {"percentage": max(0, min(100, float(progress or 0)))},
                "pendingRequirements": pending,
                "certificate": certificate,
            })

        for course_key, item in certificates_by_course.items():
            if course_key in seen_course_ids:
                continue
            certificate = _document(item)
            certificate_id = certificate.get("certificateId") or certificate.get("certificate_id") or certificate.get("_id")
            course = _course_document(course_key)
            course_name = (
                certificate.get("courseName")
                or certificate.get("courseTitle")
                or (course.get("title") or course.get("name") if course else None)
                or "Course"
            )
            certificate.setdefault("certificateId", certificate_id)
            certificate.setdefault("courseName", course_name)
            certificate.setdefault("completedAt", certificate.get("issuedAt") or certificate.get("issued_at"))
            certificates.append({
                "courseId": course_key,
                "courseName": course_name,
                "thumbnailUrl": course.get("thumbnailUrl") if course else None,
                "progress": {"percentage": 100},
                "pendingRequirements": [],
                "certificate": certificate,
            })
        return Response({"certificates": certificates})

    def head(self, request):
        return Response(status=status.HTTP_200_OK)


class StudentCertificatePdfView(StudentAPIView):
    def get(self, request, certificate_id):
        object_id = _object_id(certificate_id)
        query = _combine(
            _user_query(request.user),
            {"$or": [{"_id": object_id}, {"certificateId": certificate_id}, {"certificate_id": certificate_id}]}
            if object_id
            else {"$or": [{"certificateId": certificate_id}, {"certificate_id": certificate_id}]},
        )
        certificate = collection("certificates").find_one(query)
        if not certificate:
            return Response({"message": "Certificate not found."}, status=status.HTTP_404_NOT_FOUND)
        file_id = certificate.get("fileId") or certificate.get("file_id")
        if file_id:
            gridfs_id = _object_id(file_id)
            if gridfs_id is not None:
                try:
                    stream = GridFSBucket(get_database()).open_download_stream(gridfs_id)
                except NoFile:
                    return Response({"message": "Certificate PDF is unavailable."}, status=status.HTTP_404_NOT_FOUND)
                return FileResponse(
                    stream,
                    as_attachment=request.query_params.get("download") == "true",
                    filename=f"certificate-{certificate.get('certificateId') or certificate_id}.pdf",
                    content_type="application/pdf",
                )
        return Response({"message": "Certificate PDF is unavailable."}, status=status.HTTP_404_NOT_FOUND)


class StudentNotificationsView(StudentAPIView):
    def get(self, request):
        records = collection("notifications").find(_user_query(request.user)).sort(
            "createdAt", -1
        ).limit(100)
        notifications = []
        for record in records:
            item = _document(record)
            item.setdefault("isRead", bool(item.get("readAt")))
            item.setdefault("createdAt", item.get("created_at"))
            notifications.append(item)
        return Response({
            "notifications": notifications,
            "unreadCount": sum(1 for item in notifications if not item.get("isRead")),
        })


class StudentNotificationActionView(StudentAPIView):
    def patch(self, request, notification_id=None):
        now = datetime.now(timezone.utc)
        query = _user_query(request.user)
        if notification_id == "read-all":
            collection("notifications").update_many(
                _combine(query, {"isRead": {"$ne": True}}),
                {"$set": {"isRead": True, "readAt": now}},
            )
            return Response({"updated": True, "readAt": now})
        object_id = _object_id(notification_id)
        if object_id is None:
            return Response({"message": "Notification not found."}, status=status.HTTP_404_NOT_FOUND)
        record = collection("notifications").find_one_and_update(
            _combine(query, {"_id": object_id}),
            {"$set": {"isRead": True, "readAt": now}},
            return_document=ReturnDocument.AFTER,
        )
        if record is None:
            return Response({"message": "Notification not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response({"updated": True, "readAt": now})

    def delete(self, request, notification_id):
        object_id = _object_id(notification_id)
        if object_id is None:
            return Response({"message": "Notification not found."}, status=status.HTTP_404_NOT_FOUND)
        result = collection("notifications").delete_one(
            _combine(_user_query(request.user), {"_id": object_id})
        )
        if not result.deleted_count:
            return Response({"message": "Notification not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response({"deleted": True})


class StudentReferralsView(StudentAPIView):
    def get(self, request):
        records = list(
            collection("referral_codes").find(_user_query(request.user)).sort(
                "createdAt", -1
            ).limit(100)
        )
        codes = []
        for record in records:
            item = _document(record)
            item.setdefault("createdAt", item.get("created_at"))
            item.setdefault("expiresAt", item.get("expires_at"))
            item.setdefault("status", "active")
            codes.append(item)
        now = datetime.now(timezone.utc)
        active = [item for item in codes if item["status"] == "active" and item.get("expiresAt")]
        expired_count = sum(
            1 for item in codes
            if item.get("expiresAt") and _coerce_datetime(item["expiresAt"]) <= now
        )
        referrals = list(
            collection("referrals").find(_user_query(request.user)).limit(500)
        )
        return Response({
            "codes": codes,
            "stats": {
                "totalGenerated": len(codes),
                "totalLimit": 20,
                "remaining": max(0, 20 - len(codes)),
                "successfullyUsed": sum(1 for item in referrals if item.get("status") == "completed"),
                "pendingReferrals": sum(1 for item in referrals if item.get("status") != "completed"),
                "activeCodes": sum(
                    1 for item in active
                    if _coerce_datetime(item["expiresAt"]) > now
                ),
                "expiredCodes": expired_count,
            },
        })

    def post(self, request):
        request_id = str(request.data.get("requestId", "")).strip()
        if not request_id or len(request_id) > 128:
            return Response({"message": "A valid referral request ID is required."}, status=status.HTTP_400_BAD_REQUEST)
        codes = collection("referral_codes")
        existing = codes.find_one({"studentId": request.user.id, "requestId": request_id})
        if existing:
            return Response({"code": _document(existing)})
        now = datetime.now(timezone.utc)
        midnight = datetime.combine(now.date(), time.min, tzinfo=timezone.utc)
        today_count = codes.count_documents({
            "studentId": request.user.id,
            "createdAt": {"$gte": midnight, "$lt": midnight + timedelta(days=1)},
        })
        total_count = codes.count_documents({"studentId": request.user.id})
        if today_count >= 5 or total_count >= 20:
            return Response(
                {"message": "Referral code generation limit reached."},
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )
        code = secrets.token_urlsafe(8).replace("-", "").replace("_", "").upper()
        document = {
            "studentId": request.user.id,
            "code": code,
            "requestId": request_id,
            "status": "active",
            "createdAt": now,
            "expiresAt": now + timedelta(days=15),
            "uses": 0,
        }
        try:
            result = codes.insert_one(document)
        except DuplicateKeyError:
            existing = codes.find_one({"studentId": request.user.id, "requestId": request_id})
            if existing is None:
                raise
            return Response({"code": _document(existing)})
        document["_id"] = result.inserted_id
        return Response({"code": _document(document)}, status=status.HTTP_201_CREATED)


def _coerce_datetime(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)


def _find_assignment(course_id, assignment_id, course=None):
    for assignment in _course_assignments(course_id, course):
        if str(assignment.get("_id") or assignment.get("id")) == str(assignment_id):
            return assignment
    object_id = _object_id(assignment_id)
    query = _combine(
        _course_query(course_id),
        {"$or": [{"_id": object_id}, {"_id": assignment_id}]} if object_id else {"_id": assignment_id},
    )
    return collection("assignments").find_one(query)


class StudentAssignmentSubmissionView(StudentAPIView):
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def post(self, request, course_id, assignment_id):
        course = _course_document(course_id)
        assignment = _find_assignment(course_id, assignment_id, course)
        if course is None or assignment is None:
            return Response({"message": "Assignment not found."}, status=status.HTTP_404_NOT_FOUND)
        enrollment = collection("enrollments").find_one(
            _enrollment_query(request.user, course_id=course_id)
        )
        if enrollment is None:
            return Response({"message": "Enrollment not found."}, status=status.HTTP_404_NOT_FOUND)
        uploaded_file = request.FILES.get("file")
        if uploaded_file is None:
            return Response({"message": "Choose a file to submit."}, status=status.HTTP_400_BAD_REQUEST)
        extension = Path(uploaded_file.name).suffix.lower()
        if extension not in {".pdf", ".docx", ".txt"}:
            return Response({"message": "Only PDF, DOCX, and TXT files can be submitted."}, status=status.HTTP_400_BAD_REQUEST)
        if uploaded_file.size > 10 * 1024 * 1024:
            return Response({"message": "The assignment file must be 10 MB or smaller."}, status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        now = datetime.now(timezone.utc)
        bucket = GridFSBucket(get_database())
        file_id = bucket.upload_from_stream(
            Path(uploaded_file.name).name,
            uploaded_file,
            metadata={"ownerId": request.user.id, "courseId": str(course_id)},
        )
        submission = {
            "student_id": request.user.id,
            "studentId": request.user.id,
            "courseId": str(course_id),
            "assignment_id": str(assignment_id),
            "assignmentId": str(assignment_id),
            "fileId": str(file_id),
            "fileName": Path(uploaded_file.name).name,
            "fileType": uploaded_file.content_type or "application/octet-stream",
            "fileSize": uploaded_file.size,
            "status": "submitted",
            "submittedAt": now,
            "created_at": now,
            "createdAt": now,
        }
        result = collection("submissions").insert_one(submission)
        submission["_id"] = result.inserted_id
        return Response(
            {"submission": _document(submission)},
            status=status.HTTP_201_CREATED,
        )

    def get(self, request, course_id, assignment_id):
        course = _course_document(course_id)
        assignment = _find_assignment(course_id, assignment_id, course)
        if course is None or assignment is None:
            return Response({"message": "Assignment not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response({"message": "Assignment submissions are available through course content."}, status=status.HTTP_405_METHOD_NOT_ALLOWED)


class StudentAssignmentSubmissionActionView(StudentAPIView):
    parser_classes = [JSONParser]

    def post(self, request, submission_id):
        object_id = _object_id(submission_id)
        if object_id is None:
            return Response({"message": "Submission not found."}, status=status.HTTP_404_NOT_FOUND)
        submission = collection("submissions").find_one(
            _combine(_user_query(request.user), {"_id": object_id})
        )
        if submission is None:
            return Response({"message": "Submission not found."}, status=status.HTTP_404_NOT_FOUND)
        reasons = request.data.get("reasons", [])
        if not isinstance(reasons, list) or len(reasons) > 5 or any(not isinstance(item, str) for item in reasons):
            return Response({"message": "Review request reasons are invalid."}, status=status.HTTP_400_BAD_REQUEST)
        now = datetime.now(timezone.utc)
        update = {
            "reasons": [item.strip()[:100] for item in reasons if item.strip()],
            "otherExplanation": str(request.data.get("otherExplanation", ""))[:1000],
            "comments": str(request.data.get("comments", ""))[:2000],
            "requestedAt": now,
        }
        updated = collection("submissions").find_one_and_update(
            _combine(_user_query(request.user), {"_id": object_id}),
            {"$set": {"humanReviewRequest": update, "humanReviewRequestedAt": now}},
            return_document=ReturnDocument.AFTER,
        )
        return Response({"submission": _document(updated)})


class StudentAssignmentDownloadView(StudentAPIView):
    def get(self, request, submission_id):
        object_id = _object_id(submission_id)
        submission = collection("submissions").find_one(
            _combine(_user_query(request.user), {"_id": object_id})
        ) if object_id else None
        file_id = _object_id(submission.get("fileId")) if submission else None
        if file_id is None:
            return Response({"message": "Assignment file not found."}, status=status.HTTP_404_NOT_FOUND)
        try:
            stream = GridFSBucket(get_database()).open_download_stream(file_id)
        except NoFile:
            return Response({"message": "Assignment file not found."}, status=status.HTTP_404_NOT_FOUND)
        return FileResponse(
            stream,
            as_attachment=True,
            filename=Path(submission.get("fileName") or "submission").name,
            content_type=submission.get("fileType") or "application/octet-stream",
        )


def _find_quiz(course, quiz_id):
    return next(
        (
            quiz for quiz in _course_quizzes(course)
            if str(quiz.get("_id") or quiz.get("id")) == str(quiz_id)
        ),
        None,
    )


def _quiz_status(user, course_id, quiz_id, quiz):
    attempts = _quiz_attempts_for(user, course_id, quiz_id)
    max_attempts = max(1, int(quiz.get("maxAttempts", 3) or 3))
    passed = any(item.get("passed") is True for item in attempts)
    locked_until = next(
        (item.get("lockedUntil") for item in attempts if item.get("lockedUntil")),
        None,
    )
    if locked_until and _coerce_datetime(locked_until) <= datetime.now(timezone.utc):
        locked_until = None
    return {
        "maxAttempts": max_attempts,
        "attemptsUsed": len(attempts),
        "attemptsRemaining": max(0, max_attempts - len(attempts)),
        "passed": passed,
        "lockedUntil": locked_until,
        "serverTime": datetime.now(timezone.utc),
    }, attempts


def _student_question(question):
    return {
        key: _id_value(value)
        for key, value in question.items()
        if key not in {"correctOptionIndices", "correctAnswer", "correctAnswerIndex", "answer"}
    }


def _public_quiz_attempt(attempt):
    result = _document(attempt)
    if result is None:
        return None
    result["questions"] = [
        _student_question(question)
        for question in result.get("questions", [])
        if isinstance(question, dict)
    ]
    return result


class StudentQuizAttemptView(StudentAPIView):
    parser_classes = [JSONParser]

    def _context(self, request, course_id, quiz_id):
        enrollment = collection("enrollments").find_one(
            _enrollment_query(request.user, course_id=course_id)
        )
        course = _course_document(course_id)
        quiz = _find_quiz(course or {}, quiz_id) if course else None
        if enrollment is None or course is None or quiz is None:
            return None, None, None
        return enrollment, course, quiz

    def get(self, request, course_id, quiz_id):
        _enrollment, _course, quiz = self._context(request, course_id, quiz_id)
        if quiz is None:
            return Response({"message": "Quiz not found."}, status=status.HTTP_404_NOT_FOUND)
        quiz_status, attempts = _quiz_status(request.user, course_id, quiz_id, quiz)
        active = next((item for item in attempts if item.get("status") == "started"), None)
        if active is not None:
            quiz_status["activeAttemptId"] = str(active["_id"])
        return Response({"quizStatus": quiz_status})

    def post(self, request, course_id, quiz_id, attempt_id=None):
        enrollment, course, quiz = self._context(request, course_id, quiz_id)
        if enrollment is None:
            return Response({"message": "Enrollment or quiz not found."}, status=status.HTTP_404_NOT_FOUND)
        quiz_status, attempts = _quiz_status(request.user, course_id, quiz_id, quiz)
        if attempt_id is None:
            active = next((item for item in attempts if item.get("status") == "started"), None)
            if active is not None:
                questions = active.get("questions", [])
                return Response({
                    "attempt": _public_quiz_attempt(active),
                    "questions": [_student_question(item) for item in questions],
                    "quizStatus": quiz_status,
                })
            if quiz_status["passed"] or quiz_status["attemptsRemaining"] <= 0:
                return Response(
                    {"message": "No quiz attempts remain.", "quizStatus": quiz_status},
                    status=status.HTTP_423_LOCKED,
                )
            questions = quiz.get("questions", [])
            if not isinstance(questions, list) or not questions:
                return Response({"message": "Quiz has no questions."}, status=status.HTTP_404_NOT_FOUND)
            snapshot = [dict(item) for item in questions if isinstance(item, dict)]
            if not snapshot:
                return Response({"message": "Quiz has no questions."}, status=status.HTTP_404_NOT_FOUND)
            now = datetime.now(timezone.utc)
            attempt = {
                "studentId": request.user.id,
                "courseId": str(course_id),
                "quizId": str(quiz_id),
                "enrollmentId": str(enrollment["_id"]),
                "status": "started",
                "startedAt": now,
                "createdAt": now,
                "timeLimitMinutes": int(quiz.get("timeLimitMinutes", 0) or 0),
                "questions": snapshot,
                "answers": [],
            }
            result = collection("quiz_attempts").insert_one(attempt)
            attempt["_id"] = result.inserted_id
            return Response({
                "attempt": _public_quiz_attempt(attempt),
                "questions": [_student_question(item) for item in snapshot],
                "quizStatus": _quiz_status(request.user, course_id, quiz_id, quiz)[0],
            }, status=status.HTTP_201_CREATED)

        object_id = _object_id(attempt_id)
        if object_id is None:
            return Response({"message": "Quiz attempt not found."}, status=status.HTTP_404_NOT_FOUND)
        attempt = collection("quiz_attempts").find_one(
            _combine(_user_query(request.user), {"_id": object_id}, _course_query(course_id))
        )
        if attempt is None or attempt.get("status") != "started":
            return Response({"message": "Quiz attempt not found."}, status=status.HTTP_404_NOT_FOUND)
        submitted_answers = request.data.get("answers")
        if not isinstance(submitted_answers, list):
            return Response({"message": "Quiz answers are required."}, status=status.HTTP_400_BAD_REQUEST)
        answers_by_id = {str(item.get("questionId")): item for item in submitted_answers if isinstance(item, dict)}
        score_points = 0.0
        total_points = 0.0
        correct_answer_count = 0
        saved_answers = []
        for question in attempt.get("questions", []):
            question_id = str(question.get("_id", ""))
            answer = answers_by_id.get(question_id, {})
            selected = answer.get("selectedOptionIndices", [])
            correct = question.get("correctOptionIndices")
            if correct is None and question.get("correctAnswerIndex") is not None:
                correct = [question["correctAnswerIndex"]]
            correct = sorted(correct if isinstance(correct, list) else [correct] if correct is not None else [])
            selected = sorted(selected if isinstance(selected, list) else [])
            points = float(question.get("points", 1) or 1)
            total_points += points
            is_correct = selected == correct and bool(correct)
            if is_correct:
                score_points += points
                correct_answer_count += 1
            saved_answers.append({
                "questionId": question_id,
                "selectedOptionIndices": selected,
                "correctOptionIndices": correct,
            })
        score = round(score_points * 100 / total_points, 2) if total_points else 0
        pass_percentage = float(quiz.get("passingPercentage", 70) or 70)
        now = datetime.now(timezone.utc)
        updated = collection("quiz_attempts").find_one_and_update(
            _combine(_user_query(request.user), {"_id": object_id, "status": "started"}),
            {"$set": {
                "status": "submitted",
                "answers": saved_answers,
                "earnedPoints": score_points,
                "totalPoints": total_points,
                "scorePercentage": score,
                "correctAnswers": correct_answer_count,
                "incorrectAnswers": len(attempt.get("questions", [])) - correct_answer_count,
                "passed": score >= pass_percentage,
                "submittedAt": now,
                "updatedAt": now,
            }},
            return_document=ReturnDocument.AFTER,
        )
        if updated is None:
            return Response({"message": "Quiz attempt has already been submitted."}, status=status.HTTP_409_CONFLICT)
        updated_public = _document(updated)
        for question in updated_public.get("questions", []):
            if isinstance(question, dict):
                for key in ("correctOptionIndices", "correctAnswer", "correctAnswerIndex", "answer"):
                    question.pop(key, None)
        return Response({
            "attempt": updated_public,
            "quizStatus": _quiz_status(request.user, course_id, quiz_id, quiz)[0],
            "courseProgress": enrollment.get("courseProgress", 0),
        })


def _find_lesson(course, lesson_id):
    return next(
        (
            lesson for lesson in _course_lessons(course)
            if str(lesson.get("_id")) == str(lesson_id)
        ),
        None,
    )


class StudentAttentionCheckView(StudentAPIView):
    parser_classes = [JSONParser]

    def post(self, request, course_id, lesson_id, action):
        if action == "start":
            course = _course_document(course_id)
            enrollment = collection("enrollments").find_one(
                _enrollment_query(request.user, course_id=course_id)
            )
            lesson = _find_lesson(course or {}, lesson_id) if course else None
            settings_data = lesson.get("attentionCheck", {}) if lesson else {}
            if (
                enrollment is None
                or lesson is None
                or not isinstance(settings_data, dict)
                or settings_data.get("enabled") is not True
            ):
                return Response({"message": "Attention check is unavailable for this lesson."}, status=status.HTTP_404_NOT_FOUND)
            questions = settings_data.get("questions", [])
            questions = [item for item in questions if isinstance(item, dict) and item.get("prompt") and item.get("options")]
            if not questions:
                return Response({"message": "No attention-check questions are configured."}, status=status.HTTP_404_NOT_FOUND)
            question = dict(secrets.choice(questions))
            for key in ("correctOptionIndices", "correctAnswer", "answer"):
                question.pop(key, None)
            now = datetime.now(timezone.utc)
            response_id = ObjectId()
            try:
                trigger_index = int(request.data.get("triggerIndex", 0) or 0)
            except (TypeError, ValueError):
                return Response({"message": "Attention-check trigger is invalid."}, status=status.HTTP_400_BAD_REQUEST)
            if trigger_index < 0:
                return Response({"message": "Attention-check trigger is invalid."}, status=status.HTTP_400_BAD_REQUEST)
            collection("attention_check_responses").insert_one({
                "_id": response_id,
                "studentId": request.user.id,
                "courseId": str(course_id),
                "lessonId": str(lesson_id),
                "sessionId": str(request.data.get("sessionId", ""))[:128],
                "triggerIndex": trigger_index,
                "optionCount": len(question.get("options", [])),
                "presentedAt": now,
                "expiresAt": now + timedelta(minutes=5),
                "status": "pending",
            })
            return Response({
                "responseId": str(response_id),
                "question": _student_question(question),
                "presentedAt": now,
                "serverTime": now,
            })
        if action != "submit":
            return Response({"message": "Attention-check action was not found."}, status=status.HTTP_404_NOT_FOUND)
        response_id = _object_id(request.data.get("responseId"))
        record = collection("attention_check_responses").find_one(
            _combine(
                _user_query(request.user),
                {"_id": response_id, "courseId": str(course_id), "lessonId": str(lesson_id)},
            )
        ) if response_id else None
        if record is None or record.get("status") != "pending":
            return Response({"message": "Attention-check response not found."}, status=status.HTTP_404_NOT_FOUND)
        now = datetime.now(timezone.utc)
        not_answered = request.data.get("notAnswered") is True
        presented_at = _coerce_datetime(record.get("presentedAt"))
        if not_answered and now < presented_at + timedelta(seconds=10):
            return Response(
                {"message": "The 10-second response window is still active."},
                status=status.HTTP_409_CONFLICT,
            )
        if not not_answered and now > presented_at + timedelta(seconds=10):
            return Response(
                {"message": "The 10-second response window has ended."},
                status=status.HTTP_409_CONFLICT,
            )
        selected = request.data.get("selectedOptionIndices", [])
        if not not_answered and (
            not isinstance(selected, list)
            or any(
                not isinstance(index, int)
                or index < 0
                or index >= int(record.get("optionCount", 0))
                for index in selected
            )
        ):
            return Response({"message": "Attention-check answer is invalid."}, status=status.HTTP_400_BAD_REQUEST)
        update = {
            "status": "not_answered" if not_answered else "answered",
            "selectedOptionIndices": selected,
            "respondedAt": now,
        }
        updated = collection("attention_check_responses").find_one_and_update(
            {"_id": response_id, "status": "pending"},
            {"$set": update},
            return_document=ReturnDocument.AFTER,
        )
        return Response({"recorded": updated is not None, "status": update["status"]})


class StudentCourseResourceFileView(StudentAPIView):
    def get(self, request, course_id, resource_id):
        course = _course_document(course_id)
        if course is None:
            return Response({"message": "Course resource not found."}, status=status.HTTP_404_NOT_FOUND)
        enrollment = collection("enrollments").find_one(
            _enrollment_query(request.user, course_id=course_id)
        )
        if enrollment is None:
            return Response({"message": "Enrollment not found."}, status=status.HTTP_404_NOT_FOUND)
        target_ids = {resource_id}
        public_id = request.query_params.get("publicId")
        if public_id:
            target_ids.add(str(public_id))
        resource = _find_resource(course, target_ids)
        if resource is None:
            return Response({"message": "Course resource not found."}, status=status.HTTP_404_NOT_FOUND)
        file_id = _object_id(resource.get("fileId") or resource.get("file_id"))
        if file_id is None:
            return Response({"message": "This resource file is not stored in the LMS database."}, status=status.HTTP_404_NOT_FOUND)
        try:
            stream = GridFSBucket(get_database()).open_download_stream(file_id)
        except NoFile:
            return Response({"message": "Course resource file not found."}, status=status.HTTP_404_NOT_FOUND)
        filename = Path(resource.get("fileName") or resource.get("name") or "resource").name
        return FileResponse(
            stream,
            as_attachment=request.query_params.get("download") == "true",
            filename=filename,
            content_type=resource.get("fileType") or "application/octet-stream",
        )


def _find_resource(value, target_ids):
    if isinstance(value, dict):
        if str(value.get("_id") or value.get("publicId") or value.get("id") or "") in target_ids:
            if any(key in value for key in ("fileId", "file_id", "url", "publicId")):
                return value
        for child in value.values():
            result = _find_resource(child, target_ids)
            if result is not None:
                return result
    elif isinstance(value, list):
        for child in value:
            result = _find_resource(child, target_ids)
            if result is not None:
                return result
    return None


class StudentReferralCodeValidationView(APIView):
    permission_classes = [AllowAny]
    parser_classes = [JSONParser]

    def post(self, request):
        code = str(request.data.get("code", "")).strip().upper()
        if not code or len(code) > 64:
            return Response(
                {"valid": False, "message": "Enter a valid referral code."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        referral = collection("referral_codes").find_one({"code": code})
        if (
            referral is None
            or referral.get("status") != "active"
            or _coerce_datetime(referral.get("expiresAt") or referral.get("expires_at"))
            <= datetime.now(timezone.utc)
        ):
            return Response(
                {"valid": False, "message": "This referral code is invalid, expired, or already used."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response({"valid": True, "code": code})

