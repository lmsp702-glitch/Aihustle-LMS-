from django.urls import path

from admin_api.approval_views import (
    IndependentStudentApprovalDecisionView,
    IndependentStudentApprovalDetailsView,
    IndependentStudentApprovalListView,
)
from admin_api.dashboard_views import AdminEngagementView, AdminOverviewView
from admin_api.directory_views import (
    AdminCollegeDirectoryView,
    AdminCourseDirectoryView,
    AdminEnrollmentDirectoryView,
    AdminStudentDirectoryView,
)
from admin_api.media_views import (
    AdminCloudinaryHealthView,
    AdminCourseAssetDeleteView,
    AdminCourseAssetRegisterView,
    AdminCourseAssetSignatureView,
    AdminCourseModuleMediaView,
    AdminCourseTranscriptView,
)
from admin_api.views import AdminDashboardView

urlpatterns = [
    path("dashboard/", AdminDashboardView.as_view(), name="admin-dashboard"),
    path("overview", AdminOverviewView.as_view(), name="admin-overview"),
    path("engagement", AdminEngagementView.as_view(), name="admin-engagement"),
    path("students", AdminStudentDirectoryView.as_view(), name="admin-student-directory"),
    path("colleges", AdminCollegeDirectoryView.as_view(), name="admin-college-directory"),
    path("courses", AdminCourseDirectoryView.as_view(), name="admin-course-directory"),
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
    path("course-assets/signature", AdminCourseAssetSignatureView.as_view(), name="admin-course-asset-signature"),
    path("course-assets/delete", AdminCourseAssetDeleteView.as_view(), name="admin-course-asset-delete"),
    path("course-assets/register", AdminCourseAssetRegisterView.as_view(), name="admin-course-asset-register"),
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
