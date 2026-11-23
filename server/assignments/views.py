from drf_spectacular.utils import extend_schema

from core.serializers import AssignmentSerializer
from core.views import MongoResourceView


class AssignmentListView(MongoResourceView):
    collection_name = "assignments"
    serializer_class = AssignmentSerializer
    http_method_names = ["get", "post", "head", "options"]

    @extend_schema(
        operation_id="assignments_list",
        responses=AssignmentSerializer(many=True),
    )
    def get(self, request):
        return super().get(request)

    @extend_schema(
        operation_id="assignments_create",
        request=AssignmentSerializer,
        responses={201: AssignmentSerializer},
    )
    def post(self, request):
        return super().post(request)


class AssignmentDetailView(AssignmentListView):
    http_method_names = ["get", "put", "patch", "delete", "head", "options"]

    @extend_schema(
        operation_id="assignments_retrieve",
        responses=AssignmentSerializer,
    )
    def get(self, request, resource_id):
        return super().get(request, resource_id)

    @extend_schema(
        operation_id="assignments_replace",
        request=AssignmentSerializer,
        responses=AssignmentSerializer,
    )
    def put(self, request, resource_id):
        return super().put(request, resource_id)

    @extend_schema(
        operation_id="assignments_update",
        request=AssignmentSerializer,
        responses=AssignmentSerializer,
    )
    def patch(self, request, resource_id):
        return super().patch(request, resource_id)

    @extend_schema(operation_id="assignments_delete", responses={204: None})
    def delete(self, request, resource_id):
        return super().delete(request, resource_id)
