from datetime import datetime, timezone

from drf_spectacular.utils import extend_schema
from rest_framework.generics import GenericAPIView
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from core.mongo import parse_object_id, serialize_document
from core.mongodb import collection
from core.serializers import SubmissionSerializer


class SubmissionListView(GenericAPIView):
    serializer_class = SubmissionSerializer
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="submissions_list",
        responses=SubmissionSerializer(many=True),
    )
    def get(self, request):
        query = {} if request.user.role in {"main_admin", "college_admin"} else {
            "student_id": request.user.id
        }
        submissions = collection("submissions").find(query).limit(100)
        return Response([serialize_document(item) for item in submissions])

    def post(self, request):
        serializer = SubmissionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        document = serializer.validated_data
        document["student_id"] = request.user.id
        document["created_at"] = datetime.now(timezone.utc)
        result = collection("submissions").insert_one(document)
        document["_id"] = result.inserted_id
        return Response(serialize_document(document), status=status.HTTP_201_CREATED)


class SubmissionDetailView(GenericAPIView):
    serializer_class = SubmissionSerializer
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="submissions_retrieve",
        responses=SubmissionSerializer,
    )
    def get(self, request, submission_id):
        object_id = parse_object_id(submission_id)
        query = {"_id": object_id} if object_id else None
        if query is not None and request.user.role not in {"main_admin", "college_admin"}:
            query["student_id"] = request.user.id
        submission = collection("submissions").find_one(query) if query else None
        if submission is None:
            return Response({"detail": "Not found."}, status=404)
        return Response(serialize_document(submission))
