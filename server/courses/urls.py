from django.urls import path

from courses.views import CourseDetailView, CourseListView

urlpatterns = [
    path("", CourseListView.as_view(), name="course-list"),
    path("<str:resource_id>/", CourseDetailView.as_view(), name="course-detail"),
]
