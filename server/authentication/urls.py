from django.urls import path

from authentication.views import (
    CollegeAdminCreateView,
    LoginView,
    MeView,
    RefreshView,
    RegisterView,
)

urlpatterns = [
    path("register/", RegisterView.as_view(), name="register"),
    path("login/", LoginView.as_view(), name="login"),
    path("refresh/", RefreshView.as_view(), name="refresh"),
    path("me/", MeView.as_view(), name="auth-me"),
    path(
        "college-admin/",
        CollegeAdminCreateView.as_view(),
        name="college-admin-create",
    ),
]
