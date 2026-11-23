from drf_spectacular.utils import extend_schema

from core.serializers import CourseSerializer
from core.views import MongoResourceView


class CourseListView(MongoResourceView):
    collection_name = "courses"
    serializer_class = CourseSerializer
    http_method_names = ["get", "post", "head", "options"]

    @extend_schema(operation_id="courses_list", responses=CourseSerializer(many=True))
    def get(self, request):
        return super().get(request)

    @extend_schema(
        operation_id="courses_create",
        request=CourseSerializer,
        responses={201: CourseSerializer},
    )
    def post(self, request):
        return super().post(request)


class CourseDetailView(CourseListView):
    http_method_names = ["get", "put", "patch", "delete", "head", "options"]

    @extend_schema(operation_id="courses_retrieve", responses=CourseSerializer)
    def get(self, request, resource_id):
        return super().get(request, resource_id)

    @extend_schema(
        operation_id="courses_replace",
        request=CourseSerializer,
        responses=CourseSerializer,
    )
    def put(self, request, resource_id):
        return super().put(request, resource_id)

    @extend_schema(
        operation_id="courses_update",
        request=CourseSerializer,
        responses=CourseSerializer,
    )
    def patch(self, request, resource_id):
        return super().patch(request, resource_id)

    @extend_schema(operation_id="courses_delete", responses={204: None})
    def delete(self, request, resource_id):
        return super().delete(request, resource_id)
