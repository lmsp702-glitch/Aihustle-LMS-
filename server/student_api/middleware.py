from django.http import JsonResponse
from pymongo.errors import PyMongoError


class ApiJsonErrorMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if (
            request.path.startswith("/api/")
            and response.status_code == 404
            and response.get("Content-Type", "").startswith("text/html")
        ):
            return JsonResponse({"message": "API route not found."}, status=404)
        return response

    def process_exception(self, request, exception):
        if request.path.startswith("/api/") and isinstance(exception, PyMongoError):
            return JsonResponse(
                {"message": "The database service is temporarily unavailable."},
                status=503,
            )
        return None
