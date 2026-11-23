import json
import logging
import re
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from drf_spectacular.utils import extend_schema
from pymongo.errors import PyMongoError
from rest_framework import status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from core.cloudinary_storage import (
    CloudinaryConfigurationError,
    CloudinaryStorageError,
    MediaValidationError,
    check_cloudinary_connection,
    create_signed_upload,
    delete_media,
    get_media_metadata,
    upload_media,
)
from core.mongodb import collection


logger = logging.getLogger(__name__)
_SRT_TIMESTAMP = re.compile(
    r"^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})\s+-->\s+"
    r"(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$"
)
_MAX_TRANSCRIPT_CUES = 10_000
_MAX_TRANSCRIPT_DURATION_MS = 12 * 60 * 60 * 1000


def _main_admin_required(request):
    if request.user.role != "main_admin":
        return Response(
            {"message": "Main administrator access is required."},
            status=status.HTTP_403_FORBIDDEN,
        )
    return None


def _is_course_asset(public_id, resource_type):
    allowed_prefixes = {
        "image": (
            "aihustle-lms/course-thumbnail/",
            "aihustle-lms/course_resource/",
        ),
        "video": ("aihustle-lms/course_video/",),
        "raw": (
            "aihustle-lms/course_pdf/",
            "aihustle-lms/course_resource/",
            "aihustle-lms/course_transcript/",
        ),
    }
    return isinstance(public_id, str) and any(
        public_id.startswith(prefix) for prefix in allowed_prefixes.get(resource_type, ())
    )


def _parse_object_id(value):
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError):
        return None


def _find_course(course_id):
    object_id = _parse_object_id(course_id)
    queries = []
    if object_id is not None:
        queries.append({"_id": object_id})
    queries.append({"_id": str(course_id)})
    for query in queries:
        course = collection("courses").find_one(query)
        if course is not None:
            return course
    return None


def _module_index(course, module_id):
    for index, module in enumerate(course.get("modules", []) or []):
        if not isinstance(module, dict):
            continue
        if str(module.get("_id") or module.get("id") or "") == str(module_id):
            return index, module
    return None, None


def _asset_document(metadata, owner_id, purpose, **links):
    document = {
        "ownerId": str(owner_id),
        "purpose": purpose,
        "publicId": metadata["publicId"],
        "secureUrl": metadata["secureUrl"],
        "resourceType": metadata["resourceType"],
        "format": metadata["format"],
        "bytes": metadata["bytes"],
        "originalName": metadata["originalName"],
        "width": metadata.get("width"),
        "height": metadata.get("height"),
        "duration": metadata.get("duration"),
        "version": metadata.get("version"),
        "status": "uploaded",
        "createdAt": datetime.now(timezone.utc),
    }
    document.update({key: str(value) for key, value in links.items() if value is not None})
    return document


def _cleanup_uploaded_asset(metadata):
    try:
        delete_media(metadata["publicId"], metadata["resourceType"])
    except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
        logger.warning("Unable to clean up an unlinked Cloudinary media asset.")


def _store_uploaded_asset(metadata, owner_id, purpose, **links):
    document = _asset_document(metadata, owner_id, purpose, **links)
    try:
        collection("media_assets").insert_one(document)
    except (PyMongoError, RuntimeError):
        _cleanup_uploaded_asset(metadata)
        raise
    return document


def _parse_transcript(uploaded_file):
    if uploaded_file.size > 2 * 1024 * 1024:
        raise MediaValidationError("The SRT transcript exceeds the 2 MB size limit.")
    uploaded_file.seek(0)
    try:
        source = uploaded_file.read().decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise MediaValidationError("The SRT transcript must be valid UTF-8 text.") from exc
    finally:
        uploaded_file.seek(0)
    if not source.strip():
        raise MediaValidationError("The SRT transcript is empty.")
    normalized_source = source.replace("\r\n", "\n").replace("\r", "\n").strip()
    blocks = re.split(r"\n[ \t]*\n", normalized_source)
    if len(blocks) > _MAX_TRANSCRIPT_CUES:
        raise MediaValidationError("The transcript contains too many cues.")
    cues = []
    for index, block in enumerate(blocks):
        lines = block.split("\n")
        timestamp_index = 1 if lines and lines[0].strip().isdigit() else 0
        match = _SRT_TIMESTAMP.fullmatch(
            lines[timestamp_index].strip() if timestamp_index < len(lines) else ""
        )
        if match is None:
            raise MediaValidationError(f"Transcript cue {index + 1} has an invalid timestamp.")
        values = [int(value) for value in match.groups()]
        start = values[0] * 3_600_000 + values[1] * 60_000 + values[2] * 1_000 + values[3]
        end = values[4] * 3_600_000 + values[5] * 60_000 + values[6] * 1_000 + values[7]
        text = re.sub(r"<[^>]*>", "", "\n".join(lines[timestamp_index + 1 :])).strip()
        if (
            end <= start
            or end > _MAX_TRANSCRIPT_DURATION_MS
            or not text
            or len(text) > 5000
        ):
            raise MediaValidationError(f"Transcript cue {index + 1} has invalid timing or text.")
        cues.append({"startTimeMs": start, "endTimeMs": end, "text": text})
    return sorted(cues, key=lambda cue: cue["startTimeMs"])


@extend_schema(exclude=True)
class AdminCloudinaryHealthView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        denied = _main_admin_required(request)
        if denied:
            return denied
        try:
            result = check_cloudinary_connection()
        except (CloudinaryConfigurationError, CloudinaryStorageError):
            return Response({"connected": False})
        return Response({"connected": result.get("status") == "ok"})


@extend_schema(exclude=True)
class AdminCourseAssetSignatureView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        denied = _main_admin_required(request)
        if denied:
            return denied
        if request.data.get("resourceType") != "image":
            return Response(
                {"message": "Only course-thumbnail image uploads may use a signed direct upload."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            signature = create_signed_upload()
        except CloudinaryConfigurationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except MediaValidationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        collection("media_assets").insert_one({
            "ownerId": str(request.user.id),
            "purpose": "course_thumbnail",
            "publicId": signature["publicId"],
            "resourceType": "image",
            "status": "awaiting_direct_upload",
            "createdAt": datetime.now(timezone.utc),
        })
        return Response(signature)


@extend_schema(exclude=True)
class AdminCourseAssetDeleteView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        denied = _main_admin_required(request)
        if denied:
            return denied
        public_id = request.data.get("publicId")
        resource_type = request.data.get("resourceType")
        if not _is_course_asset(public_id, resource_type):
            return Response(
                {"message": "Only course media assets may be deleted through this endpoint."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            delete_media(public_id, resource_type)
        except MediaValidationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        collection("media_assets").delete_one({"publicId": public_id})
        return Response({"deleted": True})


@extend_schema(exclude=True)
class AdminCourseAssetRegisterView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        denied = _main_admin_required(request)
        if denied:
            return denied
        public_id = request.data.get("publicId")
        if not isinstance(public_id, str) or not public_id.startswith("aihustle-lms/course-thumbnail/"):
            return Response({"message": "Uploaded thumbnail metadata is invalid."}, status=status.HTTP_400_BAD_REQUEST)
        assets = collection("media_assets")
        pending = assets.find_one({
            "ownerId": str(request.user.id),
            "publicId": public_id,
            "resourceType": "image",
            "status": "awaiting_direct_upload",
        })
        if pending is None:
            return Response({"message": "The signed media upload was not found."}, status=status.HTTP_404_NOT_FOUND)
        try:
            metadata = get_media_metadata(public_id, "image")
        except MediaValidationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        if (
            metadata.get("format") not in {"avif", "gif", "jpg", "jpeg", "png", "webp"}
            or not isinstance(metadata.get("bytes"), int)
            or not 1 <= metadata["bytes"] <= 10 * 1024 * 1024
        ):
            cleanup_warning = False
            try:
                delete_media(public_id, "image")
            except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
                cleanup_warning = True
            assets.delete_one({"_id": pending["_id"]})
            return Response(
                {"message": "Uploaded thumbnail metadata is invalid.", "cleanupWarning": cleanup_warning},
                status=status.HTTP_400_BAD_REQUEST,
            )
        update = {
            "secureUrl": metadata["secureUrl"],
            "format": metadata["format"],
            "bytes": metadata["bytes"],
            "width": metadata.get("width"),
            "height": metadata.get("height"),
            "version": metadata.get("version"),
            "status": "uploaded",
            "uploadedAt": datetime.now(timezone.utc),
        }
        assets.update_one({"_id": pending["_id"]}, {"$set": update})
        return Response({"registered": True})


@extend_schema(exclude=True)
class AdminCourseModuleMediaView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request, course_id, module_id, asset_type):
        denied = _main_admin_required(request)
        if denied:
            return denied
        course = _find_course(course_id)
        if course is None:
            return Response({"message": "Course not found."}, status=status.HTTP_404_NOT_FOUND)
        if _module_index(course, module_id)[0] is None:
            return Response({"message": "Course module not found."}, status=status.HTTP_404_NOT_FOUND)
        purpose = {"video": "course_video", "resource": "course_resource"}.get(asset_type)
        if purpose is None:
            return Response({"message": "Unsupported course media type."}, status=status.HTTP_400_BAD_REQUEST)
        uploaded_file = request.FILES.get("file")
        if uploaded_file is None:
            return Response({"message": "Choose a file to upload."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            metadata = upload_media(
                uploaded_file,
                purpose,
                owner_id=request.user.id,
                course_id=course_id,
                module_id=module_id,
            )
        except MediaValidationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        _store_uploaded_asset(
            metadata,
            request.user.id,
            purpose,
            courseId=course_id,
            moduleId=module_id,
        )
        return Response({
            "url": metadata["secureUrl"],
            "publicId": metadata["publicId"],
            "resourceType": metadata["resourceType"],
            "format": metadata["format"],
            "bytes": metadata["bytes"],
            "originalName": metadata["originalName"],
            "duration": metadata["duration"],
        })


@extend_schema(exclude=True)
class AdminCourseTranscriptView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request, course_id, module_id, lesson_id):
        denied = _main_admin_required(request)
        if denied:
            return denied
        course = _find_course(course_id)
        if course is None:
            return Response({"message": "Course not found."}, status=status.HTTP_404_NOT_FOUND)
        module_index, module = _module_index(course, module_id)
        if module is None:
            return Response({"message": "Course module not found."}, status=status.HTTP_404_NOT_FOUND)
        uploaded_file = request.FILES.get("file")
        lesson_value = request.data.get("lesson")
        if uploaded_file is None or not isinstance(lesson_value, str):
            return Response({"message": "The transcript file and lesson details are required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            lesson = json.loads(lesson_value)
        except (TypeError, ValueError):
            return Response({"message": "Lesson details are invalid."}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(lesson, dict) or str(lesson.get("_id") or "") != str(lesson_id):
            return Response({"message": "Lesson details are invalid."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            cues = _parse_transcript(uploaded_file)
            metadata = upload_media(
                uploaded_file,
                "course_transcript",
                owner_id=request.user.id,
                course_id=course_id,
                module_id=module_id,
            )
        except MediaValidationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        content_items = module.get("contentItems")
        if not isinstance(content_items, list):
            content_items = []
        lesson_index = next(
            (
                index for index, item in enumerate(content_items)
                if isinstance(item, dict) and str(item.get("_id") or "") == str(lesson_id)
            ),
            None,
        )
        saved_lesson = {
            **lesson,
            "transcriptUrl": metadata["secureUrl"],
            "transcriptPublicId": metadata["publicId"],
            "transcriptFileName": metadata["originalName"],
            "transcriptFormat": metadata["format"],
            "transcriptBytes": metadata["bytes"],
            "transcriptCues": cues,
            "transcriptStored": True,
            "videoStored": True,
        }
        asset_document = _asset_document(
            metadata,
            request.user.id,
            "course_transcript",
            courseId=course_id,
            moduleId=module_id,
            lessonId=lesson_id,
        )
        try:
            asset_result = collection("media_assets").insert_one(asset_document)
        except (PyMongoError, RuntimeError):
            _cleanup_uploaded_asset(metadata)
            raise
        module_path = f"modules.{module_index}"
        if lesson_index is None:
            update = {"$push": {f"{module_path}.contentItems": saved_lesson}}
        else:
            update = {"$set": {
                f"{module_path}.contentItems.{lesson_index}.{key}": value
                for key, value in saved_lesson.items()
            }}
        try:
            result = collection("courses").update_one({"_id": course["_id"]}, update)
        except (PyMongoError, RuntimeError):
            try:
                collection("media_assets").delete_one({"_id": asset_result.inserted_id})
            except (PyMongoError, RuntimeError):
                logger.warning("Unable to remove the media record for an unsaved transcript.")
            _cleanup_uploaded_asset(metadata)
            raise
        if not result.matched_count:
            try:
                collection("media_assets").delete_one({"_id": asset_result.inserted_id})
            finally:
                _cleanup_uploaded_asset(metadata)
            return Response({"message": "The lesson could not be saved."}, status=status.HTTP_409_CONFLICT)
        return Response({
            "saved": True,
            "transcriptUrl": metadata["secureUrl"],
            "transcriptPublicId": metadata["publicId"],
            "transcriptFileName": metadata["originalName"],
            "transcriptFormat": metadata["format"],
            "transcriptBytes": metadata["bytes"],
            "transcriptCues": cues,
        })

    def delete(self, request, course_id, module_id, lesson_id):
        denied = _main_admin_required(request)
        if denied:
            return denied
        course = _find_course(course_id)
        if course is None:
            return Response({"message": "Course not found."}, status=status.HTTP_404_NOT_FOUND)
        module_index, module = _module_index(course, module_id)
        if module is None:
            return Response({"message": "Course module not found."}, status=status.HTTP_404_NOT_FOUND)
        lesson_value = request.data.get("lesson")
        try:
            lesson = json.loads(lesson_value) if isinstance(lesson_value, str) else {}
        except ValueError:
            lesson = {}
        if not isinstance(lesson, dict) or str(lesson.get("_id") or "") != str(lesson_id):
            return Response({"message": "Lesson details are invalid."}, status=status.HTTP_400_BAD_REQUEST)
        public_id = lesson.get("transcriptPublicId")
        content_items = module.get("contentItems")
        if isinstance(content_items, list):
            lesson_index = next(
                (
                    index for index, item in enumerate(content_items)
                    if isinstance(item, dict) and str(item.get("_id") or "") == str(lesson_id)
                ),
                None,
            )
        else:
            lesson_index = None
        if lesson_index is not None:
            collection("courses").update_one(
                {"_id": course["_id"]},
                {"$set": {
                    f"modules.{module_index}.contentItems.{lesson_index}.{key}": value
                    for key, value in {
                        "transcriptUrl": "",
                        "transcriptPublicId": "",
                        "transcriptFileName": "",
                        "transcriptFormat": "",
                        "transcriptBytes": 0,
                        "transcriptCues": [],
                        "transcriptStored": False,
                    }.items()
                }},
            )
        if not public_id:
            return Response({"deleted": True, "cleanupWarning": False})
        try:
            delete_media(public_id, "raw")
        except (CloudinaryConfigurationError, CloudinaryStorageError):
            return Response({"deleted": True, "cleanupWarning": True})
        collection("media_assets").delete_one({"publicId": public_id})
        return Response({"deleted": True, "cleanupWarning": False})
