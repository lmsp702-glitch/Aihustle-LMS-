from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from drf_spectacular.utils import extend_schema
from pymongo import ReturnDocument
from rest_framework import serializers, status
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from authentication.permissions import IsMainAdmin
from core.mongodb import collection


_HUSTLER_STUDENTS = {
    "role": "student",
    "$and": [
        {
            "$or": [
                {"accountType": {"$in": ["hustler", "external", "independent"]}},
                {"account_type": {"$in": ["hustler", "external", "independent"]}},
            ]
        },
        {"studentType": {"$ne": "college"}},
        {"student_type": {"$ne": "college"}},
    ],
}
_APPROVAL_STATUSES = {"pending", "approved", "rejected"}


class ApprovalListQuerySerializer(serializers.Serializer):
    status = serializers.ChoiceField(
        choices=("pending", "approved", "rejected", "all"),
        required=False,
        default="pending",
    )
    page = serializers.IntegerField(min_value=1, max_value=1_000_000, default=1)
    pageSize = serializers.IntegerField(min_value=1, max_value=100, default=25)


class ApprovalDecisionSerializer(serializers.Serializer):
    decision = serializers.ChoiceField(choices=("approve", "reject"))
    reason = serializers.CharField(max_length=1000, required=False, allow_blank=True)


class ApprovalStudentSerializer(serializers.Serializer):
    _id = serializers.CharField()
    fullName = serializers.CharField()
    email = serializers.EmailField()
    accountType = serializers.ChoiceField(choices=("hustler",))
    createdAt = serializers.CharField(allow_null=True)
    studentType = serializers.CharField()
    approvalStatus = serializers.ChoiceField(choices=("pending", "approved", "rejected"))
    approvedAt = serializers.CharField(allow_null=True)
    rejectionReason = serializers.CharField(allow_blank=True)
    registrationDetails = serializers.DictField()


class ApprovalListResponseSerializer(serializers.Serializer):
    students = ApprovalStudentSerializer(many=True)
    total = serializers.IntegerField()
    pendingCount = serializers.IntegerField()


class ApprovalDetailsResponseSerializer(serializers.Serializer):
    student = ApprovalStudentSerializer()


class ApprovalMessageSerializer(serializers.Serializer):
    message = serializers.CharField()


def _isoformat(value):
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _approval_student(document):
    approval_status = document.get("approvalStatus")
    if approval_status not in _APPROVAL_STATUSES:
        approval_status = "pending"
    details = document.get("registrationDetails")
    return {
        "_id": str(document["_id"]),
        "fullName": document.get("fullName") or document.get("name") or "",
        "email": document.get("email", ""),
        "accountType": "hustler",
        "createdAt": _isoformat(document.get("created_at")),
        "studentType": document.get("studentType") or "independent",
        "approvalStatus": approval_status,
        "approvedAt": _isoformat(document.get("approvedAt")),
        "rejectionReason": document.get("rejectionReason", ""),
        "registrationDetails": details if isinstance(details, dict) else {},
    }


class IndependentStudentApprovalListView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = ApprovalListQuerySerializer

    @extend_schema(responses=ApprovalListResponseSerializer)
    def get(self, request):
        query_serializer = self.get_serializer(data=request.query_params)
        query_serializer.is_valid(raise_exception=True)
        values = query_serializer.validated_data
        users = collection("users")
        pending_query = {
            **_HUSTLER_STUDENTS,
            "approvalStatus": {"$nin": ["approved", "rejected"]},
        }
        pending_count = users.count_documents(pending_query)
        query = dict(_HUSTLER_STUDENTS)
        if values["status"] == "pending":
            query["approvalStatus"] = {"$nin": ["approved", "rejected"]}
        elif values["status"] in {"approved", "rejected"}:
            query["approvalStatus"] = values["status"]

        total = users.count_documents(query)
        cursor = (
            users.find(query, {"password_hash": 0})
            .sort([("created_at", -1), ("_id", -1)])
            .skip((values["page"] - 1) * values["pageSize"])
            .limit(values["pageSize"])
        )
        return Response({
            "students": [_approval_student(student) for student in cursor],
            "total": total,
            "pendingCount": pending_count,
        })


class IndependentStudentApprovalDetailsView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = ApprovalDetailsResponseSerializer

    @extend_schema(responses=ApprovalDetailsResponseSerializer)
    def get(self, request, student_id):
        try:
            object_id = ObjectId(student_id)
        except (InvalidId, TypeError):
            return Response(
                {"message": "Student application not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        student = collection("users").find_one(
            {**_HUSTLER_STUDENTS, "_id": object_id},
            {"password_hash": 0},
        )
        if student is None:
            return Response(
                {"message": "Student application not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response({"student": _approval_student(student)})


class IndependentStudentApprovalDecisionView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = ApprovalDecisionSerializer

    @extend_schema(
        request=ApprovalDecisionSerializer,
        responses=ApprovalMessageSerializer,
    )
    def patch(self, request, student_id):
        try:
            object_id = ObjectId(student_id)
        except (InvalidId, TypeError):
            return Response(
                {"message": "Student application not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        decision = serializer.validated_data["decision"]
        now = datetime.now(timezone.utc)
        if decision == "approve":
            update = {
                "$set": {
                    "approvalStatus": "approved",
                    "status": "approved",
                    "approvedAt": now,
                    "approvedBy": str(request.user.id),
                },
                "$unset": {"rejectionReason": "", "rejectedAt": "", "rejectedBy": ""},
            }
        else:
            update = {
                "$set": {
                    "approvalStatus": "rejected",
                    "status": "rejected",
                    "rejectionReason": serializer.validated_data.get("reason", "").strip(),
                    "rejectedAt": now,
                    "rejectedBy": str(request.user.id),
                },
                "$unset": {"approvedAt": "", "approvedBy": ""},
            }
        users = collection("users")
        student = users.find_one_and_update(
            {
                **_HUSTLER_STUDENTS,
                "_id": object_id,
                "approvalStatus": {"$nin": ["approved", "rejected"]},
            },
            update,
            return_document=ReturnDocument.AFTER,
            projection={"password_hash": 0},
        )
        if student is None:
            existing = users.find_one(
                {**_HUSTLER_STUDENTS, "_id": object_id},
                {"_id": 1},
            )
            if existing is None:
                return Response(
                    {"message": "Student application not found."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            return Response(
                {"message": "Only pending applications can be reviewed."},
                status=status.HTTP_409_CONFLICT,
            )
        decision_text = "approved" if decision == "approve" else "rejected"
        return Response({"message": f"Hustler account {decision_text}."})
