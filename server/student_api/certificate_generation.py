import hashlib
import io
import re
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime
from pathlib import Path

from PIL import Image, UnidentifiedImageError
import reportlab
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.utils import ImageReader, simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from pymongo.errors import DuplicateKeyError

from core.cloudinary_storage import is_cloudinary_delivery_url


MAX_TEMPLATE_BYTES = 4 * 1024 * 1024
PAGE_SIZE = landscape(A4)
_FONT_DIRECTORY = Path(reportlab.__file__).parent / "fonts"
pdfmetrics.registerFont(TTFont("CertificateVera", str(_FONT_DIRECTORY / "Vera.ttf")))
pdfmetrics.registerFont(TTFont("CertificateVeraBold", str(_FONT_DIRECTORY / "VeraBd.ttf")))


class CertificateRenderError(Exception):
    pass


class _CloudinaryRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        if not is_cloudinary_delivery_url(new_url):
            raise CertificateRenderError("The saved certificate background redirected to an untrusted host.")
        return super().redirect_request(request, response, code, message, headers, new_url)


def issue_course_completion_certificate(
    certificates,
    *,
    user_id,
    student_name,
    course_id,
    course_name,
    template,
    completed_at,
):
    key = hashlib.sha256(f"{user_id}:{course_id}".encode("utf-8")).hexdigest()
    record_id = f"course-completion-{key}"
    existing = certificates.find_one({"_id": record_id})
    if existing is not None:
        return existing

    template_snapshot = None
    if template:
        template_snapshot = {
            key: template.get(key)
            for key in ("secureUrl", "publicId", "resourceType", "format", "originalName", "bytes", "version")
        }
    certificate = {
        "_id": record_id,
        "certificateId": f"AH-{uuid.uuid4().hex[:16].upper()}",
        "studentId": str(user_id),
        "userId": str(user_id),
        "studentName": student_name,
        "courseId": str(course_id),
        "courseName": course_name,
        "issuedAt": completed_at,
        "completedAt": completed_at,
        "templateSnapshot": template_snapshot,
        "renderVersion": 1,
        "source": "course_completion",
    }
    try:
        certificates.insert_one(certificate)
        return certificate
    except DuplicateKeyError:
        existing = certificates.find_one({"_id": record_id})
        if existing is not None:
            return existing
        raise


def _download_template(template):
    url = template.get("secureUrl") if isinstance(template, dict) else None
    if not is_cloudinary_delivery_url(url):
        raise CertificateRenderError("The saved certificate background URL is invalid.")

    request = urllib.request.Request(url, headers={"User-Agent": "aiHustle certificate renderer"})
    opener = urllib.request.build_opener(_CloudinaryRedirectHandler())
    try:
        with opener.open(request, timeout=12) as response:
            if not is_cloudinary_delivery_url(response.geturl()):
                raise CertificateRenderError("The saved certificate background is not hosted by Cloudinary.")
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > MAX_TEMPLATE_BYTES:
                raise CertificateRenderError("The saved certificate background exceeds its size limit.")
            data = response.read(MAX_TEMPLATE_BYTES + 1)
    except CertificateRenderError:
        raise
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CertificateRenderError("The saved certificate background could not be downloaded.") from exc

    if not data or len(data) > MAX_TEMPLATE_BYTES:
        raise CertificateRenderError("The saved certificate background is empty or too large.")
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in {"PNG", "JPEG"}:
                raise CertificateRenderError("The saved certificate background is not a PNG or JPG image.")
            source.load()
            return source.convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise CertificateRenderError("The saved certificate background is not a valid image.") from exc


def _certificate_date(value):
    if isinstance(value, datetime):
        return value.strftime("%d %B %Y")
    if isinstance(value, date):
        return value.strftime("%d %B %Y")
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).strftime("%d %B %Y")
        except ValueError:
            return value
    return "Date unavailable"


def _draw_wrapped_centered(pdf, text, *, y, font, size, max_width, leading, color):
    pdf.setFillColor(color)
    pdf.setFont(font, size)
    for line in simpleSplit(str(text or ""), font, size, max_width):
        pdf.drawCentredString(PAGE_SIZE[0] / 2, y, line)
        y -= leading
    return y


def render_certificate_pdf(certificate):
    template = certificate.get("templateSnapshot")
    background = _download_template(template) if template else None
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=PAGE_SIZE, pageCompression=1)
    width, height = PAGE_SIZE

    if background:
        pdf.drawImage(ImageReader(background), 0, 0, width=width, height=height, mask="auto")
    else:
        pdf.setFillColor(colors.white)
        pdf.rect(0, 0, width, height, fill=1, stroke=0)
        pdf.setStrokeColor(colors.HexColor("#34796e"))
        pdf.setLineWidth(2)
        pdf.rect(24, 24, width - 48, height - 48, fill=0, stroke=1)
        pdf.setStrokeColor(colors.HexColor("#d9b34d"))
        pdf.setLineWidth(0.7)
        pdf.rect(34, 34, width - 68, height - 68, fill=0, stroke=1)
        pdf.setFillColor(colors.HexColor("#34796e"))
        pdf.setFont("CertificateVeraBold", 12)
        pdf.drawCentredString(width / 2, height - 72, "aiHustle")

    dark_teal = colors.HexColor("#174c47")
    gold = colors.HexColor("#b18926")
    _draw_wrapped_centered(
        pdf,
        "CERTIFICATE OF COMPLETION",
        y=height - 145,
        font="CertificateVeraBold",
        size=22,
        max_width=width - 100,
        leading=28,
        color=dark_teal,
    )
    _draw_wrapped_centered(
        pdf,
        "This certificate is proudly presented to",
        y=height - 198,
        font="CertificateVera",
        size=12,
        max_width=width - 100,
        leading=18,
        color=colors.HexColor("#485651"),
    )
    _draw_wrapped_centered(
        pdf,
        certificate.get("studentName") or "Student",
        y=height - 244,
        font="CertificateVeraBold",
        size=27,
        max_width=width - 100,
        leading=33,
        color=dark_teal,
    )
    _draw_wrapped_centered(
        pdf,
        "for successfully completing",
        y=height - 296,
        font="CertificateVera",
        size=12,
        max_width=width - 100,
        leading=18,
        color=colors.HexColor("#485651"),
    )
    _draw_wrapped_centered(
        pdf,
        certificate.get("courseName") or "Course",
        y=height - 335,
        font="CertificateVeraBold",
        size=19,
        max_width=width - 100,
        leading=25,
        color=dark_teal,
    )
    pdf.setStrokeColor(gold)
    pdf.setLineWidth(1)
    pdf.line(width * 0.3, height - 362, width * 0.7, height - 362)
    _draw_wrapped_centered(
        pdf,
        f"Completed on {_certificate_date(certificate.get('completedAt') or certificate.get('issuedAt'))}",
        y=height - 405,
        font="CertificateVera",
        size=11,
        max_width=width - 100,
        leading=15,
        color=colors.HexColor("#485651"),
    )
    certificate_id = re.sub(r"[^A-Za-z0-9_-]", "", str(certificate.get("certificateId") or ""))
    _draw_wrapped_centered(
        pdf,
        f"Certificate ID: {certificate_id}",
        y=39,
        font="CertificateVera",
        size=8,
        max_width=width - 100,
        leading=10,
        color=colors.HexColor("#485651"),
    )
    pdf.showPage()
    pdf.save()
    return output.getvalue()
