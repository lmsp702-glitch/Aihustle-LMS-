import logging
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import cloudinary
from cloudinary import api, uploader
from cloudinary.exceptions import Error as CloudinaryError, GeneralError
from cloudinary.utils import api_sign_request
from django.conf import settings
from urllib3.util import Timeout

from core.middleware import log_video_upload_stage


MIB = 1024 * 1024
VIDEO_CHUNK_SIZE = 5 * MIB
VIDEO_CHUNKED_UPLOAD_THRESHOLD = VIDEO_CHUNK_SIZE
VIDEO_UPLOAD_TIMEOUT_SECONDS = 600
VIDEO_UPLOAD_CONNECT_TIMEOUT_SECONDS = 15
VIDEO_UPLOAD_RETRIES = 2
VIDEO_UPLOAD_RETRY_DELAY_SECONDS = 2
CLOUDINARY_FOLDER = "aihustle-lms"
logger = logging.getLogger(__name__)


class CloudinaryConfigurationError(RuntimeError):
    pass


class MediaValidationError(ValueError):
    pass


class CloudinaryStorageError(RuntimeError):
    pass


_IMAGE_TYPES = {
    ".avif": {"image/avif"},
    ".gif": {"image/gif"},
    ".jpeg": {"image/jpeg"},
    ".jpg": {"image/jpeg"},
    ".png": {"image/png"},
    ".webp": {"image/webp"},
}
_VIDEO_TYPES = {
    ".avi": {"video/avi", "video/x-msvideo", "application/octet-stream"},
    ".m4v": {"video/mp4", "video/x-m4v", "application/octet-stream"},
    ".mkv": {"video/x-matroska", "application/octet-stream"},
    ".mov": {"video/quicktime", "application/octet-stream"},
    ".mp4": {"video/mp4", "application/octet-stream"},
    ".ogv": {"video/ogg", "application/ogg", "application/octet-stream"},
    ".webm": {"video/webm", "application/octet-stream"},
}
_RAW_TYPES = {
    ".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"},
    ".pdf": {"application/pdf", "application/octet-stream"},
    ".srt": {"application/x-subrip", "text/plain", "application/octet-stream"},
    ".txt": {"text/plain", "application/octet-stream"},
}
_RESOURCE_POLICIES = {
    "assignment_submission": {
        "extensions": {".docx", ".pdf", ".txt"},
        "max_bytes": 10 * MIB,
    },
    "course_pdf": {
        "extensions": {".pdf"},
        "max_bytes": 50 * MIB,
    },
    "course_resource": {
        "extensions": {".jpeg", ".jpg", ".pdf", ".png", ".webp"},
        "max_bytes": 50 * MIB,
    },
    "course_thumbnail": {
        "extensions": set(_IMAGE_TYPES),
        "max_bytes": 10 * MIB,
    },
    "certificate_template": {
        "extensions": {".jpg", ".jpeg", ".png"},
        "max_bytes": 4 * MIB,
    },
    "course_transcript": {
        "extensions": {".srt"},
        "max_bytes": 2 * MIB,
    },
    "course_video": {
        "extensions": set(_VIDEO_TYPES),
        "max_bytes": 2 * 1024 * MIB,
    },
    "learning_material": {
        "extensions": {".docx", ".jpeg", ".jpg", ".pdf", ".png", ".txt", ".webp"},
        "max_bytes": 50 * MIB,
    },
    "profile_image": {
        "extensions": set(_IMAGE_TYPES),
        "max_bytes": 10 * MIB,
    },
}


def configure_cloudinary():
    cloud_name = settings.CLOUDINARY_CLOUD_NAME
    api_key = settings.CLOUDINARY_API_KEY
    api_secret = settings.CLOUDINARY_API_SECRET
    if not cloud_name or not api_key or not api_secret:
        raise CloudinaryConfigurationError("Cloudinary is not fully configured.")
    cloudinary.config(
        cloud_name=cloud_name,
        api_key=api_key,
        api_secret=api_secret,
        secure=True,
    )


def _cloudinary_error_detail(exception):
    detail = str(exception).strip() or type(exception).__name__
    for secret in (settings.CLOUDINARY_API_KEY, settings.CLOUDINARY_API_SECRET):
        if secret:
            detail = detail.replace(secret, "[redacted]")
    return detail


def check_cloudinary_connection():
    configure_cloudinary()
    try:
        return api.ping()
    except CloudinaryError as exc:
        raise CloudinaryStorageError("Cloudinary could not be reached.") from exc


def _read_header(uploaded_file):
    try:
        position = uploaded_file.tell()
    except (AttributeError, OSError):
        position = 0
    try:
        header = uploaded_file.read(32)
    finally:
        uploaded_file.seek(position)
    return header


def _valid_file_signature(extension, header):
    if extension in {".jpg", ".jpeg"}:
        return header.startswith(b"\xff\xd8\xff")
    if extension == ".png":
        return header.startswith(b"\x89PNG\r\n\x1a\n")
    if extension == ".gif":
        return header.startswith((b"GIF87a", b"GIF89a"))
    if extension == ".webp":
        return len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP"
    if extension == ".avif":
        return len(header) >= 12 and header[4:8] == b"ftyp" and header[8:12] in {b"avif", b"avis"}
    if extension in {".mp4", ".m4v", ".mov"}:
        return len(header) >= 12 and header[4:8] == b"ftyp"
    if extension in {".webm", ".mkv"}:
        return header.startswith(b"\x1aE\xdf\xa3")
    if extension == ".ogv":
        return header.startswith(b"OggS")
    if extension == ".avi":
        return len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"AVI "
    if extension == ".pdf":
        return header.startswith(b"%PDF-")
    if extension == ".docx":
        return header.startswith(b"PK\x03\x04")
    return False


def _validate_upload(uploaded_file, purpose):
    policy = _RESOURCE_POLICIES.get(purpose)
    if policy is None:
        raise MediaValidationError("Unsupported media purpose.")
    filename = Path(str(getattr(uploaded_file, "name", ""))).name
    extension = Path(filename).suffix.lower()
    if extension not in policy["extensions"]:
        raise MediaValidationError("This file type is not allowed.")
    size = getattr(uploaded_file, "size", None)
    if not isinstance(size, int) or size <= 0 or size > policy["max_bytes"]:
        raise MediaValidationError("The file is empty or exceeds the size limit.")
    expected_types = (
        _VIDEO_TYPES.get(extension)
        or _IMAGE_TYPES.get(extension)
        or _RAW_TYPES.get(extension)
    )
    content_type = str(getattr(uploaded_file, "content_type", "") or "").lower()
    if expected_types and content_type and content_type not in expected_types:
        raise MediaValidationError("The file content type does not match its extension.")
    if extension in {".txt", ".srt"}:
        uploaded_file.seek(0)
        try:
            uploaded_file.read().decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise MediaValidationError("The file contents do not match an allowed file type.") from exc
        finally:
            uploaded_file.seek(0)
    elif not _valid_file_signature(extension, _read_header(uploaded_file)):
        raise MediaValidationError("The file contents do not match an allowed file type.")
    return filename, extension, size


def _resource_type_for(purpose, extension):
    if purpose in {"profile_image", "course_thumbnail", "certificate_template"}:
        return "image"
    if purpose == "course_video":
        return "video"
    if extension in _IMAGE_TYPES:
        return "image"
    return "raw"


def _safe_segment(value):
    segment = re.sub(r"[^A-Za-z0-9_-]", "-", str(value or "")).strip("-")
    if not segment:
        raise MediaValidationError("A valid media folder identifier is required.")
    return segment[:80]


def _upload_folder(purpose, owner_id, course_id=None, module_id=None):
    parts = [CLOUDINARY_FOLDER, _safe_segment(purpose)]
    if course_id is not None:
        parts.append(_safe_segment(course_id))
    if module_id is not None:
        parts.append(_safe_segment(module_id))
    if owner_id is not None:
        parts.append(_safe_segment(owner_id))
    return "/".join(parts)


def _upload_video_in_chunks(uploaded_file, filename, size, upload_options, trace_id):
    upload_id = uuid.uuid4().hex
    offset = 0
    result = None

    while offset < size:
        uploaded_file.seek(offset)
        chunk = uploaded_file.read(min(VIDEO_CHUNK_SIZE, size - offset))
        if not chunk:
            raise CloudinaryStorageError("The video stream ended before all chunks were uploaded.")

        chunk_start = offset
        chunk_end = chunk_start + len(chunk) - 1
        chunk_headers = {
            "Content-Range": f"bytes {chunk_start}-{chunk_end}/{size}",
            "X-Unique-Upload-Id": upload_id,
        }
        attempt = 0
        while True:
            attempt += 1
            started_at = time.perf_counter()
            log_video_upload_stage(
                trace_id,
                "cloudinary_chunk_upload_started",
                offset=chunk_start,
                bytes=len(chunk),
                total_bytes=size,
                attempt=attempt,
                upload_id=upload_id,
            )
            try:
                result = uploader.upload_large_part(
                    (filename, chunk),
                    http_headers=chunk_headers,
                    **upload_options,
                )
                log_video_upload_stage(
                    trace_id,
                    "cloudinary_chunk_response_received",
                    offset=chunk_start,
                    bytes=len(chunk),
                    duration_ms=round((time.perf_counter() - started_at) * 1000),
                    request_id=getattr(result, "request_id", "unavailable"),
                )
                break
            except GeneralError as exc:
                duration_ms = round((time.perf_counter() - started_at) * 1000)
                should_retry = attempt <= VIDEO_UPLOAD_RETRIES
                log_video_upload_stage(
                    trace_id,
                    "cloudinary_chunk_upload_failed",
                    offset=chunk_start,
                    bytes=len(chunk),
                    duration_ms=duration_ms,
                    attempt=attempt,
                    retrying=should_retry,
                    error_type=type(exc).__name__,
                    error=_cloudinary_error_detail(exc),
                )
                if not should_retry:
                    detail = _cloudinary_error_detail(exc)
                    log_video_upload_stage(
                        trace_id,
                        "cloudinary_upload_failed",
                        error_type=type(exc).__name__,
                        error=detail,
                    )
                    raise CloudinaryStorageError(
                        f"Cloudinary video chunk upload failed after {attempt} attempts: {detail}"
                    ) from exc
                time.sleep(VIDEO_UPLOAD_RETRY_DELAY_SECONDS * attempt)

        if result is None:
            raise CloudinaryStorageError("Cloudinary did not return a video chunk response.")
        returned_public_id = result.get("public_id")
        if isinstance(returned_public_id, str) and returned_public_id:
            upload_options["public_id"] = returned_public_id
        offset = chunk_end + 1

    return result


def upload_media(
    uploaded_file,
    purpose,
    *,
    owner_id,
    course_id=None,
    module_id=None,
    idempotency_key=None,
    upload_trace_id=None,
):
    if purpose == "course_video":
        log_video_upload_stage(upload_trace_id, "validation_started")
    validation_started_at = time.perf_counter()
    filename, extension, size = _validate_upload(uploaded_file, purpose)
    resource_type = _resource_type_for(purpose, extension)
    if purpose == "course_video":
        log_video_upload_stage(
            upload_trace_id,
            "validation_completed",
            bytes=size,
            resource_type=resource_type,
            duration_ms=round((time.perf_counter() - validation_started_at) * 1000),
        )
    folder = _upload_folder(purpose, owner_id, course_id, module_id)
    if idempotency_key is not None:
        if purpose != "course_video" or not re.fullmatch(r"[a-f0-9]{64}", str(idempotency_key)):
            raise MediaValidationError("The video upload retry key is invalid.")
        public_id = idempotency_key
    else:
        public_id = uuid.uuid4().hex
    if purpose == "course_video":
        log_video_upload_stage(upload_trace_id, "cloudinary_configuration_started")
    configure_cloudinary()
    if purpose == "course_video":
        log_video_upload_stage(upload_trace_id, "cloudinary_configuration_completed")
    upload_options = {
        "folder": folder,
        "public_id": public_id,
        "resource_type": resource_type,
        "overwrite": idempotency_key is not None,
        "unique_filename": False,
        "use_filename": False,
        "filename_override": filename,
        "type": "upload",
    }
    if resource_type == "video":
        upload_options["timeout"] = Timeout(
            connect=VIDEO_UPLOAD_CONNECT_TIMEOUT_SECONDS,
            read=VIDEO_UPLOAD_TIMEOUT_SECONDS,
        )
    try:
        uploaded_file.seek(0)
        is_large_video = resource_type == "video" and size >= VIDEO_CHUNKED_UPLOAD_THRESHOLD
        if is_large_video:
            upload_options["chunk_size"] = VIDEO_CHUNK_SIZE
        if purpose == "course_video":
            log_video_upload_stage(
                upload_trace_id,
                "cloudinary_upload_started",
                chunked=is_large_video,
                chunk_size=upload_options.get("chunk_size", "single-request"),
                connect_timeout_seconds=VIDEO_UPLOAD_CONNECT_TIMEOUT_SECONDS,
                response_timeout_seconds=VIDEO_UPLOAD_TIMEOUT_SECONDS,
                stream_position=uploaded_file.tell(),
                stream_readable=uploaded_file.readable(),
                stream_seekable=uploaded_file.seekable(),
            )
        cloudinary_started_at = time.perf_counter()
        if purpose == "course_video":
            log_video_upload_stage(
                upload_trace_id,
                "cloudinary_upload_attempt_started",
                attempt=1,
                max_attempts=1 if not is_large_video else "per-chunk",
                bytes=size,
            )
        if is_large_video:
            result = _upload_video_in_chunks(
                uploaded_file,
                filename,
                size,
                upload_options,
                upload_trace_id,
            )
        else:
            result = uploader.upload(uploaded_file, **upload_options)
        response_duration_ms = round((time.perf_counter() - cloudinary_started_at) * 1000)
        if purpose == "course_video" and is_large_video:
            log_video_upload_stage(
                upload_trace_id,
                "cloudinary_upload_response_received",
                duration_ms=response_duration_ms,
                bytes=result.get("bytes", size),
                request_id=getattr(result, "request_id", "unavailable"),
            )
        if purpose == "course_video":
            log_video_upload_stage(
                upload_trace_id,
                "cloudinary_upload_completed",
                bytes=result.get("bytes", size),
                duration_ms=response_duration_ms,
                chunked=is_large_video,
            )
    except CloudinaryError as exc:
        if purpose == "course_video":
            log_video_upload_stage(
                upload_trace_id,
                "cloudinary_upload_failed",
                error_type=type(exc).__name__,
                error=_cloudinary_error_detail(exc),
            )
        logger.exception("Cloudinary rejected a media upload.")
        detail = _cloudinary_error_detail(exc)
        raise CloudinaryStorageError(f"Cloudinary upload failed: {detail}") from exc
    finally:
        if not getattr(uploaded_file, "closed", False):
            uploaded_file.seek(0)

    secure_url = result.get("secure_url")
    returned_public_id = result.get("public_id")
    returned_resource_type = result.get("resource_type")
    if (
        not isinstance(secure_url, str)
        or not secure_url.startswith("https://")
        or not isinstance(returned_public_id, str)
        or returned_resource_type != resource_type
    ):
        raise CloudinaryStorageError("Cloudinary returned incomplete media metadata.")
    return {
        "secureUrl": secure_url,
        "publicId": returned_public_id,
        "resourceType": resource_type,
        "format": result.get("format") or extension.lstrip("."),
        "bytes": result.get("bytes", size),
        "originalName": filename,
        "width": result.get("width"),
        "height": result.get("height"),
        "duration": result.get("duration"),
        "version": result.get("version"),
    }


def create_signed_upload(purpose="course_thumbnail"):
    if purpose != "course_thumbnail":
        raise MediaValidationError("This media purpose cannot use direct uploads.")
    configure_cloudinary()
    timestamp = int(time.time())
    folder = _upload_folder(purpose, owner_id=None)
    public_id = f"{folder}/{uuid.uuid4().hex}"
    parameters = {
        "folder": folder,
        "public_id": public_id,
        "timestamp": timestamp,
    }
    return {
        "cloudName": settings.CLOUDINARY_CLOUD_NAME,
        "apiKey": settings.CLOUDINARY_API_KEY,
        "timestamp": timestamp,
        "folder": folder,
        "publicId": public_id,
        "signature": api_sign_request(parameters, settings.CLOUDINARY_API_SECRET),
    }


def create_signed_course_video_upload(owner_id, course_id, module_id, filename):
    configure_cloudinary()
    timestamp = int(time.time())
    folder = _upload_folder("course_video", owner_id, course_id, module_id)
    public_id = f"{folder}/{uuid.uuid4().hex}"
    parameters = {
        "overwrite": "false",
        "filename_override": filename,
        "public_id": public_id,
        "timestamp": timestamp,
        "type": "upload",
    }
    return {
        "cloudName": settings.CLOUDINARY_CLOUD_NAME,
        "apiKey": settings.CLOUDINARY_API_KEY,
        "timestamp": timestamp,
        "publicId": public_id,
        "filenameOverride": filename,
        "overwrite": "false",
        "type": "upload",
        "resourceType": "video",
        "signature": api_sign_request(parameters, settings.CLOUDINARY_API_SECRET),
    }


def delete_media(public_id, resource_type):
    if (
        not isinstance(public_id, str)
        or not public_id.startswith(f"{CLOUDINARY_FOLDER}/")
        or ".." in public_id.split("/")
        or resource_type not in {"image", "video", "raw"}
    ):
        raise MediaValidationError("This Cloudinary asset cannot be deleted.")
    configure_cloudinary()
    try:
        result = uploader.destroy(
            public_id,
            resource_type=resource_type,
            invalidate=True,
        )
    except CloudinaryError as exc:
        raise CloudinaryStorageError("The media deletion failed.") from exc
    if result.get("result") not in {"ok", "not found"}:
        raise CloudinaryStorageError("Cloudinary did not confirm the media deletion.")
    return result.get("result")


def get_media_metadata(public_id, resource_type):
    if (
        not isinstance(public_id, str)
        or not public_id.startswith(f"{CLOUDINARY_FOLDER}/")
        or ".." in public_id.split("/")
        or resource_type not in {"image", "video", "raw"}
    ):
        raise MediaValidationError("This Cloudinary asset cannot be inspected.")
    configure_cloudinary()
    try:
        result = api.resource(public_id, resource_type=resource_type, type="upload")
    except CloudinaryError as exc:
        raise CloudinaryStorageError("Cloudinary media metadata could not be retrieved.") from exc
    secure_url = result.get("secure_url")
    if (
        not isinstance(secure_url, str)
        or not secure_url.startswith("https://")
        or result.get("public_id") != public_id
        or result.get("resource_type") != resource_type
    ):
        raise CloudinaryStorageError("Cloudinary returned incomplete media metadata.")
    return {
        "secureUrl": secure_url,
        "publicId": public_id,
        "resourceType": resource_type,
        "format": result.get("format"),
        "bytes": result.get("bytes"),
        "width": result.get("width"),
        "height": result.get("height"),
        "duration": result.get("duration"),
        "version": result.get("version"),
        "originalName": result.get("original_filename"),
        "createdAt": result.get("created_at"),
    }


def is_cloudinary_delivery_url(url):
    if not isinstance(url, str) or not settings.CLOUDINARY_CLOUD_NAME:
        return False
    parsed = urlparse(url)
    return (
        parsed.scheme == "https"
        and parsed.hostname == "res.cloudinary.com"
        and parsed.username is None
        and parsed.password is None
        and parsed.path.startswith(f"/{settings.CLOUDINARY_CLOUD_NAME}/")
        and ".." not in parsed.path.split("/")
    )
