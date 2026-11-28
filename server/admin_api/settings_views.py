import copy
import logging
import re
from datetime import datetime, timezone

from bson import ObjectId
from django.contrib.auth.hashers import check_password, make_password
from pymongo.errors import DuplicateKeyError, PyMongoError
from rest_framework import serializers, status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from authentication.permissions import IsMainAdmin
from core.cloudinary_storage import (
    CloudinaryConfigurationError,
    CloudinaryStorageError,
    MediaValidationError,
    delete_media,
    upload_media,
)
from core.mongodb import collection


logger = logging.getLogger(__name__)
WORKING_DAYS = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)
DEFAULT_SETTINGS = {
    "organization": {"name": "", "address": ""},
    "attendance": {
        "workingDays": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        "weekStartsOn": "Monday",
        "shiftStart": "09:00",
        "shiftEnd": "17:00",
    },
    "appearance": {"theme": None, "tableDensity": "comfortable"},
}
TIME_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


class OrganizationSettingsSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=150, allow_blank=True, trim_whitespace=True)
    address = serializers.CharField(max_length=500, allow_blank=True, trim_whitespace=True)


class AttendanceSettingsSerializer(serializers.Serializer):
    workingDays = serializers.ListField(
        child=serializers.ChoiceField(choices=WORKING_DAYS),
        min_length=1,
        max_length=7,
    )
    weekStartsOn = serializers.ChoiceField(choices=WORKING_DAYS)
    shiftStart = serializers.RegexField(TIME_PATTERN)
    shiftEnd = serializers.RegexField(TIME_PATTERN)

    def validate_workingDays(self, value):
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Each working day can be selected only once.")
        return value


class AppearanceSettingsSerializer(serializers.Serializer):
    theme = serializers.ChoiceField(choices=("light", "dark"))
    tableDensity = serializers.ChoiceField(choices=("comfortable", "compact"))


class AdminSettingsWriteSerializer(serializers.Serializer):
    organization = OrganizationSettingsSerializer()
    attendance = AttendanceSettingsSerializer()
    appearance = AppearanceSettingsSerializer()
    name = serializers.CharField(min_length=2, max_length=120, trim_whitespace=True)


class AdminSettingsProfileSerializer(serializers.Serializer):
    displayName = serializers.CharField(min_length=2, max_length=120, trim_whitespace=True)
    username = serializers.RegexField(r"^[A-Za-z0-9._-]{3,30}$", trim_whitespace=True)

    def validate_username(self, value):
        return value.lower()


class AdminPasswordChangeSerializer(serializers.Serializer):
    currentPassword = serializers.CharField(write_only=True, trim_whitespace=False)
    newPassword = serializers.CharField(write_only=True, min_length=8, max_length=128, trim_whitespace=False)

    def validate_newPassword(self, value):
        if len(value.encode("utf-8")) > 72:
            raise serializers.ValidationError("New password must be no more than 72 UTF-8 bytes.")
        return value

    def validate(self, attrs):
        if attrs["currentPassword"] == attrs["newPassword"]:
            raise serializers.ValidationError({"newPassword": "Choose a password different from your current password."})
        return attrs


def _settings_snapshot(document):
    snapshot = copy.deepcopy(DEFAULT_SETTINGS)
    if not isinstance(document, dict):
        return snapshot
    for section in ("organization", "attendance", "appearance"):
        stored_section = document.get(section)
        if isinstance(stored_section, dict):
            snapshot[section].update(stored_section)
    return snapshot


def _admin_account(document):
    if not document:
        return None
    return {
        "name": document.get("fullName") or document.get("name") or "",
        "username": document.get("username") or "",
        "email": document.get("email") or "",
        "accountType": "Platform Admin" if document.get("role") == "main_admin" else document.get("accountType") or "",
        "role": document.get("role") or "",
        "avatarUrl": document.get("avatarUrl") or "",
        "hasPassword": bool(document.get("password_hash")),
    }


class AdminSettingsView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]

    def get(self, request):
        user_id = ObjectId(request.user.id)
        user = collection("users").find_one({"_id": user_id})
        if user is None:
            return Response({"message": "Administrator account could not be found."}, status=status.HTTP_404_NOT_FOUND)
        settings_document = collection("admin_settings").find_one({"_id": "platform"})
        return Response({
            "settings": _settings_snapshot(settings_document),
            "account": _admin_account(user),
        })

    def put(self, request):
        serializer = AdminSettingsWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        user_id = ObjectId(request.user.id)
        users = collection("users")
        user_update = users.update_one(
            {"_id": user_id},
            {"$set": {"name": values["name"], "fullName": values["name"]}},
        )
        if not user_update.matched_count:
            return Response({"message": "Administrator account could not be found."}, status=status.HTTP_404_NOT_FOUND)

        updated_at = datetime.now(timezone.utc)
        saved_settings = {
            "organization": values["organization"],
            "attendance": values["attendance"],
            "appearance": values["appearance"],
            "updatedAt": updated_at,
            "updatedBy": str(request.user.id),
        }
        collection("admin_settings").update_one(
            {"_id": "platform"},
            {"$set": saved_settings},
            upsert=True,
        )
        account = users.find_one({"_id": user_id})
        return Response({
            "settings": _settings_snapshot(saved_settings),
            "account": _admin_account(account),
            "message": "Settings saved.",
        })


class AdminSettingsProfileView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    parser_classes = [JSONParser]

    def patch(self, request):
        serializer = AdminSettingsProfileSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user_id = ObjectId(request.user.id)
        users = collection("users")
        try:
            user = users.find_one({"_id": user_id})
            if user is None:
                return Response({"message": "Administrator account could not be found."}, status=status.HTTP_404_NOT_FOUND)
            username = serializer.validated_data["username"]
            duplicate = users.find_one({
                "_id": {"$ne": user_id},
                "username": {"$regex": f"^{re.escape(username)}$", "$options": "i"},
            })
            if duplicate is not None:
                return Response({"message": "That username is already in use."}, status=status.HTTP_409_CONFLICT)
            updated = users.update_one(
                {"_id": user_id},
                {"$set": {
                    "name": serializer.validated_data["displayName"],
                    "fullName": serializer.validated_data["displayName"],
                    "username": username,
                }},
            )
        except DuplicateKeyError:
            return Response({"message": "That username is already in use."}, status=status.HTTP_409_CONFLICT)
        except PyMongoError:
            logger.exception("Could not save the Main Admin profile.")
            return Response({"message": "Account information could not be saved. Please try again."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        if not updated.matched_count:
            return Response({"message": "Administrator account could not be found."}, status=status.HTTP_404_NOT_FOUND)
        account = _admin_account({
            **user,
            "name": serializer.validated_data["displayName"],
            "fullName": serializer.validated_data["displayName"],
            "username": username,
        })
        return Response({"account": account, "message": "Account information saved."})


class AdminSettingsAccountDeleteView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]

    def delete(self, request):
        return Response(
            {"message": "Platform Super Admin accounts cannot be deleted."},
            status=status.HTTP_403_FORBIDDEN,
        )


class AdminSettingsPasswordView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    parser_classes = [JSONParser]

    def post(self, request):
        serializer = AdminPasswordChangeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        users = collection("users")
        user_id = ObjectId(request.user.id)
        user = users.find_one({"_id": user_id})
        if user is None:
            return Response({"message": "Administrator account could not be found."}, status=status.HTTP_404_NOT_FOUND)
        password_hash = user.get("password_hash")
        if not password_hash:
            return Response(
                {"message": "This administrator account does not have a password set."},
                status=status.HTTP_409_CONFLICT,
            )
        if not check_password(serializer.validated_data["currentPassword"], password_hash):
            return Response({"message": "Your current password is incorrect."}, status=status.HTTP_400_BAD_REQUEST)
        result = users.update_one(
            {"_id": user_id},
            {"$set": {"password_hash": make_password(serializer.validated_data["newPassword"])}},
        )
        if not result.matched_count:
            return Response({"message": "Administrator account could not be found."}, status=status.HTTP_404_NOT_FOUND)
        return Response({"message": "Password changed."})


class AdminSettingsAvatarView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        uploaded_file = request.FILES.get("avatar")
        if uploaded_file is None:
            return Response({"message": "Choose a profile image to upload."}, status=status.HTTP_400_BAD_REQUEST)
        user_id = ObjectId(request.user.id)
        users = collection("users")
        previous = users.find_one({"_id": user_id})
        if previous is None:
            return Response({"message": "Administrator account could not be found."}, status=status.HTTP_404_NOT_FOUND)
        try:
            metadata = upload_media(uploaded_file, "profile_image", owner_id=request.user.id)
        except MediaValidationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        try:
            updated = users.update_one(
                {"_id": user_id},
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
                logger.warning("Unable to clean up an unlinked administrator profile image.")
            raise
        if not updated.matched_count:
            try:
                delete_media(metadata["publicId"], metadata["resourceType"])
            except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
                logger.warning("Unable to clean up an unlinked administrator profile image.")
            return Response({"message": "Administrator account could not be found."}, status=status.HTTP_404_NOT_FOUND)
        cleanup_warning = False
        previous_public_id = previous.get("avatarPublicId")
        if previous_public_id and previous_public_id != metadata["publicId"]:
            try:
                delete_media(previous_public_id, previous.get("avatarResourceType") or "image")
            except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
                cleanup_warning = True
        return Response({
            "avatarUrl": metadata["secureUrl"],
            "cleanupWarning": cleanup_warning,
        })

    def delete(self, request):
        user_id = ObjectId(request.user.id)
        users = collection("users")
        previous = users.find_one({"_id": user_id})
        if previous is None:
            return Response({"message": "Administrator account could not be found."}, status=status.HTTP_404_NOT_FOUND)
        updated = users.update_one(
            {"_id": user_id},
            {"$set": {"avatarUrl": ""}, "$unset": {
                "avatarPublicId": "",
                "avatarResourceType": "",
                "avatarFormat": "",
                "avatarBytes": "",
                "avatarOriginalName": "",
                "avatarWidth": "",
                "avatarHeight": "",
            }},
        )
        if not updated.matched_count:
            return Response({"message": "Administrator account could not be found."}, status=status.HTTP_404_NOT_FOUND)
        cleanup_warning = False
        public_id = previous.get("avatarPublicId")
        if public_id:
            try:
                delete_media(public_id, previous.get("avatarResourceType") or "image")
            except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
                cleanup_warning = True
        return Response({"avatarUrl": "", "cleanupWarning": cleanup_warning})
