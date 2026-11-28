import copy
import logging
import math
import re
import secrets
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from bson import ObjectId
from bson.errors import InvalidId
from drf_spectacular.utils import extend_schema
from django.http import FileResponse, HttpResponse, HttpResponseRedirect
from gridfs import GridFSBucket
from gridfs.errors import NoFile
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError
from pymongo.errors import PyMongoError
from rest_framework import status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from authentication.approval import is_hustler_account
from core.assignment_attempts import (
    AssignmentPolicyError,
    assignment_policy_status,
    get_assignment_policy,
)
from core.cloudinary_storage import (
    CloudinaryConfigurationError,
    CloudinaryStorageError,
    MediaValidationError,
    delete_media,
    is_cloudinary_delivery_url,
    upload_media,
)
from core.mongo import serialize_document
from core.mongodb import collection, get_database
from student_api.certificate_generation import (
    CertificateRenderError,
    issue_course_completion_certificate,
    render_certificate_pdf,
)


logger = logging.getLogger(__name__)


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
        "correctOptionIndex",
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


def _is_published(course, user=None):
    state = str(course.get("status", "")).strip().lower()
    if state == "published" and getattr(user, "account_type", None) == "hustler":
        return True
    if course.get("published") is False or course.get("isPublished") is False:
        return False
    if course.get("is_published") is False:
        return False
    return state not in {"draft", "unpublished", "inactive", "rejected", "archived"}


def _public_course(course):
    result = _remove_quiz_answers(_document(course))
    if result is None:
        return None
    course_quizzes = result.get("quizzes")
    if isinstance(course_quizzes, list):
        result["quizzes"] = [
            quiz for quiz in course_quizzes
            if isinstance(quiz, dict) and quiz.get("_id")
        ]
    for module in result.get("modules", []) or []:
        if not isinstance(module, dict):
            continue
        module_quiz = module.get("quiz")
        if isinstance(module_quiz, dict) and not module_quiz.get("_id"):
            module.pop("quiz", None)
        content_items = module.get("contentItems")
        if isinstance(content_items, list):
            module["contentItems"] = [
                item for item in content_items
                if not isinstance(item, dict)
                or item.get("type") != "quiz"
                or (
                    (item.get("quiz") if isinstance(item.get("quiz"), dict) else item)
                    .get("_id")
                )
            ]
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


def _ensure_course_assignment_ids(course, retries=1):
    course_id = course.get("_id")
    if course_id is None:
        raise RuntimeError("The course does not have a saved MongoDB ID.")

    fields = {}
    seen = set()

    def assign_id(assignment):
        if not isinstance(assignment, dict):
            return
        assignment_id = assignment.get("_id") or assignment.get("id")
        key = str(assignment_id) if assignment_id is not None else ""
        if not key or key in seen:
            assignment_id = ObjectId()
            key = str(assignment_id)
        if assignment.get("_id") != assignment_id:
            assignment["_id"] = assignment_id
        seen.add(key)

    assignments = copy.deepcopy(course.get("assignments", []))
    if isinstance(assignments, list):
        for assignment in assignments:
            assign_id(assignment)
        if assignments != course.get("assignments", []):
            fields["assignments"] = assignments

    modules = copy.deepcopy(course.get("modules", []))
    if isinstance(modules, list):
        for module in modules:
            if not isinstance(module, dict):
                continue
            for assignment in module.get("assignments", []) or []:
                assign_id(assignment)
            for item in module.get("contentItems", []) or []:
                if isinstance(item, dict) and str(item.get("type", "")).lower() == "assignment":
                    assign_id(item)
        if modules != course.get("modules", []):
            fields["modules"] = modules

    if not fields:
        return course

    query = {"_id": course_id}
    for field in fields:
        query[field] = course[field] if field in course else {"$exists": False}
    updated = collection("courses").find_one_and_update(
        query,
        {"$set": fields},
        return_document=ReturnDocument.AFTER,
    )
    if updated is not None:
        return updated
    if retries <= 0:
        raise RuntimeError("Could not save assignment IDs to the course.")
    latest = collection("courses").find_one({"_id": course_id})
    if latest is None:
        raise RuntimeError("The course disappeared while assignment IDs were being saved.")
    return _ensure_course_assignment_ids(latest, retries - 1)


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
            for content_item in module.get("contentItems", []) or []:
                if not isinstance(content_item, dict):
                    continue
                if str(content_item.get("type", "")).lower() != "assignment":
                    continue
                assignment = content_item.get("assignment")
                assignments.append(
                    {**assignment, **content_item}
                    if isinstance(assignment, dict)
                    else content_item
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


QUIZ_MAX_COMPLETED_ATTEMPTS = 3
QUIZ_ATTEMPT_LOCK_DURATION = timedelta(hours=24)


def _quiz_policy_key(user, course_id, quiz_id):
    return f"{user.id}:{course_id}:{quiz_id}"


def _record_completed_quiz_attempt(user, course_id, quiz_id, attempt, now):
    policy_id = _quiz_policy_key(user, course_id, quiz_id)
    attempt_id = str(attempt["_id"])
    policies = collection("quiz_attempt_policies")

    for _ in range(3):
        policy = policies.find_one({"_id": policy_id})
        if policy is None:
            raise RuntimeError("The quiz attempt policy is missing.")
        completed_ids = {str(value) for value in policy.get("completedAttemptIds", [])}
        if attempt_id in completed_ids:
            return policy
        completed_count = int(policy.get("completedAttempts", 0) or 0)
        if completed_count >= QUIZ_MAX_COMPLETED_ATTEMPTS:
            raise RuntimeError("The quiz attempt limit was reached before this attempt completed.")

        updated_fields = {
            "updatedAt": now,
        }
        if policy.get("activeAttemptId") in (None, attempt_id):
            updated_fields["activeAttemptId"] = None
        if completed_count + 1 == QUIZ_MAX_COMPLETED_ATTEMPTS:
            updated_fields["lockedUntil"] = now + QUIZ_ATTEMPT_LOCK_DURATION
        updated = policies.find_one_and_update(
            {
                "_id": policy_id,
                "completedAttempts": completed_count,
                "completedAttemptIds": {"$ne": attempt_id},
            },
            {
                "$addToSet": {"completedAttemptIds": attempt_id},
                "$inc": {"completedAttempts": 1},
                "$set": updated_fields,
            },
            return_document=ReturnDocument.AFTER,
        )
        if updated is not None:
            return updated

    raise RuntimeError("The quiz attempt count could not be updated.")


def _quiz_attempt_policy(user, course_id, quiz_id, attempts=None, now=None):
    now = now or datetime.now(timezone.utc)
    attempts = _quiz_attempts_for(user, course_id, quiz_id) if attempts is None else attempts
    policy_id = _quiz_policy_key(user, course_id, quiz_id)
    policies = collection("quiz_attempt_policies")
    policy = policies.find_one({"_id": policy_id})
    if policy is None:
        completed = sorted(
            (item for item in attempts if item.get("status") == "submitted"),
            key=lambda item: _coerce_datetime(item.get("submittedAt") or item.get("createdAt")),
        )
        completed = completed[:QUIZ_MAX_COMPLETED_ATTEMPTS]
        completed_ids = [str(item["_id"]) for item in completed if item.get("_id") is not None]
        locked_until = None
        legacy_locks = [
            _coerce_datetime(item["lockedUntil"])
            for item in attempts
            if item.get("lockedUntil") and _coerce_datetime(item["lockedUntil"]) > now
        ]
        if legacy_locks:
            locked_until = max(legacy_locks)
            completed_ids = [str(item["_id"]) for item in completed[-QUIZ_MAX_COMPLETED_ATTEMPTS:] if item.get("_id") is not None]
        elif len(completed) == QUIZ_MAX_COMPLETED_ATTEMPTS:
            third_submission = _coerce_datetime(
                completed[-1].get("submittedAt") or completed[-1].get("createdAt")
            )
            legacy_lock_until = third_submission + QUIZ_ATTEMPT_LOCK_DURATION
            if legacy_lock_until > now:
                locked_until = legacy_lock_until
            else:
                completed_ids = []
                completed = []
        active = next((item for item in attempts if item.get("status") == "started"), None)
        cycle_id = str(ObjectId())
        initial_policy = {
            "_id": policy_id,
            "studentId": user.id,
            "courseId": str(course_id),
            "quizId": str(quiz_id),
            "cycleId": cycle_id,
            "completedAttempts": (
                QUIZ_MAX_COMPLETED_ATTEMPTS
                if locked_until and _coerce_datetime(locked_until) > now
                else len(completed_ids)
            ),
            "completedAttemptIds": completed_ids,
            "lockedUntil": locked_until,
            "activeAttemptId": str(active["_id"]) if active and active.get("_id") else None,
            "createdAt": now,
            "updatedAt": now,
        }
        try:
            policy = policies.find_one_and_update(
                {"_id": policy_id},
                {"$setOnInsert": initial_policy},
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
        except DuplicateKeyError:
            policy = policies.find_one({"_id": policy_id})
        if policy is None:
            raise RuntimeError("The quiz attempt policy could not be initialized.")

    locked_until = policy.get("lockedUntil")
    if locked_until and _coerce_datetime(locked_until) <= now:
        policy = policies.find_one_and_update(
            {"_id": policy_id, "lockedUntil": locked_until},
            {"$set": {
                "cycleId": str(ObjectId()),
                "completedAttempts": 0,
                "completedAttemptIds": [],
                "lockedUntil": None,
                "activeAttemptId": None,
                "cycleStartedAt": now,
                "updatedAt": now,
            }},
            return_document=ReturnDocument.AFTER,
        ) or policies.find_one({"_id": policy_id})
        if policy is None:
            raise RuntimeError("The quiz attempt policy could not be refreshed.")

    cycle_id = policy.get("cycleId")
    completed_ids = {str(value) for value in policy.get("completedAttemptIds", [])}
    for attempt in attempts:
        if (
            attempt.get("status") == "submitted"
            and attempt.get("policyCycleId") == cycle_id
            and attempt.get("_id") is not None
            and str(attempt["_id"]) not in completed_ids
        ):
            policy = _record_completed_quiz_attempt(
                user,
                course_id,
                quiz_id,
                attempt,
                _coerce_datetime(attempt.get("submittedAt") or now),
            )
            completed_ids = {str(value) for value in policy.get("completedAttemptIds", [])}

    active = next((item for item in attempts if item.get("status") == "started"), None)
    if active is not None and active.get("_id") is not None:
        active_id = str(active["_id"])
        if active.get("policyCycleId") != cycle_id:
            updated_attempt = collection("quiz_attempts").find_one_and_update(
                {"_id": active["_id"], "status": "started"},
                {"$set": {"policyCycleId": cycle_id}},
                return_document=ReturnDocument.AFTER,
            )
            if updated_attempt is None:
                raise RuntimeError("The active quiz attempt could not be linked to its policy cycle.")
        if policy.get("activeAttemptId") != active_id:
            policy = policies.find_one_and_update(
                {"_id": policy_id, "activeAttemptId": policy.get("activeAttemptId")},
                {"$set": {"activeAttemptId": active_id, "updatedAt": now}},
                return_document=ReturnDocument.AFTER,
            )
            if policy is None:
                policy = policies.find_one({"_id": policy_id})
                if policy is None or policy.get("activeAttemptId") != active_id:
                    raise RuntimeError("The active quiz attempt could not be linked to its policy.")
    elif policy.get("activeAttemptId"):
        cleared_policy = policies.find_one_and_update(
            {"_id": policy_id, "activeAttemptId": policy["activeAttemptId"]},
            {"$set": {"activeAttemptId": None, "updatedAt": now}},
            return_document=ReturnDocument.AFTER,
        )
        policy = cleared_policy or policies.find_one({"_id": policy_id})
        if policy is None or policy.get("activeAttemptId"):
            raise RuntimeError("The stale active quiz attempt could not be cleared.")

    return policy


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


def _is_hustler_user(user):
    return is_hustler_account({
        "role": getattr(user, "role", None),
        "accountType": getattr(user, "account_type", None),
        "studentType": getattr(user, "student_type", None),
    })


def _assignment_policy_states(user, course_id, course, enrollment):
    if not _is_hustler_user(user) or course is None:
        return {}
    policies = collection("assignment_attempt_policies")
    submission_collections = [
        collection("submissions"),
        collection("assignment_submissions"),
    ]
    now = datetime.now(timezone.utc)
    states = {}
    for assignment in _course_assignments(course_id, course):
        assignment_id = assignment.get("_id") or assignment.get("id")
        if not assignment_id:
            continue
        policy = get_assignment_policy(
            policies,
            submission_collections,
            user.id,
            course_id,
            assignment_id,
            enrollment,
            now=now,
        )
        states[str(assignment_id)] = assignment_policy_status(policy, now=now)
    return states


def _attach_assignment_policy_states(course, states):
    if not course or not states:
        return course

    def attach(assignment):
        if not isinstance(assignment, dict):
            return
        assignment_id = assignment.get("_id") or assignment.get("id")
        state = states.get(str(assignment_id)) if assignment_id else None
        if state is not None:
            assignment["attemptState"] = state

    for assignment in course.get("assignments", []) or []:
        attach(assignment)
    for module in course.get("modules", []) or []:
        if not isinstance(module, dict):
            continue
        for assignment in module.get("assignments", []) or []:
            attach(assignment)
        for item in module.get("contentItems", []) or []:
            if isinstance(item, dict) and str(item.get("type", "")).lower() == "assignment":
                attach(item)
    return course


def _ensure_question_ids(questions):
    seen = set()
    changed = False
    for question in questions:
        if not isinstance(question, dict):
            continue
        question_id = _object_id(question.get("_id") or question.get("id"))
        if question_id is None or str(question_id) in seen:
            question_id = ObjectId()
        if question.get("_id") != question_id:
            question["_id"] = question_id
            changed = True
        seen.add(str(question_id))
    return changed


def _ensure_attempt_question_ids(attempt):
    questions = [
        dict(question)
        for question in attempt.get("questions", [])
        if isinstance(question, dict)
    ]
    if not _ensure_question_ids(questions):
        return attempt
    return collection("quiz_attempts").find_one_and_update(
        {"_id": attempt["_id"], "status": "started"},
        {"$set": {"questions": questions}},
        return_document=ReturnDocument.AFTER,
    )


def _student_quiz_attempts(user, course_id):
    query = _combine(_user_query(user), _course_query(course_id))
    attempts = []
    for item in collection("quiz_attempts").find(query).sort("createdAt", -1).limit(200):
        if item.get("status") == "started":
            item = _ensure_attempt_question_ids(item)
            if item is None:
                continue
        record = _document(item)
        for question in record.get("questions", []) or []:
            if isinstance(question, dict):
                for key in ("correctOptionIndices", "correctOptionIndex", "correctAnswer", "correctAnswerIndex", "answer"):
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
    public_course = _public_course(course) if course else None
    assignment_submissions = _student_submissions(user, course_id, course) if course_id else []
    if public_course and _is_hustler_user(user):
        states = _assignment_policy_states(user, course_id, course, enrollment)
        _attach_assignment_policy_states(public_course, states)
        for submission in assignment_submissions:
            assignment_id = submission.get("assignmentId") or submission.get("assignment_id")
            if assignment_id and str(assignment_id) in states:
                submission["attemptState"] = states[str(assignment_id)]
    result["courseId"] = public_course if public_course else _id_value(
        enrollment.get("courseId", enrollment.get("course_id"))
    )
    result["assignmentSubmissions"] = assignment_submissions
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
        try:
            enrollments = collection("enrollments").find(_user_query(request.user)).sort(
                "createdAt", -1
            ).limit(200)
            decorated = [_decorate_enrollment(request.user, item) for item in enrollments]
        except (AssignmentPolicyError, PyMongoError, RuntimeError):
            logger.exception("Could not load Hustler assignment deadlines and attempt status.")
            return Response(
                {"message": "Course enrollment data could not be loaded. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response({
            "enrollments": decorated
        })

    def post(self, request):
        course_id = request.data.get("courseId")
        course = _course_document(course_id) if course_id else None
        if course is None or not _is_published(course, request.user):
            return Response(
                {"message": "This course is not available for enrollment."},
                status=status.HTTP_404_NOT_FOUND,
            )
        normalized_course_id = str(course["_id"])
        existing = collection("enrollments").find_one(
            _enrollment_query(request.user, course_id=normalized_course_id)
        )
        if existing:
            try:
                decorated = _decorate_enrollment(request.user, existing)
            except (AssignmentPolicyError, PyMongoError, RuntimeError):
                logger.exception("Could not load Hustler assignment deadlines and attempt status.")
                return Response(
                    {"message": "Course enrollment data could not be loaded. Please try again."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            return Response({"enrollment": decorated})
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
            try:
                decorated = _decorate_enrollment(request.user, existing)
            except (AssignmentPolicyError, PyMongoError, RuntimeError):
                logger.exception("Could not load Hustler assignment deadlines and attempt status.")
                return Response(
                    {"message": "Course enrollment data could not be loaded. Please try again."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            return Response({"enrollment": decorated})
        document["_id"] = result.inserted_id
        try:
            decorated = _decorate_enrollment(request.user, document)
        except (AssignmentPolicyError, PyMongoError, RuntimeError):
            logger.exception("Could not load Hustler assignment deadlines and attempt status.")
            return Response(
                {"message": "Your enrollment was created, but assignment status could not be loaded. Please refresh."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response(
            {"enrollment": decorated},
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
            if _is_published(item, request.user)
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

    @extend_schema(operation_id="student_courses_list")
    def get(self, request):
        course_cursor = collection("courses").find()
        if getattr(request.user, "account_type", None) != "hustler":
            course_cursor = course_cursor.limit(100)
        documents = list(course_cursor)
        if request.user.role != "student":
            return Response([serialize_document(item) for item in documents])
        courses = [
            _public_course(item)
            for item in documents
            if _is_published(item, request.user)
        ]
        return Response({"courses": courses})


@extend_schema(exclude=True)
class StudentCourseListNoSlashView(StudentCourseListView):
    pass


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


@extend_schema(exclude=True)
class StudentProfileAvatarView(StudentAPIView):
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        uploaded_file = request.FILES.get("avatar")
        if uploaded_file is None:
            return Response({"message": "Choose a profile image to upload."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            metadata = upload_media(
                uploaded_file,
                "profile_image",
                owner_id=request.user.id,
            )
        except MediaValidationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        users = collection("users")
        try:
            previous = users.find_one({"_id": _object_id(request.user.id)})
            updated = users.update_one(
                {"_id": _object_id(request.user.id)},
                {"$set": {
                    "avatarUrl": metadata["secureUrl"],
                    "avatarPublicId": metadata["publicId"],
                    "avatarResourceType": metadata["resourceType"],
                    "avatarFormat": metadata["format"],
                    "avatarBytes": metadata["bytes"],
                    "avatarOriginalName": metadata["originalName"],
                    "avatarWidth": metadata.get("width"),
                    "avatarHeight": metadata.get("height"),
                }},
            )
        except (PyMongoError, RuntimeError):
            try:
                delete_media(metadata["publicId"], metadata["resourceType"])
            except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
                logger.warning("Unable to clean up an unlinked Cloudinary profile image.")
            raise
        cleanup_warning = False
        if not updated.matched_count:
            try:
                delete_media(metadata["publicId"], metadata["resourceType"])
            except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
                logger.warning("Unable to clean up an unlinked Cloudinary profile image.")
                cleanup_warning = True
            return Response(
                {"message": "User account not found.", "cleanupWarning": cleanup_warning},
                status=status.HTTP_404_NOT_FOUND,
            )
        previous_public_id = previous.get("avatarPublicId") if previous else None
        if previous_public_id and previous_public_id != metadata["publicId"]:
            try:
                delete_media(previous_public_id, "image")
            except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
                cleanup_warning = True
        return Response({
            "avatarUrl": metadata["secureUrl"],
            "avatarPublicId": metadata["publicId"],
            "cleanupWarning": cleanup_warning,
        })

    def delete(self, request):
        users = collection("users")
        user_id = _object_id(request.user.id)
        previous = users.find_one({"_id": user_id})
        if previous is None:
            return Response({"message": "User account not found."}, status=status.HTTP_404_NOT_FOUND)
        users.update_one(
            {"_id": user_id},
            {"$unset": {
                "avatarPublicId": "",
                "avatarResourceType": "",
                "avatarFormat": "",
                "avatarBytes": "",
                "avatarOriginalName": "",
                "avatarWidth": "",
                "avatarHeight": "",
            }, "$set": {"avatarUrl": ""}},
        )
        public_id = previous.get("avatarPublicId")
        if public_id:
            try:
                delete_media(public_id, "image")
            except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
                return Response({"avatarUrl": "", "cleanupWarning": True})
        return Response({"avatarUrl": "", "cleanupWarning": False})


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
        try:
            course = _ensure_course_assignment_ids(course)
        except (PyMongoError, RuntimeError):
            logger.exception("Could not ensure saved assignment IDs for course content.")
            return Response(
                {"message": "Course assignments could not be prepared for submission. Please reload the course."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            decorated = _decorate_enrollment(request.user, enrollment)
        except (AssignmentPolicyError, PyMongoError, RuntimeError):
            logger.exception("Could not load Hustler assignment deadlines and attempt status.")
            return Response(
                {"message": "Assignment deadline and attempt data could not be loaded. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        assignment_submissions = decorated["assignmentSubmissions"]
        quiz_attempts = decorated["quizAttempts"]
        public_course = decorated["courseId"]
        return Response({
            "course": public_course,
            "enrollment": {**decorated, "courseId": public_course},
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
            required_lessons = [
                lesson for lesson in lessons
                if lesson.get("requiredForCertificate") is not False
            ]
            completed_ids = set(map(str, enrollment.get("completedLessonIds", [])))
            pending = [
                {
                    "type": "video",
                    "id": str(lesson.get("_id")),
                    "title": lesson.get("title") or "Video lesson",
                }
                for lesson in required_lessons
                if lesson.get("_id") and str(lesson.get("_id")) not in completed_ids
            ]
            course_quizzes = [
                quiz for quiz in _course_quizzes(course)
                if quiz.get("requiredForCertificate") is not False
            ]
            for quiz in course_quizzes:
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
            course_assignments = [
                assignment for assignment in _course_assignments(course_id, course)
                if assignment.get("requiredForCertificate") is not False
            ]
            for assignment in course_assignments:
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
            if (
                raw_certificate is None
                and not pending
                and (required_lessons or course_quizzes or course_assignments)
                and course.get("generateCertificate") is not False
            ):
                try:
                    template = collection("certificate_templates").find_one({"_id": "active"})
                    completed_at = (
                        enrollment.get("completedAt")
                        or enrollment.get("updatedAt")
                        or datetime.now(timezone.utc)
                    )
                    raw_certificate = issue_course_completion_certificate(
                        collection("certificates"),
                        user_id=request.user.id,
                        student_name=request.user.name or "Student",
                        course_id=course_id,
                        course_name=course.get("title") or course.get("name") or "Course",
                        template=template,
                        completed_at=completed_at,
                    )
                except PyMongoError:
                    logger.exception("Could not issue a completed course certificate.")
                    return Response(
                        {"message": "A course completion certificate could not be generated right now."},
                        status=status.HTTP_503_SERVICE_UNAVAILABLE,
                    )
                certificates_by_course[course_key] = raw_certificate
            certificate = _document(raw_certificate)
            if certificate is not None:
                certificate.setdefault(
                    "certificateId",
                    certificate.get("certificate_id") or certificate.get("_id"),
                )
                certificate.setdefault("courseName", course.get("title") or course.get("name") or "Course")
                certificate.setdefault("completedAt", certificate.get("issuedAt") or certificate.get("issued_at"))
                certificate.pop("templateSnapshot", None)
                certificate.pop("renderVersion", None)
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
            {"$or": [
                {"_id": certificate_id},
                {"certificateId": certificate_id},
                {"certificate_id": certificate_id},
                *([{"_id": object_id}] if object_id else []),
            ]},
        )
        certificate = collection("certificates").find_one(query)
        if not certificate:
            return Response({"message": "Certificate not found."}, status=status.HTTP_404_NOT_FOUND)
        media_url = certificate.get("secureUrl") or certificate.get("fileUrl") or certificate.get("file_url")
        if media_url:
            if not is_cloudinary_delivery_url(media_url):
                return Response({"message": "Certificate PDF is unavailable."}, status=status.HTTP_404_NOT_FOUND)
            return HttpResponseRedirect(media_url)
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
        if certificate.get("renderVersion") == 1:
            try:
                pdf_bytes = render_certificate_pdf(certificate)
            except CertificateRenderError as exc:
                logger.exception("Could not render a student course completion certificate.")
                return Response(
                    {"message": str(exc)},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            filename_id = re.sub(
                r"[^A-Za-z0-9_-]",
                "",
                str(certificate.get("certificateId") or certificate_id),
            )
            response = HttpResponse(pdf_bytes, content_type="application/pdf")
            disposition = "attachment" if request.query_params.get("download") == "true" else "inline"
            response["Content-Disposition"] = f'{disposition}; filename="certificate-{filename_id}.pdf"'
            return response
        return Response({"message": "Certificate PDF is unavailable."}, status=status.HTTP_404_NOT_FOUND)


class NotificationsAPIView(APIView):
    permission_classes = [IsAuthenticated]

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if request.user.role not in {"student", "main_admin"}:
            self.permission_denied(
                request,
                message="Student or main administrator access is required.",
            )


class StudentNotificationsView(NotificationsAPIView):
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


class StudentNotificationActionView(NotificationsAPIView):
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


def _cleanup_unlinked_assignment_upload(metadata):
    try:
        delete_media(metadata["publicId"], metadata["resourceType"])
    except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
        logger.warning("Unable to clean up an unlinked Cloudinary assignment file.", exc_info=True)


def _assignment_submission_block(state_data):
    if state_data["hasPassed"]:
        return "This assignment has already been passed. Further submissions are disabled.", status.HTTP_409_CONFLICT
    if state_data["hasPendingGrading"]:
        return "Your previous submission is waiting for Admin review.", status.HTTP_409_CONFLICT
    if state_data["isLocked"]:
        return "All 3 attempts were failed. You can submit again after the 24-hour waiting period.", status.HTTP_429_TOO_MANY_REQUESTS
    if state_data["deadlineExpired"]:
        return "The 15-day assignment deadline has passed. New submissions are closed.", status.HTTP_410_GONE
    if state_data["remainingAttempts"] <= 0:
        return "All 3 attempts have been used. Wait for the 24-hour reset before submitting again.", status.HTTP_429_TOO_MANY_REQUESTS
    return None, None


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
        request_id = request.data.get("submissionRequestId")
        submission_id = _object_id(request_id) if request_id else None
        if request_id and submission_id is None:
            return Response(
                {"message": "The assignment submission request ID is invalid."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        is_hustler = _is_hustler_user(request.user)
        if is_hustler:
            submission_id = submission_id or ObjectId()
            existing_query = _combine(
                _user_query(request.user),
                {"_id": {"$in": [str(submission_id), submission_id]}},
                _course_query(course_id),
                {"$or": [
                    {"assignmentId": str(assignment_id)},
                    {"assignment_id": str(assignment_id)},
                ]},
            )
            for name in ("submissions", "assignment_submissions"):
                existing = collection(name).find_one(existing_query)
                if existing is not None:
                    return Response({"submission": _document(existing)})

        now = datetime.now(timezone.utc)
        policy_collection = None
        policy = None
        attempt_state = None
        if is_hustler:
            try:
                policy_collection = collection("assignment_attempt_policies")
                submission_collections = [
                    collection("submissions"),
                    collection("assignment_submissions"),
                ]
                policy = get_assignment_policy(
                    policy_collection,
                    submission_collections,
                    request.user.id,
                    course_id,
                    assignment_id,
                    enrollment,
                    now=now,
                )
                attempt_state = assignment_policy_status(policy, now=now)
                blocked_message, blocked_status = _assignment_submission_block(attempt_state)
                if blocked_message:
                    return Response(
                        {"message": blocked_message, "attemptState": attempt_state},
                        status=blocked_status,
                    )
                reserved_policy = policy_collection.find_one_and_update(
                    {
                        "_id": policy["_id"],
                        "activeSubmissionId": None,
                        "hasPassed": {"$ne": True},
                        "attemptsUsed": {"$lt": 3},
                        "deadlineAt": {"$gt": now},
                        "$or": [
                            {"lockoutUntil": None},
                            {"lockoutUntil": {"$lte": now}},
                        ],
                    },
                    {"$set": {
                        "activeSubmissionId": str(submission_id),
                        "updatedAt": now,
                    }},
                    return_document=ReturnDocument.AFTER,
                )
                if reserved_policy is None:
                    policy = policy_collection.find_one({"_id": policy["_id"]}) or policy
                    attempt_state = assignment_policy_status(policy, now=now)
                    blocked_message, blocked_status = _assignment_submission_block(attempt_state)
                    return Response(
                        {
                            "message": blocked_message or "Another submission is already being processed. Refresh and try again.",
                            "attemptState": attempt_state,
                        },
                        status=blocked_status or status.HTTP_409_CONFLICT,
                    )
                policy = reserved_policy
                attempt_state = assignment_policy_status(policy, now=now)
            except AssignmentPolicyError as exc:
                return Response({"message": str(exc)}, status=status.HTTP_409_CONFLICT)
            except (PyMongoError, RuntimeError):
                logger.exception("Could not reserve a Hustler assignment attempt.")
                return Response(
                    {"message": "Assignment attempt status could not be verified. Please try again."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )

        def release_reservation():
            if policy_collection is not None and policy is not None:
                try:
                    result = policy_collection.update_one(
                        {
                            "_id": policy["_id"],
                            "activeSubmissionId": str(submission_id),
                        },
                        {"$set": {"activeSubmissionId": None, "updatedAt": now}},
                    )
                except PyMongoError:
                    logger.exception("Could not release a failed assignment submission reservation.")
                    return False
                return result.modified_count == 1
            return True

        try:
            metadata = upload_media(
                uploaded_file,
                "assignment_submission",
                owner_id=request.user.id,
                course_id=course_id,
            )
        except MediaValidationError as exc:
            if not release_reservation():
                return Response(
                    {"message": "The file was rejected and the attempt reservation could not be released. Contact support before retrying."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            if not release_reservation():
                return Response(
                    {"message": "The upload failed and the attempt reservation could not be released. Contact support before retrying."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        submission = {
            "student_id": request.user.id,
            "studentId": request.user.id,
            "courseId": str(course_id),
            "assignment_id": str(assignment_id),
            "assignmentId": str(assignment_id),
            "fileUrl": metadata["secureUrl"],
            "filePublicId": metadata["publicId"],
            "fileResourceType": metadata["resourceType"],
            "fileFormat": metadata["format"],
            "fileName": metadata["originalName"],
            "fileType": uploaded_file.content_type or "application/octet-stream",
            "fileSize": metadata["bytes"],
            "status": "submitted",
            "submittedAt": now,
            "created_at": now,
            "createdAt": now,
        }
        if submission_id is not None:
            submission["_id"] = submission_id
        if is_hustler and policy is not None:
            submission.update({
                "reviewStatus": "pending",
                "attemptNumber": int(policy.get("attemptsUsed") or 0) + 1,
                "attemptCycle": int(policy.get("cycleNumber") or 1),
                "enrollmentAt": policy["enrollmentAt"],
                "deadlineAt": policy["deadlineAt"],
                "attemptState": attempt_state,
            })
        try:
            result = collection("submissions").insert_one(submission)
        except DuplicateKeyError:
            existing_query = _combine(
                _user_query(request.user),
                {"_id": submission_id},
                {"courseId": str(course_id)},
                {"$or": [
                    {"assignmentId": str(assignment_id)},
                    {"assignment_id": str(assignment_id)},
                ]},
            )
            existing = (
                collection("submissions").find_one(existing_query)
                if submission_id is not None
                else None
            )
            if existing is not None:
                if existing.get("filePublicId") != metadata["publicId"]:
                    _cleanup_unlinked_assignment_upload(metadata)
                return Response({"submission": _document(existing)})
            if not release_reservation():
                _cleanup_unlinked_assignment_upload(metadata)
                return Response(
                    {"message": "The submission could not be saved and the attempt reservation could not be released. Contact support before retrying."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            _cleanup_unlinked_assignment_upload(metadata)
            return Response(
                {"message": "This submission request conflicts with an existing submission."},
                status=status.HTTP_409_CONFLICT,
            )
        except (PyMongoError, RuntimeError):
            release_reservation()
            _cleanup_unlinked_assignment_upload(metadata)
            logger.exception("Could not save an assignment submission.")
            return Response(
                {"message": "The uploaded file could not be saved as an assignment submission. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        submission["_id"] = submission.get("_id") or result.inserted_id
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
        return Response(
            {"message": "AI re-evaluation requests are disabled. Assignment submissions are reviewed manually by an Admin."},
            status=status.HTTP_410_GONE,
        )


class StudentAssignmentDownloadView(StudentAPIView):
    def get(self, request, submission_id):
        object_id = _object_id(submission_id)
        submission = collection("submissions").find_one(
            _combine(_user_query(request.user), {"_id": object_id})
        ) if object_id else None
        if submission and submission.get("fileUrl"):
            if not is_cloudinary_delivery_url(submission["fileUrl"]):
                return Response({"message": "Assignment file not found."}, status=status.HTTP_404_NOT_FOUND)
            return HttpResponseRedirect(submission["fileUrl"])
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
    now = datetime.now(timezone.utc)
    policy = _quiz_attempt_policy(user, course_id, quiz_id, attempts, now)
    completed_ids = {str(value) for value in policy.get("completedAttemptIds", [])}
    passed = any(
        item.get("passed") is True
        and item.get("_id") is not None
        and str(item["_id"]) in completed_ids
        for item in attempts
    )
    locked_until = policy.get("lockedUntil")
    completed_count = min(
        QUIZ_MAX_COMPLETED_ATTEMPTS,
        max(0, int(policy.get("completedAttempts", 0) or 0)),
    )
    return {
        "maxAttempts": QUIZ_MAX_COMPLETED_ATTEMPTS,
        "attemptsUsed": completed_count,
        "attemptsRemaining": max(0, QUIZ_MAX_COMPLETED_ATTEMPTS - completed_count),
        "passed": passed,
        "lockedUntil": locked_until,
        "serverTime": now,
    }, attempts


def _quiz_pass_percentage(quiz):
    try:
        passing_percentage = float(quiz["passingPercentage"])
    except (KeyError, TypeError, ValueError):
        return None
    if not 1 <= passing_percentage <= 100:
        return None
    return passing_percentage


def _student_question(question):
    return {
        key: _id_value(value)
        for key, value in question.items()
        if key not in {"correctOptionIndices", "correctOptionIndex", "correctAnswer", "correctAnswerIndex", "answer"}
    }


def _validated_quiz_selection(question, selected):
    options = question.get("options")
    if not isinstance(selected, list) or not isinstance(options, list):
        return None
    if (
        any(type(index) is not int or index < 0 or index >= len(options) for index in selected)
        or len(set(selected)) != len(selected)
        or (question.get("type") != "multiple-select" and len(selected) > 1)
    ):
        return None
    return sorted(selected)


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

    def patch(self, request, course_id, quiz_id, attempt_id):
        enrollment, _course, quiz = self._context(request, course_id, quiz_id)
        if enrollment is None:
            return Response({"message": "Enrollment or quiz not found."}, status=status.HTTP_404_NOT_FOUND)
        object_id = _object_id(attempt_id)
        question_object_id = _object_id(request.data.get("questionId"))
        if object_id is None or question_object_id is None:
            return Response(
                {"message": "A valid quiz attempt and question ID are required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        attempt_query = _combine(
            _user_query(request.user),
            {"_id": object_id, "status": "started"},
            _course_query(course_id),
            {"quizId": str(quiz_id)},
        )
        attempts = collection("quiz_attempts")
        attempt = attempts.find_one(attempt_query)
        if attempt is None:
            return Response({"message": "Quiz attempt not found."}, status=status.HTTP_404_NOT_FOUND)
        quiz_status, user_attempts = _quiz_status(request.user, course_id, quiz_id, quiz)
        policy = _quiz_attempt_policy(request.user, course_id, quiz_id, user_attempts)
        if (
            quiz_status["attemptsRemaining"] <= 0
            or str(policy.get("activeAttemptId")) != str(object_id)
        ):
            return Response(
                {"message": "This quiz attempt is no longer active."},
                status=status.HTTP_409_CONFLICT,
            )

        question_id = str(question_object_id)
        question = next(
            (
                item for item in attempt.get("questions", [])
                if isinstance(item, dict)
                and str(_object_id(item.get("_id") or item.get("id"))) == question_id
            ),
            None,
        )
        if question is None:
            return Response(
                {"message": "Question not found in this quiz attempt."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        selected = _validated_quiz_selection(
            question,
            request.data.get("selectedOptionIndices"),
        )
        if selected is None:
            return Response(
                {"message": "The selected answer is invalid for this question."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        answer = {"questionId": question_id, "selectedOptionIndices": selected}
        existing_answer = any(
            isinstance(item, dict) and str(item.get("questionId")) == question_id
            for item in attempt.get("answers", [])
        )
        now = datetime.now(timezone.utc)
        if existing_answer:
            updated = attempts.find_one_and_update(
                _combine(attempt_query, {"answers.questionId": question_id}),
                {"$set": {
                    "answers.$.selectedOptionIndices": selected,
                    "updatedAt": now,
                }},
                return_document=ReturnDocument.AFTER,
            )
        else:
            updated = attempts.find_one_and_update(
                _combine(attempt_query, {"answers.questionId": {"$ne": question_id}}),
                {"$push": {"answers": answer}, "$set": {"updatedAt": now}},
                return_document=ReturnDocument.AFTER,
            )
            if updated is None:
                updated = attempts.find_one_and_update(
                    _combine(attempt_query, {"answers.questionId": question_id}),
                    {"$set": {
                        "answers.$.selectedOptionIndices": selected,
                        "updatedAt": now,
                    }},
                    return_document=ReturnDocument.AFTER,
                )
        if updated is None:
            return Response(
                {"message": "The quiz attempt is no longer active."},
                status=status.HTTP_409_CONFLICT,
            )
        return Response({"attempt": _public_quiz_attempt(updated), "answer": answer})

    def post(self, request, course_id, quiz_id, attempt_id=None):
        enrollment, course, quiz = self._context(request, course_id, quiz_id)
        if enrollment is None:
            return Response({"message": "Enrollment or quiz not found."}, status=status.HTTP_404_NOT_FOUND)
        quiz_status, attempts = _quiz_status(request.user, course_id, quiz_id, quiz)
        if attempt_id is None:
            if quiz_status["attemptsRemaining"] <= 0:
                return Response(
                    {"message": "No quiz attempts remain.", "quizStatus": quiz_status},
                    status=status.HTTP_423_LOCKED,
                )
            active = next((item for item in attempts if item.get("status") == "started"), None)
            if active is not None:
                active = _ensure_attempt_question_ids(active)
                if active is None:
                    return Response(
                        {"message": "The active quiz attempt changed. Reload the quiz and try again."},
                        status=status.HTTP_409_CONFLICT,
                    )
                questions = active.get("questions", [])
                return Response({
                    "attempt": _public_quiz_attempt(active),
                    "questions": [_student_question(item) for item in questions],
                    "quizStatus": quiz_status,
                })
            passing_percentage = _quiz_pass_percentage(quiz)
            if passing_percentage is None:
                return Response(
                    {"message": "The Admin must configure a valid passing percentage before this quiz can start."},
                    status=status.HTTP_409_CONFLICT,
                )
            questions = quiz.get("questions", [])
            if not isinstance(questions, list) or not questions:
                return Response({"message": "Quiz has no questions."}, status=status.HTTP_404_NOT_FOUND)
            snapshot = [dict(item) for item in questions if isinstance(item, dict)]
            if not snapshot:
                return Response({"message": "Quiz has no questions."}, status=status.HTTP_404_NOT_FOUND)
            _ensure_question_ids(snapshot)
            now = datetime.now(timezone.utc)
            policy = _quiz_attempt_policy(request.user, course_id, quiz_id, attempts, now)
            attempt_id = ObjectId()
            policy_update = collection("quiz_attempt_policies").find_one_and_update(
                {
                    "_id": policy["_id"],
                    "completedAttempts": {"$lt": QUIZ_MAX_COMPLETED_ATTEMPTS},
                    "lockedUntil": None,
                    "activeAttemptId": None,
                },
                {"$set": {"activeAttemptId": str(attempt_id), "updatedAt": now}},
                return_document=ReturnDocument.AFTER,
            )
            if policy_update is None:
                refreshed_status, refreshed_attempts = _quiz_status(
                    request.user,
                    course_id,
                    quiz_id,
                    quiz,
                )
                active = next(
                    (item for item in refreshed_attempts if item.get("status") == "started"),
                    None,
                )
                if active is not None:
                    return Response({
                        "attempt": _public_quiz_attempt(active),
                        "questions": [_student_question(item) for item in active.get("questions", [])],
                        "quizStatus": refreshed_status,
                    })
                return Response(
                    {"message": "No quiz attempts remain." if refreshed_status["attemptsRemaining"] <= 0 else "The quiz attempt could not be started. Please try again.", "quizStatus": refreshed_status},
                    status=status.HTTP_423_LOCKED if refreshed_status["attemptsRemaining"] <= 0 else status.HTTP_409_CONFLICT,
                )
            attempt = {
                "_id": attempt_id,
                "studentId": request.user.id,
                "courseId": str(course_id),
                "quizId": str(quiz_id),
                "enrollmentId": str(enrollment["_id"]),
                "status": "started",
                "startedAt": now,
                "createdAt": now,
                "timeLimitMinutes": int(quiz.get("timeLimitMinutes", 0) or 0),
                "passingPercentage": passing_percentage,
                "policyCycleId": policy["cycleId"],
                "questions": snapshot,
                "answers": [],
            }
            try:
                collection("quiz_attempts").insert_one(attempt)
            except (PyMongoError, RuntimeError):
                collection("quiz_attempt_policies").find_one_and_update(
                    {"_id": policy["_id"], "activeAttemptId": str(attempt_id)},
                    {"$set": {"activeAttemptId": None, "updatedAt": datetime.now(timezone.utc)}},
                    return_document=ReturnDocument.AFTER,
                )
                logger.exception("Could not save quiz attempt.")
                return Response(
                    {"message": "The quiz attempt could not be saved. Please try again."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            return Response({
                "attempt": _public_quiz_attempt(attempt),
                "questions": [_student_question(item) for item in snapshot],
                "quizStatus": _quiz_status(request.user, course_id, quiz_id, quiz)[0],
            }, status=status.HTTP_201_CREATED)

        object_id = _object_id(attempt_id)
        if object_id is None:
            return Response({"message": "Quiz attempt not found."}, status=status.HTTP_404_NOT_FOUND)
        attempt = collection("quiz_attempts").find_one(
            _combine(
                _user_query(request.user),
                {"_id": object_id, "quizId": str(quiz_id)},
                _course_query(course_id),
            )
        )
        if attempt is None or attempt.get("status") != "started":
            return Response({"message": "Quiz attempt not found."}, status=status.HTTP_404_NOT_FOUND)
        policy = _quiz_attempt_policy(request.user, course_id, quiz_id, attempts)
        if (
            quiz_status["attemptsRemaining"] <= 0
            or str(policy.get("activeAttemptId")) != str(object_id)
        ):
            return Response(
                {"message": "This quiz attempt is no longer available for submission.", "quizStatus": quiz_status},
                status=status.HTTP_423_LOCKED,
            )
        submitted_answers = request.data.get("answers")
        if not isinstance(submitted_answers, list):
            return Response({"message": "Quiz answers are required."}, status=status.HTTP_400_BAD_REQUEST)
        questions = [item for item in attempt.get("questions", []) if isinstance(item, dict)]
        questions_by_id = {}
        for question in questions:
            question_object_id = _object_id(question.get("_id") or question.get("id"))
            if question_object_id is None or str(question_object_id) in questions_by_id:
                return Response(
                    {"message": "The saved quiz questions have invalid or duplicate IDs."},
                    status=status.HTTP_409_CONFLICT,
                )
            questions_by_id[str(question_object_id)] = question

        answers_by_id = {}
        for answer in submitted_answers:
            if not isinstance(answer, dict):
                return Response({"message": "The quiz answers are invalid."}, status=status.HTTP_400_BAD_REQUEST)
            question_object_id = _object_id(answer.get("questionId"))
            if question_object_id is None:
                return Response(
                    {"message": "Each answer must include a valid question ID."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            question_id = str(question_object_id)
            if question_id not in questions_by_id or question_id in answers_by_id:
                return Response(
                    {"message": "The quiz contains an unknown or duplicate answer."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            selected = _validated_quiz_selection(
                questions_by_id[question_id],
                answer.get("selectedOptionIndices"),
            )
            if selected is None:
                return Response(
                    {"message": "A quiz answer contains invalid option selections."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            answers_by_id[question_id] = selected

        persisted_answers = {}
        for item in attempt.get("answers", []):
            if not isinstance(item, dict):
                continue
            persisted_id = _object_id(item.get("questionId"))
            if persisted_id is not None:
                if str(persisted_id) in persisted_answers:
                    return Response(
                        {"message": "The saved quiz attempt contains duplicate answers."},
                        status=status.HTTP_409_CONFLICT,
                    )
                persisted = _validated_quiz_selection(
                    questions_by_id.get(str(persisted_id), {}),
                    item.get("selectedOptionIndices"),
                )
                if persisted is None:
                    return Response(
                        {"message": "A saved quiz answer contains invalid option selections."},
                        status=status.HTTP_409_CONFLICT,
                    )
                persisted_answers[str(persisted_id)] = persisted

        if set(answers_by_id) != set(questions_by_id):
            return Response(
                {"message": "The final submission must include each quiz question exactly once."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if set(persisted_answers) != set(questions_by_id):
            return Response(
                {"message": "Save an answer for every question before submitting the quiz."},
                status=status.HTTP_409_CONFLICT,
            )
        score_points = 0.0
        total_points = 0.0
        correct_answer_count = 0
        saved_answers = []
        for question_index, question in enumerate(questions):
            question_id = str(_object_id(question.get("_id") or question.get("id")))
            selected = answers_by_id[question_id]
            persisted = persisted_answers.get(question_id, [])
            if not selected:
                return Response(
                    {"message": f"Answer Question {question_index + 1} before submitting the quiz."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if selected != persisted:
                return Response(
                    {"message": f"Save the answer for Question {question_index + 1} before submitting."},
                    status=status.HTTP_409_CONFLICT,
                )
            correct = question.get("correctOptionIndices")
            if correct is None and question.get("correctOptionIndex") is not None:
                correct = [question["correctOptionIndex"]]
            if correct is None and question.get("correctAnswerIndex") is not None:
                correct = [question["correctAnswerIndex"]]
            correct = correct if isinstance(correct, list) else [correct] if correct is not None else []
            options = question.get("options")
            if (
                not isinstance(options, list)
                or any(type(index) is not int for index in correct)
                or any(type(index) is not int or index < 0 or index >= len(options) for index in correct)
                or len(set(correct)) != len(correct)
                or (question.get("type") != "multiple-select" and len(correct) > 1)
            ):
                return Response(
                    {"message": "The quiz contains an invalid configured answer key."},
                    status=status.HTTP_409_CONFLICT,
                )
            correct = sorted(correct)
            selected = sorted(selected)
            try:
                points = float(question.get("marks", question.get("points", 1)))
            except (TypeError, ValueError):
                points = -1
            if not math.isfinite(points) or points < 0:
                return Response(
                    {"message": "The quiz contains invalid marks configured by the Admin."},
                    status=status.HTTP_409_CONFLICT,
                )
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
        pass_percentage = _quiz_pass_percentage(
            {"passingPercentage": attempt.get("passingPercentage", quiz.get("passingPercentage"))}
        )
        if pass_percentage is None:
            return Response(
                {"message": "The Admin has not configured a valid passing percentage for this quiz."},
                status=status.HTTP_409_CONFLICT,
            )
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
        try:
            _record_completed_quiz_attempt(
                request.user,
                course_id,
                quiz_id,
                updated,
                now,
            )
        except (PyMongoError, RuntimeError):
            logger.exception("Could not update the quiz attempt policy after submission.")
            return Response(
                {"message": "Your quiz was submitted, but the attempt policy update is pending. Refresh to check the result."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        updated_public = _document(updated)
        for question in updated_public.get("questions", []):
            if isinstance(question, dict):
                for key in ("correctOptionIndices", "correctOptionIndex", "correctAnswer", "correctAnswerIndex", "answer"):
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
        media_url = resource.get("secureUrl") or resource.get("url")
        if media_url and is_cloudinary_delivery_url(media_url):
            return HttpResponseRedirect(media_url)
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

