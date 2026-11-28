from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError


MAX_ASSIGNMENT_ATTEMPTS = 3
ASSIGNMENT_DEADLINE_DAYS = 15
ASSIGNMENT_COOLDOWN = timedelta(hours=24)


class AssignmentPolicyError(ValueError):
    pass


def _object_id(value):
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError):
        return None


def _id_values(value):
    if value is None:
        return []
    values = [str(value)]
    object_id = _object_id(value)
    if object_id is not None:
        values.append(object_id)
    return values


def _coerce_datetime(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (TypeError, ValueError):
        return None


def enrollment_started_at(enrollment):
    for key in ("createdAt", "created_at", "enrolledAt", "enrollmentDate"):
        value = _coerce_datetime(enrollment.get(key))
        if value is not None:
            return value

    enrollment_id = enrollment.get("_id")
    if isinstance(enrollment_id, ObjectId):
        return enrollment_id.generation_time
    raise AssignmentPolicyError("The enrollment timestamp is missing or invalid.")


def assignment_policy_id(student_id, course_id, assignment_id):
    return ":".join(map(str, (student_id, course_id, assignment_id)))


def _record_query(student_id, course_id, assignment_id):
    return {
        "$and": [
            {
                "$or": [
                    {field: value}
                    for field in ("studentId", "student_id", "userId", "user_id")
                    for value in _id_values(student_id)
                ]
            },
            {
                "$or": [
                    {field: value}
                    for field in ("courseId", "course_id")
                    for value in _id_values(course_id)
                ]
            },
            {
                "$or": [
                    {field: value}
                    for field in ("assignmentId", "assignment_id")
                    for value in _id_values(assignment_id)
                ]
            },
        ]
    }


def _review_result(record):
    review_status = str(record.get("reviewStatus") or "").strip().lower()
    if review_status in {"approved", "passed", "pass"}:
        return "passed"
    if review_status in {"rejected", "failed", "fail"}:
        return "failed"
    if not (
        record.get("reviewedAt")
        or record.get("reviewDate")
        or record.get("reviewedBy")
        or record.get("gradingStatus") == "Admin Reviewed"
    ):
        return None
    value = str(
        record.get("academicStatus")
        or record.get("status")
        or ""
    ).strip().lower()
    if value in {"approved", "passed", "pass"}:
        return "passed"
    if value in {"rejected", "failed", "fail"}:
        return "failed"
    return None


def _is_pending(record):
    status_value = str(record.get("status") or "").strip().lower()
    review_status = str(record.get("reviewStatus") or "").strip().lower()
    return (
        _review_result(record) is None
        and status_value in {"submitted", "pending"}
        and review_status in {"", "pending", "submitted"}
        and record.get("_id") is not None
    )


def _seed_policy(
    policy_id,
    student_id,
    course_id,
    assignment_id,
    enrollment,
    deadline_at,
    submission_collections,
    now,
):
    records = {}
    query = _record_query(student_id, course_id, assignment_id)
    for submissions in submission_collections:
        for record in submissions.find(query):
            records[str(record.get("_id") or id(record))] = record

    reviewed = [
        (record, _review_result(record))
        for record in records.values()
        if _review_result(record) is not None
    ]
    reviewed.sort(
        key=lambda item: _coerce_datetime(
            item[0].get("reviewedAt")
            or item[0].get("reviewDate")
            or item[0].get("submittedAt")
            or item[0].get("createdAt")
        )
        or datetime.min.replace(tzinfo=timezone.utc)
    )

    cycle_number = 1
    attempts_used = 0
    failed_attempts = 0
    has_passed = False
    lockout_until = None
    for record, result in reviewed:
        reviewed_at = (
            _coerce_datetime(
                record.get("reviewedAt")
                or record.get("reviewDate")
                or record.get("submittedAt")
                or record.get("createdAt")
            )
            or now
        )
        if lockout_until and reviewed_at >= lockout_until:
            cycle_number += 1
            attempts_used = 0
            failed_attempts = 0
            lockout_until = None
        if result == "passed":
            attempts_used += 1
            has_passed = True
            failed_attempts = 0
            break
        if result == "failed":
            if lockout_until is not None:
                continue
            attempts_used += 1
            failed_attempts += 1
            if attempts_used == MAX_ASSIGNMENT_ATTEMPTS:
                lockout_until = reviewed_at + ASSIGNMENT_COOLDOWN

    pending = [
        record for record in records.values()
        if _is_pending(record)
    ]
    pending.sort(
        key=lambda record: _coerce_datetime(
            record.get("submittedAt") or record.get("createdAt")
        ) or datetime.min.replace(tzinfo=timezone.utc)
    )
    active_submission_id = str(pending[-1]["_id"]) if pending else None
    return {
        "_id": policy_id,
        "studentId": str(student_id),
        "courseId": str(course_id),
        "assignmentId": str(assignment_id),
        "enrollmentId": str(enrollment.get("_id") or ""),
        "enrollmentAt": enrollment_started_at(enrollment),
        "deadlineAt": deadline_at,
        "cycleNumber": cycle_number,
        "attemptsUsed": attempts_used,
        "failedAttempts": failed_attempts,
        "hasPassed": has_passed,
        "lockoutUntil": lockout_until,
        "activeSubmissionId": active_submission_id,
        "createdAt": now,
        "updatedAt": now,
    }


def _refresh_expired_lockout(policies, policy, now):
    lockout_until = _coerce_datetime(policy.get("lockoutUntil"))
    if (
        lockout_until is None
        or lockout_until > now
        or policy.get("hasPassed") is True
    ):
        return policy
    refreshed = policies.find_one_and_update(
        {
            "_id": policy["_id"],
            "cycleNumber": policy.get("cycleNumber", 1),
            "lockoutUntil": policy.get("lockoutUntil"),
        },
        {
            "$set": {
                "attemptsUsed": 0,
                "failedAttempts": 0,
                "lockoutUntil": None,
                "updatedAt": now,
            },
            "$inc": {"cycleNumber": 1},
        },
        return_document=ReturnDocument.AFTER,
    )
    if refreshed is not None:
        return refreshed
    return policies.find_one({"_id": policy["_id"]}) or policy


def _sync_reviewed_active_submission(policies, submission_collections, policy, now):
    active_submission_id = policy.get("activeSubmissionId")
    if not active_submission_id or policy.get("lastReviewedSubmissionId") == str(active_submission_id):
        return policy
    active_values = _id_values(active_submission_id)
    record = None
    for submissions in submission_collections:
        record = submissions.find_one({"_id": {"$in": active_values}})
        if record is not None:
            break
    result = _review_result(record or {})
    if result is None:
        return policy

    reviewed_at = (
        _coerce_datetime(
            record.get("reviewedAt")
            or record.get("reviewDate")
            or record.get("submittedAt")
        )
        or now
    )
    attempts_used = int(policy.get("attemptsUsed") or 0) + 1
    failed_attempts = int(policy.get("failedAttempts") or 0) + 1 if result == "failed" else 0
    lockout_until = (
        reviewed_at + ASSIGNMENT_COOLDOWN
        if result == "failed" and attempts_used >= MAX_ASSIGNMENT_ATTEMPTS
        else None
    )
    updated = policies.find_one_and_update(
        {
            "_id": policy["_id"],
            "activeSubmissionId": str(active_submission_id),
            "attemptsUsed": policy.get("attemptsUsed", 0),
            "cycleNumber": policy.get("cycleNumber", 1),
            "hasPassed": {"$ne": True},
        },
        {"$set": {
            "attemptsUsed": attempts_used,
            "failedAttempts": failed_attempts,
            "hasPassed": result == "passed",
            "lockoutUntil": lockout_until,
            "activeSubmissionId": None,
            "lastReviewedSubmissionId": str(active_submission_id),
            "lastReviewResult": result,
            "lastReviewedAt": reviewed_at,
            "updatedAt": now,
        }},
        return_document=ReturnDocument.AFTER,
    )
    if updated is not None:
        return updated
    return policies.find_one({"_id": policy["_id"]}) or policy


def get_assignment_policy(
    policies,
    submission_collections,
    student_id,
    course_id,
    assignment_id,
    enrollment,
    now=None,
):
    now = now or datetime.now(timezone.utc)
    enrollment_at = enrollment_started_at(enrollment)
    deadline_at = enrollment_at + timedelta(days=ASSIGNMENT_DEADLINE_DAYS)
    policy_id = assignment_policy_id(student_id, course_id, assignment_id)
    policy = policies.find_one({"_id": policy_id})
    if policy is None:
        initial = _seed_policy(
            policy_id,
            student_id,
            course_id,
            assignment_id,
            enrollment,
            deadline_at,
            submission_collections,
            now,
        )
        try:
            policy = policies.find_one_and_update(
                {"_id": policy_id},
                {"$setOnInsert": initial},
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )
        except DuplicateKeyError:
            policy = policies.find_one({"_id": policy_id})
        if policy is None:
            policy = policies.find_one({"_id": policy_id})
        if policy is None:
            raise RuntimeError("The assignment attempt policy could not be saved.")

    if (
        policy.get("enrollmentAt") != enrollment_at
        or policy.get("deadlineAt") != deadline_at
    ):
        policy = policies.find_one_and_update(
            {"_id": policy_id},
            {"$set": {
                "enrollmentId": str(enrollment.get("_id") or ""),
                "enrollmentAt": enrollment_at,
                "deadlineAt": deadline_at,
                "updatedAt": now,
            }},
            return_document=ReturnDocument.AFTER,
        ) or policies.find_one({"_id": policy_id})
        if policy is None:
            raise RuntimeError("The assignment deadline could not be refreshed.")

    policy = _sync_reviewed_active_submission(
        policies,
        submission_collections,
        policy,
        now,
    )
    return _refresh_expired_lockout(policies, policy, now)


def assignment_policy_status(policy, now=None):
    now = now or datetime.now(timezone.utc)
    deadline_at = _coerce_datetime(policy.get("deadlineAt"))
    lockout_until = _coerce_datetime(policy.get("lockoutUntil"))
    if deadline_at is None:
        raise AssignmentPolicyError("The assignment deadline is missing or invalid.")
    attempts_used = int(policy.get("attemptsUsed") or 0)
    failed_attempts = int(policy.get("failedAttempts") or 0)
    has_passed = policy.get("hasPassed") is True
    has_pending = bool(policy.get("activeSubmissionId"))
    is_locked = bool(lockout_until and lockout_until > now)
    is_expired = deadline_at <= now
    remaining_attempts = max(0, MAX_ASSIGNMENT_ATTEMPTS - attempts_used)
    return {
        "maxAttempts": MAX_ASSIGNMENT_ATTEMPTS,
        "attemptsUsed": attempts_used,
        "failedAttempts": failed_attempts,
        "remainingAttempts": remaining_attempts,
        "currentAttemptNumber": attempts_used,
        "nextAttemptNumber": attempts_used + 1,
        "hasPassed": has_passed,
        "hasPendingGrading": has_pending,
        "hasPendingHumanReview": False,
        "isLocked": is_locked,
        "lockoutUntil": lockout_until.isoformat() if lockout_until else None,
        "deadlineAt": deadline_at.isoformat(),
        "serverNow": now.isoformat(),
        "deadlineRemainingSeconds": max(0, int((deadline_at - now).total_seconds())),
        "deadlineExpired": is_expired,
        "canSubmit": (
            not has_passed
            and not has_pending
            and not is_locked
            and not is_expired
            and remaining_attempts > 0
        ),
    }
