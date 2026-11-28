from django.urls import path

from admin_api.approval_views import (
    IndependentStudentApprovalDecisionView,
    IndependentStudentApprovalDetailsView,
    IndependentStudentApprovalListView,
)
from admin_api.assignment_review_views import (
    AdminAssignmentReviewDetailView,
    AdminAssignmentReviewFileView,
    AdminAssignmentReviewListView,
)
from admin_api.certificate_views import AdminCertificateTemplateView
from admin_api.dashboard_views import AdminEngagementView, AdminOverviewView
from admin_api.directory_views import (
    AdminCollegeDirectoryView,
    AdminCourseDirectoryView,
    AdminCourseDetailView,
    AdminCourseStatusView,
    AdminEnrollmentDirectoryView,
    AdminStudentDirectoryView,
)
from admin_api.media_views import (
    AdminCloudinaryHealthView,
    AdminCourseAssetDeleteView,
    AdminCourseAssetRegisterView,
    AdminCourseAssetSignatureView,
    AdminCourseModuleMediaView,
    AdminCourseVideoUploadSignatureView,
    AdminCourseVideoUploadVerificationView,
    AdminCourseTranscriptView,
)
from admin_api.quiz_generation_views import AdminQuizQuestionGenerationView
from admin_api.settings_views import (
    AdminSettingsAccountDeleteView,
    AdminSettingsAvatarView,
    AdminSettingsPasswordView,
    AdminSettingsProfileView,
    AdminSettingsView,
)
from admin_api.views import AdminDashboardView

urlpatterns = [
    path("dashboard/", AdminDashboardView.as_view(), name="admin-dashboard"),
    path("settings", AdminSettingsView.as_view(), name="admin-settings"),
    path("settings/profile", AdminSettingsProfileView.as_view(), name="admin-settings-profile"),
    path("settings/account", AdminSettingsAccountDeleteView.as_view(), name="admin-settings-account"),
    path(
        "settings/password",
        AdminSettingsPasswordView.as_view(),
        name="admin-settings-password",
    ),
    path(
        "settings/avatar",
        AdminSettingsAvatarView.as_view(),
        name="admin-settings-avatar",
    ),
    path("overview", AdminOverviewView.as_view(), name="admin-overview"),
    path("engagement", AdminEngagementView.as_view(), name="admin-engagement"),
    path(
        "assignment-reviews",
        AdminAssignmentReviewListView.as_view(),
        name="admin-assignment-reviews",
    ),
    path(
        "assignment-reviews/<str:submission_id>",
        AdminAssignmentReviewDetailView.as_view(),
        name="admin-assignment-review-detail",
    ),
    path(
        "assignment-reviews/<str:submission_id>/file",
        AdminAssignmentReviewFileView.as_view(),
        name="admin-assignment-review-file",
    ),
    path("students", AdminStudentDirectoryView.as_view(), name="admin-student-directory"),
    path("colleges", AdminCollegeDirectoryView.as_view(), name="admin-college-directory"),
    path("courses", AdminCourseDirectoryView.as_view(), name="admin-course-directory"),
    path(
        "courses/generate-quiz-questions",
        AdminQuizQuestionGenerationView.as_view(),
        name="admin-generate-quiz-questions",
    ),
    path(
        "courses/<str:course_id>/status",
        AdminCourseStatusView.as_view(),
        name="admin-course-status",
    ),
    path("courses/<str:course_id>", AdminCourseDetailView.as_view(), name="admin-course-detail"),
    path("enrollments", AdminEnrollmentDirectoryView.as_view(), name="admin-enrollment-directory"),
    path(
        "independent-student-approvals",
        IndependentStudentApprovalListView.as_view(),
        name="independent-student-approvals",
    ),
    path(
        "independent-students/<str:student_id>/approval-details",
        IndependentStudentApprovalDetailsView.as_view(),
        name="independent-student-approval-details",
    ),
    path(
        "independent-students/<str:student_id>/approval",
        IndependentStudentApprovalDecisionView.as_view(),
        name="independent-student-approval-decision",
    ),
    path("cloudinary/health", AdminCloudinaryHealthView.as_view(), name="admin-cloudinary-health"),
    path("certificate-template", AdminCertificateTemplateView.as_view(), name="admin-certificate-template"),
    path("course-assets/signature", AdminCourseAssetSignatureView.as_view(), name="admin-course-asset-signature"),
    path("course-assets/delete", AdminCourseAssetDeleteView.as_view(), name="admin-course-asset-delete"),
    path("course-assets/register", AdminCourseAssetRegisterView.as_view(), name="admin-course-asset-register"),
    path(
        "courses/<str:course_id>/modules/<str:module_id>/lessons/<str:lesson_id>/media/video/signature",
        AdminCourseVideoUploadSignatureView.as_view(),
        name="admin-course-video-upload-signature",
    ),
    path(
        "courses/<str:course_id>/modules/<str:module_id>/lessons/<str:lesson_id>/media/video/verify",
        AdminCourseVideoUploadVerificationView.as_view(),
        name="admin-course-video-upload-verification",
    ),
    path(
        "courses/<str:course_id>/modules/<str:module_id>/media/<str:asset_type>",
        AdminCourseModuleMediaView.as_view(),
        name="admin-course-module-media",
    ),
    path(
        "courses/<str:course_id>/modules/<str:module_id>/lessons/<str:lesson_id>/media/transcript",
        AdminCourseTranscriptView.as_view(),
        name="admin-course-transcript",
    ),
]
