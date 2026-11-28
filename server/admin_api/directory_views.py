import logging
import math
import re
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from pymongo import ReturnDocument
from pymongo.errors import PyMongoError
from rest_framework import serializers, status
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from authentication.permissions import IsMainAdmin
from core.mongodb import collection


logger = logging.getLogger(__name__)


class StudentDirectoryQuerySerializer(serializers.Serializer):
    page = serializers.IntegerField(min_value=1, default=1, required=False)
    pageSize = serializers.IntegerField(min_value=1, max_value=100, default=25, required=False)
    tab = serializers.ChoiceField(
        choices=("all", "independent", "college"),
        default="all",
        required=False,
    )
    filterType = serializers.ChoiceField(
        choices=("all", "independent", "college"),
        default="all",
        required=False,
    )
    search = serializers.CharField(required=False, allow_blank=True, max_length=200)
    collegeId = serializers.CharField(required=False, allow_blank=True, max_length=100)


class AdminDirectoryResponseSerializer(serializers.Serializer):
    students = serializers.ListField(child=serializers.DictField(), required=False)
    colleges = serializers.ListField(child=serializers.DictField(), required=False)
    courses = serializers.ListField(child=serializers.DictField(), required=False)
    enrollments = serializers.ListField(child=serializers.DictField(), required=False)
    stats = serializers.DictField(required=False)
    total = serializers.IntegerField(required=False)
    page = serializers.IntegerField(required=False)
    pageSize = serializers.IntegerField(required=False)


class AdminCourseWriteSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=200)
    description = serializers.CharField(min_length=10, max_length=1000)
    detailedDescription = serializers.CharField(required=False, allow_blank=True, max_length=10000)
    category = serializers.CharField(max_length=100, required=False, default="Other")
    difficulty = serializers.ChoiceField(
        choices=("beginner", "intermediate", "advanced", "all-levels"),
        required=False,
        default="beginner",
    )
    thumbnailUrl = serializers.URLField(required=False, allow_blank=True, max_length=2048)
    thumbnailPublicId = serializers.CharField(required=False, allow_blank=True, max_length=255)
    learningObjectives = serializers.ListField(
        child=serializers.CharField(), required=False, default=list
    )
    prerequisites = serializers.ListField(
        child=serializers.CharField(), required=False, default=list
    )
    tags = serializers.ListField(child=serializers.CharField(), required=False, default=list)
    skills = serializers.ListField(child=serializers.CharField(), required=False, default=list)
    practicalBenefits = serializers.ListField(
        child=serializers.CharField(), required=False, default=list
    )
    estimatedDurationMinutes = serializers.IntegerField(min_value=0, required=False, default=0)
    generateCertificate = serializers.BooleanField(required=False, default=True)
    assignments = serializers.ListField(
        child=serializers.DictField(), required=False, default=list
    )
    quizzes = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    status = serializers.ChoiceField(
        choices=("draft", "published"), required=False, default="draft"
    )
    modules = serializers.ListField(child=serializers.DictField(), required=False, default=list)

    def validate(self, attrs):
        issues = []

        def validate_assignment(assignment, label):
            total_value = assignment.get("points")
            if total_value is None:
                total_value = assignment.get("maximumMarks")
            if total_value is None:
                total_value = assignment.get("maximum_marks", 100)
            try:
                total_marks = float(total_value)
            except (TypeError, ValueError):
                total_marks = 0
            if isinstance(total_value, bool) or not math.isfinite(total_marks) or total_marks <= 0:
                issues.append(f"{label}: total marks must be greater than zero.")
                return

            passing_value = assignment.get("passingMarks", assignment.get("passing_marks"))
            if passing_value is None or passing_value == "":
                return
            try:
                passing_marks = float(passing_value)
            except (TypeError, ValueError):
                passing_marks = 0
            if (
                isinstance(passing_value, bool)
                or not math.isfinite(passing_marks)
                or passing_marks <= 0
                or passing_marks > total_marks
            ):
                issues.append(
                    f"{label}: passing marks must be greater than zero and no higher than total marks."
                )

        for index, assignment in enumerate(attrs.get("assignments", []), start=1):
            validate_assignment(assignment, f"Course-level assignment {index}")
        for module_index, module in enumerate(attrs.get("modules", []), start=1):
            module_assignments = module.get("assignments") or []
            if not isinstance(module_assignments, list):
                issues.append(f"Module {module_index} assignments must be a list.")
                module_assignments = []
            for assignment_index, assignment in enumerate(module_assignments, start=1):
                if not isinstance(assignment, dict):
                    issues.append(f"Module {module_index} assignment {assignment_index} must be an object.")
                    continue
                validate_assignment(
                    assignment,
                    f"Module {module_index} assignment {assignment_index}",
                )
            content_items = module.get("contentItems") or []
            if not isinstance(content_items, list):
                issues.append(f"Module {module_index} content items must be a list.")
                content_items = []
            for item_index, item in enumerate(content_items, start=1):
                if not isinstance(item, dict):
                    issues.append(f"Module {module_index} content item {item_index} must be an object.")
                    continue
                if str(item.get("type", "")).lower() == "assignment":
                    validate_assignment(
                        item,
                        f"Module {module_index} item {item_index}",
                    )

        if issues:
            raise serializers.ValidationError({"assignmentMarks": issues})
        return attrs


class AdminCourseStatusSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=("draft", "published"))


def _id_string(value):
    return str(value) if value is not None else ""


def _json_value(value):
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return value


def _student_type(user):
    student_type = user.get("studentType") or user.get("student_type")
    if student_type in {"college", "independent"}:
        return student_type
    return "college" if user.get("collegeId") or user.get("college_id") else "independent"


def _student_query(validated_data):
    clauses = [{"role": "student"}]
    student_type = validated_data.get("filterType")
    tab = validated_data.get("tab")
    if student_type == "all":
        student_type = tab
    if student_type == "independent":
        clauses.append({
            "$and": [
                {
                    "$or": [
                        {"studentType": "independent"},
                        {"student_type": "independent"},
                        {"accountType": {"$in": ["hustler", "external", "independent"]}},
                        {"account_type": {"$in": ["hustler", "external", "independent"]}},
                    ]
                },
                {"studentType": {"$ne": "college"}},
                {"student_type": {"$ne": "college"}},
            ]
        })
    elif student_type == "college":
        clauses.append({
            "$or": [
                {"studentType": "college"},
                {"student_type": "college"},
                {"collegeId": {"$exists": True}},
                {"college_id": {"$exists": True}},
            ]
        })

    college_id = validated_data.get("collegeId", "").strip()
    if college_id:
        try:
            object_id = ObjectId(college_id)
        except (InvalidId, TypeError):
            object_id = None
        ids = [college_id]
        if object_id is not None:
            ids.append(object_id)
        clauses.append({
            "$or": [
                {field: value}
                for field in ("collegeId", "college_id")
                for value in ids
            ]
        })

    search = validated_data.get("search", "").strip()
    if search:
        expression = re.escape(search)
        clauses.append({
            "$or": [
                {field: {"$regex": expression, "$options": "i"}}
                for field in (
                    "name",
                    "fullName",
                    "full_name",
                    "email",
                    "username",
                    "studentId",
                    "student_id",
                )
            ]
        })
    return {"$and": clauses}


def _public_student(user):
    college_id = user.get("collegeId") or user.get("college_id")
    return {
        "_id": _id_string(user.get("_id")),
        "id": _id_string(user.get("_id")),
        "fullName": user.get("fullName") or user.get("full_name") or user.get("name") or "",
        "name": user.get("name") or user.get("fullName") or user.get("full_name") or "",
        "email": user.get("email", ""),
        "username": user.get("username", ""),
        "studentType": _student_type(user),
        "studentId": user.get("studentId") or user.get("student_id") or "",
        "collegeId": _id_string(college_id) if college_id else "",
        "approvalStatus": user.get("approvalStatus") or user.get("approval_status"),
        "status": user.get("status", "active"),
        "createdAt": user.get("createdAt") or user.get("created_at"),
        "department": user.get("department", ""),
        "batch": user.get("batch", ""),
    }


class AdminStudentDirectoryView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = StudentDirectoryQuerySerializer

    def get(self, request):
        serializer = self.get_serializer(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        query = _student_query(values)
        page = values["page"]
        page_size = values["pageSize"]
        students = collection("users")
        cursor = students.find(
            query,
            {"password": 0, "password_hash": 0, "passwordHash": 0},
        ).sort([("createdAt", -1), ("created_at", -1)])
        records = cursor.skip((page - 1) * page_size).limit(page_size)
        return Response({
            "students": [_public_student(record) for record in records],
            "total": students.count_documents(query),
            "page": page,
            "pageSize": page_size,
        })


class AdminCollegeDirectoryView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = AdminDirectoryResponseSerializer

    def get(self, request):
        records = collection("colleges").find().limit(1000)
        colleges = []
        for record in records:
            college = _json_value(dict(record))
            college_id = _id_string(college.get("_id"))
            college["_id"] = college_id
            college["id"] = college_id
            college.setdefault("status", "active")
            colleges.append(college)
        return Response({"colleges": colleges})


def _public_course(course):
    result = _json_value(dict(course))
    course_id = _id_string(result.get("_id"))
    result["_id"] = course_id
    result["id"] = course_id
    result.setdefault("title", result.get("name", ""))
    result.setdefault("status", "draft")
    return result


def _ensure_saved_quiz_id(quiz):
    quiz.pop("_localId", None)
    try:
        quiz_id = ObjectId(str(quiz.get("_id"))) if quiz.get("_id") else None
    except (InvalidId, TypeError):
        quiz_id = None
    quiz["_id"] = quiz_id or ObjectId()
    used_question_ids = set()
    for question in quiz.get("questions", []) or []:
        if not isinstance(question, dict):
            continue
        question.pop("_localId", None)
        question_id = question.get("_id") or question.get("id")
        try:
            question_id = ObjectId(str(question_id)) if question_id else None
        except (InvalidId, TypeError):
            question_id = None
        if question_id is None or str(question_id) in used_question_ids:
            question_id = ObjectId()
        question["_id"] = question_id
        used_question_ids.add(str(question_id))
    return quiz["_id"]


def _assign_saved_assignment_ids(course):
    seen = set()

    def assign_id(assignment):
        if not isinstance(assignment, dict):
            return
        assignment_id = assignment.get("_id") or assignment.get("id")
        try:
            assignment_id = ObjectId(str(assignment_id)) if assignment_id else None
        except (InvalidId, TypeError):
            assignment_id = None
        if assignment_id is None or str(assignment_id) in seen:
            assignment_id = ObjectId()
        assignment["_id"] = assignment_id
        seen.add(str(assignment_id))

    for assignment in course.get("assignments", []) or []:
        assign_id(assignment)
    for module in course.get("modules", []) or []:
        if not isinstance(module, dict):
            continue
        for assignment in module.get("assignments", []) or []:
            assign_id(assignment)
        for item in module.get("contentItems", []) or []:
            if isinstance(item, dict) and str(item.get("type", "")).lower() == "assignment":
                assign_id(item)


def _assign_saved_quiz_ids(course):
    for quiz in course.get("quizzes", []):
        if isinstance(quiz, dict):
            _ensure_saved_quiz_id(quiz)

    for module in course.get("modules", []):
        if not isinstance(module, dict):
            continue
        module_quiz = module.get("quiz")
        content_items = module.get("contentItems")
        quiz_items = [
            item for item in (content_items if isinstance(content_items, list) else [])
            if isinstance(item, dict) and item.get("type") == "quiz"
        ]
        item_quizzes = [
            item.get("quiz") if isinstance(item.get("quiz"), dict) else item
            for item in quiz_items
        ]

        if isinstance(module_quiz, dict) and item_quizzes:
            first_item_quiz = item_quizzes[0]
            module_quiz_id = module_quiz.get("_id")
            first_item_quiz_id = first_item_quiz.get("_id")
            if module_quiz_id and not first_item_quiz_id:
                first_item_quiz["_id"] = module_quiz_id
            elif first_item_quiz_id and not module_quiz_id:
                module_quiz["_id"] = first_item_quiz_id
            elif not module_quiz_id and not first_item_quiz_id:
                module_quiz["_id"] = ObjectId()
                first_item_quiz["_id"] = module_quiz["_id"]

        if isinstance(module_quiz, dict):
            _ensure_saved_quiz_id(module_quiz)
            if item_quizzes:
                first_item_quiz = item_quizzes[0]
                first_item_quiz["_id"] = module_quiz["_id"]
                for module_question, item_question in zip(
                    module_quiz.get("questions", []) or [],
                    first_item_quiz.get("questions", []) or [],
                ):
                    if isinstance(module_question, dict) and isinstance(item_question, dict):
                        item_question["_id"] = module_question["_id"]
        for quiz in item_quizzes:
            _ensure_saved_quiz_id(quiz)


class AdminCourseDirectoryView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = AdminDirectoryResponseSerializer

    def get(self, request):
        courses = list(collection("courses").find().limit(2000))
        enrolled_students = set()
        enrollments = collection("enrollments")
        for field in ("studentId", "student_id", "userId", "user_id"):
            enrolled_students.update(
                _id_string(value)
                for value in enrollments.distinct(field)
                if value is not None
            )
        published = sum(
            1
            for course in courses
            if str(course.get("status", "")).lower() == "published"
            or course.get("published") is True
            or course.get("isPublished") is True
        )
        return Response({
            "courses": [_public_course(course) for course in courses],
            "stats": {
                "totalCourses": len(courses),
                "publishedCourses": published,
                "draftCourses": len(courses) - published,
                "totalEnrolledStudents": len(enrolled_students),
            },
        })

    def post(self, request):
        serializer = AdminCourseWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        course = {
            **serializer.validated_data,
            "created_at": datetime.now(timezone.utc),
            "created_by": str(request.user.id),
        }
        _assign_saved_assignment_ids(course)
        _assign_saved_quiz_ids(course)
        try:
            result = collection("courses").insert_one(course)
        except (PyMongoError, RuntimeError):
            logger.exception("Could not create course in MongoDB.")
            return Response(
                {"message": "MongoDB could not save the course. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        course["_id"] = result.inserted_id
        return Response(
            {"course": _public_course(course), "message": "Course created."},
            status=status.HTTP_201_CREATED,
        )


class AdminCourseDetailView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = AdminCourseWriteSerializer

    def put(self, request, course_id):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        course_data = serializer.validated_data
        _assign_saved_assignment_ids(course_data)
        _assign_saved_quiz_ids(course_data)
        try:
            object_id = ObjectId(course_id)
            course_queries = [{"_id": object_id}]
        except (InvalidId, TypeError):
            course_queries = []
        course_queries.append({"_id": course_id})
        try:
            courses = collection("courses")
            course = None
            for course_query in course_queries:
                course = courses.find_one_and_update(
                    course_query,
                    {
                        "$set": {
                            **course_data,
                            "updated_at": datetime.now(timezone.utc),
                        }
                    },
                    return_document=ReturnDocument.AFTER,
                )
                if course is not None:
                    break
        except (PyMongoError, RuntimeError):
            logger.exception("Could not update course in MongoDB.")
            return Response(
                {"message": "MongoDB could not save the course. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if course is None:
            return Response(
                {"detail": "Course not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response({"course": _public_course(course), "message": "Course saved."})


class AdminCourseStatusView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = AdminCourseStatusSerializer

    def patch(self, request, course_id):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        course_status = serializer.validated_data["status"]
        is_published = course_status == "published"
        try:
            object_id = ObjectId(course_id)
            course_queries = [{"_id": object_id}]
        except (InvalidId, TypeError):
            course_queries = []
        course_queries.append({"_id": course_id})

        try:
            courses = collection("courses")
            course = None
            for course_query in course_queries:
                course = courses.find_one_and_update(
                    course_query,
                    {
                        "$set": {
                            "status": course_status,
                            "published": is_published,
                            "isPublished": is_published,
                            "is_published": is_published,
                            "updated_at": datetime.now(timezone.utc),
                        }
                    },
                    return_document=ReturnDocument.AFTER,
                )
                if course is not None:
                    break
        except (PyMongoError, RuntimeError):
            logger.exception("Could not update course status in MongoDB.")
            return Response(
                {"message": "MongoDB could not update the course status. Please try again."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if course is None:
            return Response({"detail": "Course not found."}, status=status.HTTP_404_NOT_FOUND)

        action = "published" if is_published else "moved to draft"
        return Response({
            "course": _public_course(course),
            "message": f"Course {action}.",
        })


class AdminEnrollmentDirectoryView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = AdminDirectoryResponseSerializer

    def get(self, request):
        users = {}
        for user in collection("users").find(
            {},
            {"password": 0, "password_hash": 0, "passwordHash": 0},
        ).limit(20000):
            user_id = _id_string(user.get("_id"))
            users[user_id] = {
                "_id": user_id,
                "name": user.get("name") or user.get("fullName") or "",
                "email": user.get("email", ""),
                "studentType": _student_type(user),
            }

        courses = {
            _id_string(course.get("_id")): {
                "_id": _id_string(course.get("_id")),
                "title": course.get("title") or course.get("name") or "",
            }
            for course in collection("courses").find({}, {"title": 1, "name": 1}).limit(2000)
        }
        records = collection("enrollments").find().sort(
            [("createdAt", -1), ("created_at", -1)]
        ).limit(20000)
        enrollments = []
        for record in records:
            enrollment = _json_value(dict(record))
            raw_user_id = (
                enrollment.get("userId")
                or enrollment.get("user_id")
                or enrollment.get("studentId")
                or enrollment.get("student_id")
            )
            raw_course_id = enrollment.get("courseId") or enrollment.get("course_id")
            if isinstance(raw_user_id, dict):
                raw_user_id = raw_user_id.get("_id") or raw_user_id.get("id")
            if isinstance(raw_course_id, dict):
                raw_course_id = raw_course_id.get("_id") or raw_course_id.get("id")
            user_id = _id_string(raw_user_id)
            course_id = _id_string(raw_course_id)
            enrollment["_id"] = _id_string(enrollment.get("_id"))
            enrollment["userId"] = users.get(user_id, {"_id": user_id})
            enrollment["courseId"] = courses.get(course_id, {"_id": course_id})
            enrollment.setdefault("status", "enrolled")
            enrollments.append(enrollment)
        return Response({"enrollments": enrollments})
