from django.urls import path

from colleges.views import CollegeDetailView, CollegeListView

urlpatterns = [
    path("", CollegeListView.as_view(), name="college-list"),
    path("<str:resource_id>/", CollegeDetailView.as_view(), name="college-detail"),
]
