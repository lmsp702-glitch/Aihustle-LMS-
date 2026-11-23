from drf_spectacular.utils import extend_schema
from pymongo import ReturnDocument
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from authentication.approval import normalize_account_type
from core.mongo import parse_object_id, serialize_document
from core.mongodb import collection
from users.serializers import UserProfileSerializer
from core.serializers import UserSummarySerializer


def _public_user_document(user):
    document = serialize_document(user)
    document.pop("account_type", None)
    account_type = normalize_account_type(user)
    if account_type is not None:
        document["accountType"] = account_type
    return document


class UserListView(GenericAPIView):
    serializer_class = UserSummarySerializer
    permission_classes = [IsAuthenticated]

    @extend_schema(
        operation_id="users_list",
        responses=UserSummarySerializer(many=True),
    )
    def get(self, request):
        if request.user.role not in {"main_admin", "college_admin"}:
            return Response({"detail": "Administrator access is required."}, status=403)
        users = collection("users").find({}, {"password_hash": 0}).limit(100)
        return Response([_public_user_document(user) for user in users])


class UserDetailView(GenericAPIView):
    serializer_class = UserSummarySerializer
    permission_classes = [IsAuthenticated]

    @extend_schema(operation_id="users_retrieve", responses=UserSummarySerializer)
    def get(self, request, user_id):
        if request.user.role not in {"main_admin", "college_admin"} and request.user.id != user_id:
            return Response({"detail": "You may only view your own profile."}, status=403)
        object_id = parse_object_id(user_id)
        user = collection("users").find_one(
            {"_id": object_id},
            {"password_hash": 0},
        ) if object_id else None
        if user is None:
            return Response({"detail": "Not found."}, status=404)
        return Response(_public_user_document(user))

    @extend_schema(
        operation_id="users_update",
        request=UserProfileSerializer,
        responses=UserSummarySerializer,
    )
    def patch(self, request, user_id):
        if request.user.id != user_id and request.user.role not in {"main_admin", "college_admin"}:
            return Response({"detail": "You may only update your own profile."}, status=403)
        object_id = parse_object_id(user_id)
        if object_id is None:
            return Response({"detail": "Not found."}, status=404)
        serializer = UserProfileSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        updated = collection("users").find_one_and_update(
            {"_id": object_id},
            {"$set": serializer.validated_data},
            return_document=ReturnDocument.AFTER,
            projection={"password_hash": 0},
        )
        if updated is None:
            return Response({"detail": "Not found."}, status=404)
        return Response(_public_user_document(updated))


class MyProfileView(UserDetailView):
    @extend_schema(operation_id="users_me", responses=UserSummarySerializer)
    def get(self, request):
        return super().get(request, user_id=request.user.id)

    @extend_schema(
        operation_id="users_update_me",
        request=UserProfileSerializer,
        responses=UserSummarySerializer,
    )
    def patch(self, request):
        return super().patch(request, user_id=request.user.id)
