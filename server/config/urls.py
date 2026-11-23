from django.urls import include, path
from drf_spectacular.views import (
    SpectacularAPIView,
    SpectacularSwaggerView,
)

from core.views import HealthCheckView

urlpatterns = [
    path("api/health/", HealthCheckView.as_view(), name="health"),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path(
        "api/docs/",
        SpectacularSwaggerView.as_view(url_name="schema"),
        name="api-docs",
    ),
    path("api/auth/", include("authentication.urls")),
    path("api/users/", include("users.urls")),
    path("api/colleges/", include("colleges.urls")),
    path("api/courses/", include("courses.urls")),
    path("api/assignments/", include("assignments.urls")),
    path("api/submissions/", include("submissions.urls")),
    path("api/admin/", include("admin_api.urls")),
]
