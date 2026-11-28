import hashlib
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from bson import ObjectId
from bson.errors import InvalidId
from cloudinary.exceptions import NotFound as CloudinaryNotFound
from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from drf_spectacular.utils import extend_schema
from pymongo.errors import PyMongoError
from rest_framework import status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from authentication.permissions import IsMainAdmin
from core.cloudinary_storage import (
    CloudinaryConfigurationError,
    CloudinaryStorageError,
    MediaValidationError,
    check_cloudinary_connection,
    create_signed_course_video_upload,
    create_signed_upload,
    delete_media,
    get_media_metadata,
    is_cloudinary_delivery_url,
    upload_media,
)
from core.middleware import log_video_upload_stage
from core.mongodb import collection


logger = logging.getLogger(__name__)
_SRT_TIMESTAMP = re.compile(
    r"^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})\s+-->\s+"
    r"(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$"
)
_SRT_TIMESTAMP_CUE_MARKER = re.compile(r"(?m)^\s*(?:\d+\s*\n)?\d+:[^\n]*(?:-->|->)")
_MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024
_MAX_TRANSCRIPT_CUES = 10_000
_MAX_TRANSCRIPT_DURATION_MS = 12 * 60 * 60 * 1000
_MAX_COURSE_VIDEO_BYTES = 2 * 1024 * 1024 * 1024
_COURSE_VIDEO_FORMATS = frozenset({"avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"})
_COURSE_VIDEO_SIGNATURE_TTL = timedelta(minutes=55)


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
    upload_key = document.get("uploadKey")
    try:
        if upload_key:
            document["_id"] = upload_key
            document["uploadKey"] = upload_key
            update_fields = {key: value for key, value in document.items() if key != "_id"}
            collection("media_assets").update_one(
                {"_id": upload_key},
                {"$set": update_fields},
                upsert=True,
            )
        else:
            collection("media_assets").insert_one(document)
    except (PyMongoError, RuntimeError):
        _cleanup_uploaded_asset(metadata)
        raise
    return document


def _media_upload_response(asset):
    return {
        "url": asset["secureUrl"],
        "publicId": asset["publicId"],
        "resourceType": asset["resourceType"],
        "format": asset["format"],
        "bytes": asset["bytes"],
        "originalName": asset["originalName"],
        "duration": asset.get("duration"),
    }


def _safe_service_error(exception):
    detail = str(exception).strip() or type(exception).__name__
    for secret in (
        settings.MONGODB_URI,
        settings.CLOUDINARY_API_KEY,
        settings.CLOUDINARY_API_SECRET,
    ):
        if secret:
            detail = detail.replace(secret, "[redacted]")
    return detail


def _video_upload_key(course_id, module_id, lesson_id, uploaded_file, last_modified):
    identity = json.dumps(
        [
            str(course_id),
            str(module_id),
            lesson_id,
            str(uploaded_file.name),
            int(uploaded_file.size),
            last_modified,
        ],
        ensure_ascii=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _course_video_upload_filename(file_name):
    if not isinstance(file_name, str) or not file_name.strip() or len(file_name) > 255:
        return None
    filename = Path(file_name.strip().replace("\\", "/")).name
    if not filename or Path(filename).suffix.lower().lstrip(".") not in _COURSE_VIDEO_FORMATS:
        return None
    if any(ord(character) < 32 for character in filename):
        return None
    return filename


def _utc_datetime(value):
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _course_video_verification_error(metadata, pending):
    if not isinstance(metadata, dict):
        return "Cloudinary has not returned complete video metadata.", status.HTTP_409_CONFLICT
    if (
        metadata.get("publicId") != pending.get("publicId")
        or metadata.get("resourceType") != "video"
        or not is_cloudinary_delivery_url(metadata.get("secureUrl"))
    ):
        return "The Cloudinary video identity or delivery URL is invalid.", status.HTTP_400_BAD_REQUEST
    video_format = metadata.get("format")
    if not isinstance(video_format, str) or video_format.lower() not in _COURSE_VIDEO_FORMATS:
        return "The uploaded asset is not an allowed video format.", status.HTTP_400_BAD_REQUEST
    actual_size = metadata.get("bytes")
    if isinstance(actual_size, bool) or not isinstance(actual_size, int) or actual_size <= 0:
        return "Cloudinary has not returned the completed video size yet.", status.HTTP_409_CONFLICT
    if actual_size > _MAX_COURSE_VIDEO_BYTES or actual_size != pending.get("declaredBytes"):
        return "The uploaded video size does not match the authorized upload.", status.HTTP_400_BAD_REQUEST
    uploaded_at = _utc_datetime(metadata.get("createdAt"))
    issued_at = _utc_datetime(pending.get("createdAt"))
    expires_at = _utc_datetime(pending.get("signatureExpiresAt"))
    if uploaded_at is None or issued_at is None or expires_at is None:
        return "Cloudinary has not returned complete upload timing metadata.", status.HTTP_409_CONFLICT
    if uploaded_at < issued_at - timedelta(minutes=1) or uploaded_at > expires_at + timedelta(minutes=5):
        return "The Cloudinary asset was not uploaded during this signed upload window.", status.HTTP_400_BAD_REQUEST
    return None


def _verified_video_response(asset):
    return {
        **_media_upload_response(asset),
        "uploadId": str(asset["_id"]),
        "verified": True,
    }


@extend_schema(exclude=True)
class AdminCourseVideoUploadSignatureView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    parser_classes = [JSONParser]

    def post(self, request, course_id, module_id, lesson_id):
        filename = _course_video_upload_filename(request.data.get("fileName"))
        file_size = request.data.get("fileSize")
        if filename is None:
            return Response(
                {"message": "Choose a supported video filename (MP4, MOV, WebM, AVI, MKV, or OGV)."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if (
            isinstance(file_size, bool)
            or not isinstance(file_size, int)
            or file_size <= 0
            or file_size > _MAX_COURSE_VIDEO_BYTES
        ):
            return Response(
                {"message": "The video size is invalid or exceeds the 2 GB limit."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not str(lesson_id).strip() or len(str(lesson_id)) > 128:
            return Response({"message": "A valid lesson ID is required."}, status=status.HTTP_400_BAD_REQUEST)
        course = _find_course(course_id)
        if course is None:
            return Response({"message": "Course not found."}, status=status.HTTP_404_NOT_FOUND)
        if _module_index(course, module_id)[0] is None:
            return Response({"message": "Course module not found."}, status=status.HTTP_404_NOT_FOUND)

        try:
            signed_upload = create_signed_course_video_upload(
                request.user.id,
                course_id,
                module_id,
                filename,
            )
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            return Response(
                {"message": _safe_service_error(exc)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        now = datetime.now(timezone.utc)
        expires_at = now + _COURSE_VIDEO_SIGNATURE_TTL
        pending = {
            "_id": ObjectId(),
            "ownerId": str(request.user.id),
            "purpose": "course_video",
            "courseId": str(course_id),
            "moduleId": str(module_id),
            "lessonId": str(lesson_id),
            "publicId": signed_upload["publicId"],
            "resourceType": "video",
            "originalName": filename,
            "declaredBytes": file_size,
            "status": "awaiting_direct_upload",
            "createdAt": now,
            "signatureTimestamp": signed_upload["timestamp"],
            "signatureExpiresAt": expires_at,
        }
        try:
            collection("media_assets").insert_one(pending)
        except (PyMongoError, RuntimeError) as exc:
            logger.exception("Could not save pending signed course-video upload.")
            return Response(
                {"message": f"MongoDB could not save the pending upload: {_safe_service_error(exc)}"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response({
            "uploadId": str(pending["_id"]),
            "cloudName": signed_upload["cloudName"],
            "apiKey": signed_upload["apiKey"],
            "timestamp": signed_upload["timestamp"],
            "publicId": signed_upload["publicId"],
            "filenameOverride": signed_upload["filenameOverride"],
            "overwrite": signed_upload["overwrite"],
            "type": signed_upload["type"],
            "resourceType": signed_upload["resourceType"],
            "signature": signed_upload["signature"],
            "expiresAt": expires_at.isoformat(),
        })


@extend_schema(exclude=True)
class AdminCourseVideoUploadVerificationView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    parser_classes = [JSONParser]

    def post(self, request, course_id, module_id, lesson_id):
        upload_id = request.data.get("uploadId")
        try:
            upload_object_id = ObjectId(str(upload_id))
        except (InvalidId, TypeError):
            return Response({"message": "The video upload ID is invalid."}, status=status.HTTP_400_BAD_REQUEST)

        identity = {
            "_id": upload_object_id,
            "ownerId": str(request.user.id),
            "purpose": "course_video",
            "courseId": str(course_id),
            "moduleId": str(module_id),
            "lessonId": str(lesson_id),
        }
        assets = collection("media_assets")
        pending = assets.find_one(identity)
        if pending is None:
            return Response({"message": "The signed video upload was not found."}, status=status.HTTP_404_NOT_FOUND)
        if pending.get("status") == "uploaded":
            return Response(_verified_video_response(pending))
        if pending.get("status") != "awaiting_direct_upload":
            return Response({"message": "This video upload can no longer be verified."}, status=status.HTTP_409_CONFLICT)

        now = datetime.now(timezone.utc)
        expires_at = _utc_datetime(pending.get("signatureExpiresAt"))
        if expires_at is None or now >= expires_at:
            assets.update_one(
                {**identity, "status": "awaiting_direct_upload"},
                {"$set": {"status": "expired", "expiredAt": now}},
            )
            return Response({"message": "The signed video upload has expired. Request a new signature."}, status=410)

        course = _find_course(course_id)
        if course is None:
            return Response({"message": "Course not found."}, status=status.HTTP_404_NOT_FOUND)
        if _module_index(course, module_id)[0] is None:
            return Response({"message": "Course module not found."}, status=status.HTTP_404_NOT_FOUND)

        try:
            metadata = get_media_metadata(pending["publicId"], "video")
        except MediaValidationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            if isinstance(exc.__cause__, CloudinaryNotFound):
                return Response(
                    {"message": "Cloudinary has not completed this video upload yet."},
                    status=status.HTTP_409_CONFLICT,
                )
            return Response(
                {"message": _safe_service_error(exc)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        validation_error = _course_video_verification_error(metadata, pending)
        if validation_error is not None:
            message, response_status = validation_error
            if response_status == status.HTTP_400_BAD_REQUEST:
                assets.update_one(
                    {**identity, "status": "awaiting_direct_upload"},
                    {"$set": {"status": "rejected", "rejectedAt": now}},
                )
            return Response({"message": message}, status=response_status)

        verified_fields = {
            "secureUrl": metadata["secureUrl"],
            "publicId": metadata["publicId"],
            "resourceType": metadata["resourceType"],
            "format": metadata["format"],
            "bytes": metadata["bytes"],
            "originalName": metadata.get("originalName") or pending["originalName"],
            "width": metadata.get("width"),
            "height": metadata.get("height"),
            "duration": metadata.get("duration"),
            "version": metadata.get("version"),
            "status": "uploaded",
            "uploadedAt": now,
        }
        try:
            result = assets.update_one(
                {**identity, "status": "awaiting_direct_upload"},
                {"$set": verified_fields},
            )
        except (PyMongoError, RuntimeError) as exc:
            logger.exception("Could not save verified Cloudinary course-video metadata.")
            return Response(
                {"message": f"MongoDB could not save verified video metadata: {_safe_service_error(exc)}"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if result.matched_count != 1:
            saved = assets.find_one({**identity, "status": "uploaded"})
            if saved is not None:
                return Response(_verified_video_response(saved))
            return Response(
                {"message": "The video upload changed before verification could finish. Retry verification."},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(_verified_video_response({**pending, **verified_fields}))


def _parse_transcript(uploaded_file):
    if uploaded_file.size > _MAX_TRANSCRIPT_BYTES:
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


def _parse_manual_transcript(source):
    if not isinstance(source, str):
        raise MediaValidationError("The transcript must be text.")
    normalized_source = (
        source.lstrip("\ufeff")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .strip()
    )
    if not normalized_source:
        raise MediaValidationError("The transcript is empty.")
    encoded_source = normalized_source.encode("utf-8")
    if len(encoded_source) > _MAX_TRANSCRIPT_BYTES:
        raise MediaValidationError("Choose a transcript up to 2 MB.")
    if _SRT_TIMESTAMP_CUE_MARKER.search(normalized_source):
        cues = _parse_transcript(
            SimpleUploadedFile(
                "manual-transcript.srt",
                encoded_source,
                content_type="text/plain",
            )
        )
        return "srt", "", cues, len(encoded_source)
    return "text", normalized_source, [], len(encoded_source)


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
        trace_id = getattr(request, "video_upload_trace_id", None)
        log_video_upload_stage(trace_id, "handler_entered")
        denied = _main_admin_required(request)
        if denied:
            log_video_upload_stage(trace_id, "authorization_rejected", status=denied.status_code)
            return denied
        course_lookup_started_at = time.perf_counter()
        log_video_upload_stage(trace_id, "course_lookup_started")
        course = _find_course(course_id)
        log_video_upload_stage(
            trace_id,
            "course_lookup_completed",
            found=course is not None,
            duration_ms=round((time.perf_counter() - course_lookup_started_at) * 1000),
        )
        if course is None:
            return Response({"message": "Course not found."}, status=status.HTTP_404_NOT_FOUND)
        if _module_index(course, module_id)[0] is None:
            return Response({"message": "Course module not found."}, status=status.HTTP_404_NOT_FOUND)
        purpose = {"video": "course_video", "resource": "course_resource"}.get(asset_type)
        if purpose is None:
            return Response({"message": "Unsupported course media type."}, status=status.HTTP_400_BAD_REQUEST)
        multipart_started_at = time.perf_counter()
        log_video_upload_stage(trace_id, "multipart_parse_started")
        uploaded_file = request.FILES.get("file")
        log_video_upload_stage(
            trace_id,
            "multipart_parse_completed",
            file_present=uploaded_file is not None,
            bytes=uploaded_file.size if uploaded_file is not None else 0,
            duration_ms=round((time.perf_counter() - multipart_started_at) * 1000),
        )
        if uploaded_file is None:
            return Response({"message": "Choose a file to upload."}, status=status.HTTP_400_BAD_REQUEST)
        lesson_id = None
        upload_key = None
        if purpose == "course_video":
            lesson_id = str(request.data.get("lessonId", "")).strip()
            if not lesson_id or len(lesson_id) > 128:
                return Response(
                    {"message": "A valid lesson ID is required for video uploads."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            try:
                last_modified = int(request.data.get("lastModified", 0))
            except (TypeError, ValueError):
                return Response(
                    {"message": "The video file timestamp is invalid."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if last_modified < 0:
                return Response(
                    {"message": "The video file timestamp is invalid."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            upload_key = _video_upload_key(
                course_id,
                module_id,
                lesson_id,
                uploaded_file,
                last_modified,
            )
            log_video_upload_stage(trace_id, "retry_lookup_started")
            retry_lookup_started_at = time.perf_counter()
            existing_asset = collection("media_assets").find_one({
                "_id": upload_key,
                "ownerId": str(request.user.id),
                "purpose": purpose,
                "courseId": str(course_id),
                "moduleId": str(module_id),
                "lessonId": lesson_id,
                "uploadKey": upload_key,
                "status": "uploaded",
            })
            log_video_upload_stage(
                trace_id,
                "retry_lookup_completed",
                found=existing_asset is not None,
                duration_ms=round((time.perf_counter() - retry_lookup_started_at) * 1000),
            )
            if existing_asset is not None:
                return Response(_media_upload_response(existing_asset))
        try:
            upload_options = {
                "owner_id": request.user.id,
                "course_id": course_id,
                "module_id": module_id,
            }
            if upload_key is not None:
                upload_options["idempotency_key"] = upload_key
            if trace_id is not None:
                upload_options["upload_trace_id"] = trace_id
            storage_started_at = time.perf_counter()
            log_video_upload_stage(trace_id, "media_storage_started", bytes=uploaded_file.size)
            metadata = upload_media(uploaded_file, purpose, **upload_options)
            log_video_upload_stage(
                trace_id,
                "media_storage_completed",
                duration_ms=round((time.perf_counter() - storage_started_at) * 1000),
            )
        except MediaValidationError as exc:
            log_video_upload_stage(trace_id, "media_validation_failed", error_type=type(exc).__name__)
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            log_video_upload_stage(trace_id, "media_storage_failed", error_type=type(exc).__name__)
            return Response(
                {"message": _safe_service_error(exc)},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            mongo_started_at = time.perf_counter()
            log_video_upload_stage(trace_id, "mongodb_save_started")
            _store_uploaded_asset(
                metadata,
                request.user.id,
                purpose,
                courseId=course_id,
                moduleId=module_id,
                lessonId=lesson_id,
                uploadKey=upload_key,
            )
            log_video_upload_stage(
                trace_id,
                "mongodb_save_completed",
                duration_ms=round((time.perf_counter() - mongo_started_at) * 1000),
            )
        except (PyMongoError, RuntimeError) as exc:
            log_video_upload_stage(trace_id, "mongodb_save_failed", error_type=type(exc).__name__)
            logger.exception("MongoDB could not save uploaded course media metadata.")
            return Response(
                {
                    "message": (
                        "MongoDB could not save the uploaded media metadata: "
                        f"{_safe_service_error(exc)}"
                    )
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return Response(_media_upload_response(metadata))


@extend_schema(exclude=True)
class AdminCourseTranscriptView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

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
            "transcriptSource": "srt",
            "transcriptText": "",
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
            "transcriptSource": "srt",
            "transcriptText": "",
            "transcriptCues": cues,
        })

    def put(self, request, course_id, module_id, lesson_id):
        denied = _main_admin_required(request)
        if denied:
            return denied
        lesson = request.data.get("lesson")
        transcript = request.data.get("transcript")
        if (
            not isinstance(lesson, dict)
            or str(lesson.get("_id") or "") != str(lesson_id)
            or lesson.get("type") != "video-lesson"
            or not isinstance(transcript, str)
        ):
            return Response({"message": "Valid video lesson details and transcript text are required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            transcript_format, transcript_text, cues, transcript_bytes = _parse_manual_transcript(transcript)
        except MediaValidationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        course = _find_course(course_id)
        if course is None:
            return Response({"message": "Course not found."}, status=status.HTTP_404_NOT_FOUND)
        module_index, module = _module_index(course, module_id)
        if module is None:
            return Response({"message": "Course module not found."}, status=status.HTTP_404_NOT_FOUND)
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
        stored_lesson = content_items[lesson_index] if lesson_index is not None else lesson
        if (
            not isinstance(stored_lesson, dict)
            or stored_lesson.get("type") != "video-lesson"
            or not stored_lesson.get("videoUrl")
            or not stored_lesson.get("videoPublicId")
        ):
            return Response({"message": "Upload a video to this lesson before attaching its transcript."}, status=status.HTTP_400_BAD_REQUEST)

        transcript_fields = {
            "transcriptUrl": "",
            "transcriptPublicId": "",
            "transcriptFileName": "Manual transcript",
            "transcriptFormat": transcript_format,
            "transcriptBytes": transcript_bytes,
            "transcriptSource": "manual",
            "transcriptText": transcript_text,
            "transcriptCues": cues,
            "transcriptStored": True,
        }
        module_path = f"modules.{module_index}"
        if lesson_index is None:
            saved_lesson = {**lesson, **transcript_fields}
            update = {"$push": {f"{module_path}.contentItems": saved_lesson}}
        else:
            update = {"$set": {
                f"{module_path}.contentItems.{lesson_index}.{key}": value
                for key, value in transcript_fields.items()
            }}
        module_id_field = "_id" if module.get("_id") is not None else "id"
        query = {"_id": course["_id"], f"{module_path}.{module_id_field}": module.get(module_id_field)}
        if lesson_index is not None:
            query[f"{module_path}.contentItems.{lesson_index}._id"] = content_items[lesson_index].get("_id")
        else:
            query[f"{module_path}.contentItems._id"] = {"$ne": str(lesson_id)}
        try:
            result = collection("courses").update_one(query, update)
        except (PyMongoError, RuntimeError) as exc:
            return Response(
                {"message": f"MongoDB could not save the manual transcript: {_safe_service_error(exc)}"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if not result.matched_count:
            return Response({"message": "The lesson changed before its transcript could be saved. Reload the course and try again."}, status=status.HTTP_409_CONFLICT)
        return Response({
            "saved": True,
            "transcriptUrl": "",
            "transcriptPublicId": "",
            "transcriptFileName": transcript_fields["transcriptFileName"],
            "transcriptFormat": transcript_fields["transcriptFormat"],
            "transcriptBytes": transcript_fields["transcriptBytes"],
            "transcriptSource": "manual",
            "transcriptText": transcript_text,
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
                        "transcriptSource": "",
                        "transcriptText": "",
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
