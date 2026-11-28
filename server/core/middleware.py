import logging
import re
import time
import uuid


_VIDEO_UPLOAD_PATH = re.compile(
    r"^/api/admin/courses/[^/]+/modules/[^/]+/media/video/?$"
)
_logger = logging.getLogger("course_video_upload")


def log_video_upload_stage(trace_id, stage, **details):
    if not trace_id:
        return
    detail_text = " ".join(f"{key}={value}" for key, value in details.items())
    _logger.info("trace_id=%s stage=%s %s", trace_id, stage, detail_text)


class VideoUploadDiagnosticsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.method != "POST" or not _VIDEO_UPLOAD_PATH.fullmatch(request.path_info):
            return self.get_response(request)

        trace_id = uuid.uuid4().hex[:12]
        request.video_upload_trace_id = trace_id
        started_at = time.perf_counter()
        log_video_upload_stage(
            trace_id,
            "request_received",
            content_length=request.META.get("CONTENT_LENGTH", "unknown"),
        )
        try:
            response = self.get_response(request)
        except Exception as exc:
            log_video_upload_stage(
                trace_id,
                "request_exception",
                error_type=type(exc).__name__,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
            )
            raise

        log_video_upload_stage(
            trace_id,
            "response_completed",
            status=response.status_code,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
        )
        return response
