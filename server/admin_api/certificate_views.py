import logging
from datetime import datetime, timezone

from PIL import Image, UnidentifiedImageError
from pymongo.errors import PyMongoError
from rest_framework import status
from rest_framework.parsers import FormParser, MultiPartParser
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
MAX_TEMPLATE_PIXELS = 40_000_000


def _template_response(document):
    if not document:
        return {"uploaded": False, "secureUrl": "", "fileName": ""}
    return {
        "uploaded": True,
        "secureUrl": document.get("secureUrl") or "",
        "fileName": document.get("originalName") or "",
        "format": document.get("format") or "",
        "bytes": document.get("bytes") or 0,
        "updatedAt": document.get("updatedAt"),
    }


class AdminCertificateTemplateView(APIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    parser_classes = [MultiPartParser, FormParser]

    def get(self, request):
        document = collection("certificate_templates").find_one({"_id": "active"})
        return Response(_template_response(document))

    def post(self, request):
        uploaded_file = request.FILES.get("template")
        if uploaded_file is None:
            return Response({"message": "Choose a PNG or JPG certificate background."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            with Image.open(uploaded_file) as image:
                if image.format not in {"PNG", "JPEG"}:
                    return Response({"message": "Certificate backgrounds must be PNG or JPG images."}, status=status.HTTP_400_BAD_REQUEST)
                if image.width * image.height > MAX_TEMPLATE_PIXELS:
                    return Response({"message": "The certificate background dimensions are too large."}, status=status.HTTP_400_BAD_REQUEST)
                image.verify()
        except (UnidentifiedImageError, Image.DecompressionBombError, OSError):
            return Response({"message": "The certificate background is not a valid PNG or JPG image."}, status=status.HTTP_400_BAD_REQUEST)
        finally:
            uploaded_file.seek(0)
        try:
            metadata = upload_media(
                uploaded_file,
                "certificate_template",
                owner_id=request.user.id,
            )
        except MediaValidationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except (CloudinaryConfigurationError, CloudinaryStorageError) as exc:
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        updated_at = datetime.now(timezone.utc)
        document = {
            "_id": "active",
            "secureUrl": metadata["secureUrl"],
            "publicId": metadata["publicId"],
            "resourceType": metadata["resourceType"],
            "format": metadata["format"],
            "bytes": metadata["bytes"],
            "originalName": metadata["originalName"],
            "width": metadata.get("width"),
            "height": metadata.get("height"),
            "version": metadata.get("version"),
            "updatedAt": updated_at,
            "updatedBy": str(request.user.id),
        }
        try:
            collection("certificate_templates").update_one(
                {"_id": "active"},
                {"$set": {key: value for key, value in document.items() if key != "_id"}},
                upsert=True,
            )
        except (PyMongoError, RuntimeError):
            logger.exception("Could not save the active certificate template metadata.")
            try:
                delete_media(metadata["publicId"], metadata["resourceType"])
            except (CloudinaryConfigurationError, CloudinaryStorageError, MediaValidationError):
                logger.warning("Unable to clean up an unlinked certificate template upload.")
            return Response(
                {"message": "The certificate image uploaded, but its settings could not be saved."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(_template_response(document), status=status.HTTP_200_OK)
