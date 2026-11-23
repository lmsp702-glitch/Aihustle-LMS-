import re

from bson import ObjectId
from bson.errors import InvalidId
from rest_framework import serializers
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from authentication.permissions import IsMainAdmin
from core.mongodb import collection


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
