import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import cloudinary
from cloudinary import api, uploader
from cloudinary.exceptions import Error as CloudinaryError
from cloudinary.utils import api_sign_request
from django.conf import settings


MIB = 1024 * 1024
VIDEO_CHUNK_SIZE = 20 * MIB
VIDEO_LARGE_UPLOAD_THRESHOLD = 100 * MIB
CLOUDINARY_FOLDER = "aihustle-lms"


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
    if purpose in {"profile_image", "course_thumbnail"}:
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


def upload_media(
    uploaded_file,
    purpose,
    *,
    owner_id,
    course_id=None,
    module_id=None,
):
    filename, extension, size = _validate_upload(uploaded_file, purpose)
    resource_type = _resource_type_for(purpose, extension)
    folder = _upload_folder(purpose, owner_id, course_id, module_id)
    public_id = f"{folder}/{uuid.uuid4().hex}"
    configure_cloudinary()
    upload_options = {
        "folder": folder,
        "public_id": public_id,
        "resource_type": resource_type,
        "overwrite": False,
        "unique_filename": False,
        "use_filename": False,
        "filename_override": filename,
        "type": "upload",
    }
    try:
        uploaded_file.seek(0)
        is_large_video = resource_type == "video" and size > VIDEO_LARGE_UPLOAD_THRESHOLD
        upload_function = uploader.upload_large if is_large_video else uploader.upload
        if is_large_video:
            upload_options["chunk_size"] = VIDEO_CHUNK_SIZE
        result = upload_function(uploaded_file, **upload_options)
    except CloudinaryError as exc:
        raise CloudinaryStorageError("The media upload failed.") from exc
    finally:
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
