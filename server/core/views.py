from datetime import datetime, timezone

from pymongo.errors import PyMongoError
from drf_spectacular.utils import extend_schema
from pymongo import ReturnDocument
from rest_framework import status
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from core.mongo import parse_object_id, serialize_document
from core.mongodb import check_mongo_connection, collection
from core.serializers import HealthSerializer


class HealthCheckView(GenericAPIView):
    serializer_class = HealthSerializer
    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(responses={200: HealthSerializer, 503: HealthSerializer})
    def get(self, request):
        try:
            check_mongo_connection()
        except (RuntimeError, PyMongoError) as exc:
            detail = "MongoDB is not configured." if isinstance(exc, RuntimeError) else "MongoDB Atlas is unreachable."
            return Response(
                {
                    "status": "degraded",
                    "database": "unavailable",
                    "detail": detail,
                    "timestamp": datetime.now(timezone.utc),
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response(
            {
                "status": "ok",
                "database": "connected",
                "timestamp": datetime.now(timezone.utc),
            }
        )


class MongoResourceView(GenericAPIView):
    permission_classes = [IsAuthenticated]
    collection_name = None
    serializer_class = None
    writable_roles = {"main_admin", "college_admin"}

    def get_collection(self):
        return collection(self.collection_name)

    def _document(self, document):
        return serialize_document(document)

    def _require_write_role(self, request):
        if getattr(request.user, "role", None) not in self.writable_roles:
            return Response(
                {"detail": "You do not have permission to modify this resource."},
                status=status.HTTP_403_FORBIDDEN,
            )
        return None

    def get(self, request, resource_id=None):
        documents = self.get_collection()
        if resource_id:
            object_id = parse_object_id(resource_id)
            if object_id is None:
                return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
            document = documents.find_one({"_id": object_id})
            if document is None:
                return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
            return Response(self._document(document))
        items = [self._document(item) for item in documents.find().limit(100)]
        return Response(items)

    def post(self, request):
        denied = self._require_write_role(request)
        if denied:
            return denied
        serializer = self.serializer_class(data=request.data)
        serializer.is_valid(raise_exception=True)
        document = serializer.validated_data
        document["created_at"] = datetime.now(timezone.utc)
        document["created_by"] = str(request.user.id)
        result = self.get_collection().insert_one(document)
        document["_id"] = result.inserted_id
        return Response(
            self._document(document),
            status=status.HTTP_201_CREATED,
        )

    def put(self, request, resource_id):
        return self._update(request, resource_id, partial=False)

    def patch(self, request, resource_id):
        return self._update(request, resource_id, partial=True)

    def _update(self, request, resource_id, partial):
        denied = self._require_write_role(request)
        if denied:
            return denied
        object_id = parse_object_id(resource_id)
        if object_id is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        serializer = self.serializer_class(data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        result = self.get_collection().find_one_and_update(
            {"_id": object_id},
            {"$set": serializer.validated_data},
            return_document=ReturnDocument.AFTER,
        )
        if result is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(self._document(result))

    def delete(self, request, resource_id):
        denied = self._require_write_role(request)
        if denied:
            return denied
        object_id = parse_object_id(resource_id)
        if object_id is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        result = self.get_collection().delete_one({"_id": object_id})
        if not result.deleted_count:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(status=status.HTTP_204_NO_CONTENT)
