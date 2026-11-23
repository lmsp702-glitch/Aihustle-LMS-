from datetime import datetime, timedelta, timezone

from rest_framework import serializers
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from authentication.permissions import IsMainAdmin
from core.mongodb import collection


class EngagementQuerySerializer(serializers.Serializer):
    period = serializers.ChoiceField(
        choices=("7d", "30d", "3m", "6m"),
        default="30d",
        required=False,
    )


class AdminOverviewResponseSerializer(serializers.Serializer):
    stats = serializers.DictField()
    courseCompletion = serializers.DictField()
    recentRegistrations = serializers.ListField(child=serializers.DictField())
    recentCourses = serializers.ListField(child=serializers.DictField())


def _isoformat(value):
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _month_start(year, month):
    return datetime(year, month, 1, tzinfo=timezone.utc)


def _engagement_buckets(period, now):
    now = now.astimezone(timezone.utc)
    if period in {"7d", "30d"}:
        length = 7 if period == "7d" else 30
        today = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return [
            (
                today - timedelta(days=length - index - 1),
                today - timedelta(days=length - index - 2),
            )
            for index in range(length)
        ]

    length = 3 if period == "3m" else 6
    current_month = now.year * 12 + now.month - 1
    first_month = current_month - length + 1
    buckets = []
    for index in range(length):
        month_number = first_month + index
        year, month_index = divmod(month_number, 12)
        next_year, next_month_index = divmod(month_number + 1, 12)
        buckets.append((
            _month_start(year, month_index + 1),
            _month_start(next_year, next_month_index + 1),
        ))
    return buckets


def _bucket_key(start, period):
    return start.strftime("%Y-%m" if period in {"3m", "6m"} else "%Y-%m-%d")


def _course_completion_counts():
    pipeline = [
        {
            "$project": {
                "_status": {
                    "$toLower": {
                        "$convert": {
                            "input": "$status",
                            "to": "string",
                            "onError": "",
                            "onNull": "",
                        }
                    }
                },
                "_progress": {
                    "$convert": {
                        "input": {"$ifNull": ["$courseProgress", "$progress"]},
                        "to": "double",
                        "onError": 0,
                        "onNull": 0,
                    }
                },
            }
        },
        {
            "$project": {
                "state": {
                    "$switch": {
                        "branches": [
                            {
                                "case": {
                                    "$or": [
                                        {"$in": ["$_status", ["complete", "completed"]]},
                                        {"$gte": ["$_progress", 100]},
                                    ]
                                },
                                "then": "completed",
                            },
                            {
                                "case": {
                                    "$or": [
                                        {
                                            "$in": [
                                                "$_status",
                                                ["active", "in-progress", "in_progress", "started"],
                                            ]
                                        },
                                        {"$gt": ["$_progress", 0]},
                                    ]
                                },
                                "then": "in_progress",
                            },
                        ],
                        "default": "not_started",
                    }
                }
            }
        },
        {
            "$group": {
                "_id": None,
                "totalEnrollments": {"$sum": 1},
                "completedEnrollments": {
                    "$sum": {"$cond": [{"$eq": ["$state", "completed"]}, 1, 0]}
                },
                "inProgressEnrollments": {
                    "$sum": {"$cond": [{"$eq": ["$state", "in_progress"]}, 1, 0]}
                },
                "notStartedEnrollments": {
                    "$sum": {"$cond": [{"$eq": ["$state", "not_started"]}, 1, 0]}
                },
            }
        },
    ]
    results = list(collection("enrollments").aggregate(pipeline))
    if not results:
        return {
            "completedEnrollments": 0,
            "inProgressEnrollments": 0,
            "notStartedEnrollments": 0,
            "totalEnrollments": 0,
        }
    return {
        key: int(results[0].get(key, 0))
        for key in (
            "completedEnrollments",
            "inProgressEnrollments",
            "notStartedEnrollments",
            "totalEnrollments",
        )
    }


class AdminOverviewView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = AdminOverviewResponseSerializer

    def get(self, request):
        users = collection("users")
        recent_registrations = users.find(
            {"role": "student"},
            {"password_hash": 0},
        ).sort([("created_at", -1), ("createdAt", -1)]).limit(5)
        recent_courses = collection("courses").find().sort(
            [("created_at", -1), ("createdAt", -1)]
        ).limit(5)
        return Response({
            "stats": {
                "totalStudents": users.count_documents({"role": "student"}),
                "totalColleges": collection("colleges").count_documents({}),
                "totalCourses": collection("courses").count_documents({}),
            },
            "courseCompletion": _course_completion_counts(),
            "recentRegistrations": [
                {
                    "_id": str(user["_id"]),
                    "fullName": user.get("fullName") or user.get("name") or "",
                    "username": user.get("username"),
                    "role": user.get("role"),
                    "studentType": user.get("studentType") or "independent",
                    "status": user.get("status", "active"),
                    "createdAt": _isoformat(user.get("created_at") or user.get("createdAt")),
                }
                for user in recent_registrations
            ],
            "recentCourses": [
                {
                    "_id": str(course["_id"]),
                    "title": course.get("title") or course.get("name") or "",
                    "status": course.get("status") or "draft",
                }
                for course in recent_courses
            ],
        })


class AdminEngagementView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = EngagementQuerySerializer

    def get(self, request):
        serializer = self.get_serializer(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        period = serializer.validated_data["period"]
        counts = []
        for start, end in _engagement_buckets(period, datetime.now(timezone.utc)):
            query = {
                "$or": [
                    {"createdAt": {"$gte": start, "$lt": end}},
                    {"created_at": {"$gte": start, "$lt": end}},
                ]
            }
            counts.append({
                "date": _bucket_key(start, period),
                "count": collection("enrollments").count_documents(query),
            })
        return Response({"period": period, "engagement": counts})
