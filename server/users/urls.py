from django.urls import path

from users.views import MyProfileView, UserDetailView, UserListView

urlpatterns = [
    path("", UserListView.as_view(), name="users-list"),
    path("me/", MyProfileView.as_view(), name="users-me"),
    path("<str:user_id>/", UserDetailView.as_view(), name="users-detail"),
]
