import logging
import math
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from bson.errors import InvalidId
from django.http import FileResponse, HttpResponseRedirect
from gridfs import GridFSBucket
from gridfs.errors import NoFile
from pymongo import ReturnDocument
from pymongo.errors import PyMongoError
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from authentication.approval import is_hustler_account
from authentication.permissions import IsMainAdmin
from core.assignment_attempts import (
    AssignmentPolicyError,
    assignment_policy_status,
    get_assignment_policy,
)
from core.cloudinary_storage import is_cloudinary_delivery_url
from core.mongodb import collection, get_database


logger = logging.getLogger(__name__)


class AssignmentReviewSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=("approved", "rejected"))
    marks = serializers.FloatField(min_value=0)
    feedback = serializers.CharField(max_length=5000, trim_whitespace=True)


def _object_id(value):
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError):
        return None


def _id_values(value):
    values = [str(value)] if value is not None else []
    object_id = _object_id(value)
    if object_id is not None:
        values.append(object_id)
    return values


def _find_course(course_id):
    for candidate in _id_values(course_id):
        course = collection("courses").find_one({"_id": candidate})
        if course is not None:
            return course
    return None


def _find_assignment(course, assignment_id):
    target_id = str(assignment_id or "")
    for assignment in course.get("assignments", []) or []:
        if isinstance(assignment, dict) and str(assignment.get("_id") or assignment.get("id")) == target_id:
            return assignment
    for module in course.get("modules", []) or []:
        if not isinstance(module, dict):
            continue
        candidates = list(module.get("assignments", []) or [])
        for item in module.get("contentItems", []) or []:
            if not isinstance(item, dict) or str(item.get("type", "")).lower() != "assignment":
                continue
            nested = item.get("assignment")
            candidates.append({**nested, **item} if isinstance(nested, dict) else item)
        for assignment in candidates:
            if isinstance(assignment, dict) and str(assignment.get("_id") or assignment.get("id")) == target_id:
                return assignment
    course_id = course.get("_id")
    course_ids = _id_values(course_id)
    assignment_ids = _id_values(assignment_id)
    if course_ids and assignment_ids:
        return collection("assignments").find_one({
            "$and": [
                {"$or": [{"_id": value} for value in assignment_ids]},
                {"$or": [
                    {"courseId": {"$in": course_ids}},
                    {"course_id": {"$in": course_ids}},
                ]},
            ]
        })
    return None


def _assignment_total_marks(assignment):
    value = assignment.get("points")
    if value is None:
        value = assignment.get("maximumMarks")
    if value is None:
        value = assignment.get("maximum_marks")
    return 100 if value is None else value


def _assignment_passing_marks(assignment):
    value = assignment.get("passingMarks")
    return assignment.get("passing_marks") if value is None else value


def _student_for_submission(submission):
    student_values = []
    for field in ("studentId", "student_id", "userId", "user_id"):
        value = submission.get(field)
        student_values.extend(_id_values(value))
    if not student_values:
        return None
    clauses = [{"_id": value} for value in dict.fromkeys(student_values)]
    user = collection("users").find_one({"$or": clauses})
    return user if is_hustler_account(user) else None


def _find_enrollment(student_id, course_id):
    student_values = _id_values(student_id)
    course_values = _id_values(course_id)
    if not student_values or not course_values:
        return None
    return collection("enrollments").find_one({
        "$and": [
            {
                "$or": [
                    {field: value}
                    for field in ("studentId", "student_id", "userId", "user_id")
                    for value in student_values
                ]
            },
            {
                "$or": [
                    {field: value}
                    for field in ("courseId", "course_id")
                    for value in course_values
                ]
            },
        ]
    })


def _public_review(submission):
    student = _student_for_submission(submission)
    if student is None:
        return None
    course_id = submission.get("courseId") or submission.get("course_id")
    assignment_id = submission.get("assignmentId") or submission.get("assignment_id")
    course = _find_course(course_id) if course_id else None
    assignment = _find_assignment(course, assignment_id) if course and assignment_id else None
    if course is None or assignment is None:
        return None
    record = dict(submission)
    submission_id = str(record.get("_id") or "")
    marks = record.get("finalMarks", record.get("marksObtained"))
    maximum_marks = _assignment_total_marks(assignment)
    return {
        "id": submission_id,
        "studentId": str(student.get("_id") or ""),
        "studentName": student.get("fullName") or student.get("full_name") or student.get("name") or student.get("email") or "Hustler student",
        "studentEmail": student.get("email", ""),
        "courseId": str(course.get("_id") or course_id),
        "courseName": course.get("title") or course.get("name") or "Course",
        "assignmentId": str(assignment_id),
        "assignmentTitle": assignment.get("title") or assignment.get("name") or "Assignment",
        "instructions": assignment.get("description") or assignment.get("content") or "",
        "submittedAt": record.get("submittedAt") or record.get("createdAt") or record.get("created_at"),
        "fileName": record.get("fileName") or "Submission file",
        "fileType": record.get("fileType") or "application/octet-stream",
        "fileUrl": record.get("fileUrl"),
        "status": record.get("reviewStatus") or record.get("status") or "submitted",
        "marks": marks,
        "maximumMarks": maximum_marks,
        "passingMarks": _assignment_passing_marks(assignment),
        "attemptNumber": record.get("attemptNumber"),
        "feedback": record.get("reviewComment") or record.get("feedback") or "",
        "reviewedAt": record.get("reviewedAt"),
        "deadlineAt": record.get("deadlineAt"),
    }


class AdminAssignmentReviewListView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]

    def get(self, request):
        try:
            records = {}
            for name in ("submissions", "assignment_submissions"):
                cursor = collection(name).find().sort(
                    [("submittedAt", -1), ("createdAt", -1)]
                )
                for submission in cursor:
                    records[str(submission.get("_id") or id(submission))] = submission
            reviews = [
                review
                for submission in records.values()
                if (review := _public_review(submission)) is not None
            ]
        except (PyMongoError, RuntimeError):
            logger.exception("Could not load Hustler assignment submissions for review.")
            return Response(
                {"message": "Assignment submissions could not be loaded. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response({"reviews": reviews})


class AdminAssignmentReviewDetailView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]

    def put(self, request, submission_id):
        object_id = _object_id(submission_id)
        if object_id is None:
            return Response({"message": "Assignment submission not found."}, status=status.HTTP_404_NOT_FOUND)
        serializer = AssignmentReviewSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        submissions = collection("submissions")
        query = {"_id": object_id}
        try:
            submission = submissions.find_one(query)
            if submission is None:
                return Response({"message": "Assignment submission not found."}, status=status.HTTP_404_NOT_FOUND)
            if _student_for_submission(submission) is None:
                return Response({"message": "Only Hustler student assignments can be reviewed here."}, status=status.HTTP_404_NOT_FOUND)
            if str(submission.get("reviewStatus") or "").lower() in {"approved", "rejected"}:
                return Response(
                    {"message": "This assignment submission has already been reviewed."},
                    status=status.HTTP_409_CONFLICT,
                )
            course_id = submission.get("courseId") or submission.get("course_id")
            assignment_id = submission.get("assignmentId") or submission.get("assignment_id")
            course = _find_course(course_id) if course_id else None
            assignment = _find_assignment(course, assignment_id) if course and assignment_id else None
            if assignment is None:
                return Response({"message": "The assignment details could not be found."}, status=status.HTTP_404_NOT_FOUND)
            maximum_marks = _assignment_total_marks(assignment)
            try:
                maximum_marks = float(maximum_marks)
            except (TypeError, ValueError):
                maximum_marks = 0
            passing_marks = _assignment_passing_marks(assignment)
            try:
                passing_marks = float(passing_marks)
            except (TypeError, ValueError):
                passing_marks = 0
            if (
                not math.isfinite(maximum_marks)
                or maximum_marks <= 0
                or not math.isfinite(passing_marks)
                or passing_marks <= 0
                or passing_marks > maximum_marks
            ):
                return Response(
                    {"message": "Configure valid passing marks for this assignment in course settings before reviewing it."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            values = serializer.validated_data
            marks = values["marks"]
            if not math.isfinite(marks) or marks < 0 or marks > maximum_marks:
                return Response(
                    {"message": "Marks must be between 0 and the assignment's maximum points."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            now = datetime.now(timezone.utc)
            decision = "approved" if marks >= passing_marks else "rejected"
            if values["decision"] != decision:
                expected_label = "Approve" if decision == "approved" else "Reject"
                return Response(
                    {"message": f"These marks are below the passing mark of {passing_marks:g}. Choose {expected_label} to save this result."}
                    if decision == "rejected"
                    else {"message": f"These marks meet the passing mark of {passing_marks:g}. Choose {expected_label} to save this result."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            student_id = (
                submission.get("studentId")
                or submission.get("student_id")
                or submission.get("userId")
                or submission.get("user_id")
            )
            enrollment = _find_enrollment(student_id, course_id)
            if enrollment is None:
                return Response({"message": "The student's course enrollment could not be found."}, status=status.HTTP_404_NOT_FOUND)
            policies = collection("assignment_attempt_policies")
            submission_collections = [
                submissions,
                collection("assignment_submissions"),
            ]
            try:
                policy = get_assignment_policy(
                    policies,
                    submission_collections,
                    student_id,
                    course_id,
                    assignment_id,
                    enrollment,
                    now=now,
                )
            except AssignmentPolicyError as exc:
                return Response({"message": str(exc)}, status=status.HTTP_409_CONFLICT)
            if policy.get("hasPassed") is True:
                return Response(
                    {"message": "This assignment has already been passed."},
                    status=status.HTTP_409_CONFLICT,
                )
            active_submission_id = policy.get("activeSubmissionId")
            if active_submission_id not in {None, str(object_id)}:
                return Response(
                    {"message": "Review the student's other pending submission first."},
                    status=status.HTTP_409_CONFLICT,
                )
            if active_submission_id is None:
                policy = policies.find_one_and_update(
                    {
                        "_id": policy["_id"],
                        "activeSubmissionId": None,
                        "hasPassed": {"$ne": True},
                    },
                    {"$set": {
                        "activeSubmissionId": str(object_id),
                        "updatedAt": now,
                    }},
                    return_document=ReturnDocument.AFTER,
                ) or policies.find_one({"_id": policy["_id"]}) or policy
                if policy.get("activeSubmissionId") != str(object_id):
                    return Response(
                        {"message": "The assignment attempt changed during review. Refresh the submission and try again."},
                        status=status.HTTP_409_CONFLICT,
                    )
            attempt_number = int(submission.get("attemptNumber") or policy.get("attemptsUsed", 0) + 1)
            attempt_cycle = int(submission.get("attemptCycle") or policy.get("cycleNumber", 1))
            update = {
                "reviewStatus": decision,
                "status": decision,
                "academicStatus": "Passed" if decision == "approved" else "Failed",
                "finalMarks": marks,
                "marksObtained": marks,
                "maximumMarks": maximum_marks,
                "passingMarks": passing_marks,
                "reviewComment": values["feedback"],
                "feedback": values["feedback"],
                "reviewedAt": now,
                "reviewDate": now,
                "reviewedBy": str(request.user.id),
                "gradingStatus": "Admin Reviewed",
                "attemptNumber": attempt_number,
                "attemptCycle": attempt_cycle,
                "deadlineAt": policy["deadlineAt"],
            }
            updated = submissions.find_one_and_update(
                {
                    "_id": object_id,
                    "status": {"$in": ["submitted", "pending"]},
                    "$or": [
                        {"reviewStatus": {"$in": ["pending", "submitted"]}},
                        {"reviewStatus": {"$exists": False}},
                    ],
                },
                {"$set": update},
                return_document=ReturnDocument.AFTER,
            )
            if updated is None:
                return Response(
                    {"message": "This assignment submission has already been reviewed or is no longer pending."},
                    status=status.HTTP_409_CONFLICT,
                )
            policy = get_assignment_policy(
                policies,
                submission_collections,
                student_id,
                course_id,
                assignment_id,
                enrollment,
                now=now,
            )
            if policy.get("lastReviewedSubmissionId") != str(object_id):
                logger.error("Assignment review was saved but its attempt policy could not be updated.")
                return Response(
                    {"message": "The review was saved, but attempt status could not be updated. Refresh and retry."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            updated["attemptState"] = assignment_policy_status(policy, now=now)
        except (PyMongoError, RuntimeError):
            logger.exception("Could not save an Admin assignment review.")
            return Response(
                {"message": "The assignment review could not be saved. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        review = _public_review(updated)
        if review is None:
            return Response({"message": "The reviewed submission is not available."}, status=status.HTTP_404_NOT_FOUND)
        return Response({"review": review})


class AdminAssignmentReviewFileView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]

    def get(self, request, submission_id):
        object_id = _object_id(submission_id)
        submission = collection("submissions").find_one({"_id": object_id}) if object_id else None
        if submission is None or _student_for_submission(submission) is None:
            return Response({"message": "Assignment file not found."}, status=status.HTTP_404_NOT_FOUND)
        if submission.get("fileUrl"):
            if not is_cloudinary_delivery_url(submission["fileUrl"]):
                return Response({"message": "Assignment file not found."}, status=status.HTTP_404_NOT_FOUND)
            return HttpResponseRedirect(submission["fileUrl"])
        file_id = _object_id(submission.get("fileId"))
        if file_id is None:
            return Response({"message": "Assignment file not found."}, status=status.HTTP_404_NOT_FOUND)
        try:
            stream = GridFSBucket(get_database()).open_download_stream(file_id)
        except NoFile:
            return Response({"message": "Assignment file not found."}, status=status.HTTP_404_NOT_FOUND)
        except (PyMongoError, RuntimeError):
            logger.exception("Could not retrieve an Admin assignment file.")
            return Response(
                {"message": "The assignment file could not be retrieved. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return FileResponse(
            stream,
            as_attachment=True,
            filename=Path(submission.get("fileName") or "submission").name,
            content_type=submission.get("fileType") or "application/octet-stream",
        )
