from django.urls import path, re_path

from authentication.views import (
    CollegeAdminCreateView,
    GoogleLoginView,
    GoogleRegistrationView,
    LoginView,
    MeView,
    RefreshView,
    RegisterView,
    DashboardSessionView,
    RegistrationEmailSendView,
    RegistrationEmailVerifyView,
    UsernameAvailabilityView,
)

urlpatterns = [
    path("register/", RegisterView.as_view(), name="register"),
    path("login/", LoginView.as_view(), name="login"),
    path("check-username", UsernameAvailabilityView.as_view(), name="check-username"),
    path(
        "registration/email/send",
        RegistrationEmailSendView.as_view(),
        name="registration-email-send",
    ),
    path(
        "registration/email/verify",
        RegistrationEmailVerifyView.as_view(),
        name="registration-email-verify",
    ),
    path("dashboard/<str:role>", DashboardSessionView.as_view(), name="dashboard-session"),
    path("google/register", GoogleRegistrationView.as_view(), name="google-register"),
    re_path(r"^google/?$", GoogleLoginView.as_view(), name="google-login"),
    path("refresh/", RefreshView.as_view(), name="refresh"),
    path("me/", MeView.as_view(), name="auth-me"),
    path(
        "college-admin/",
        CollegeAdminCreateView.as_view(),
        name="college-admin-create",
    ),
]
