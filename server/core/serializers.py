from rest_framework import serializers


class CollegeSerializer(serializers.Serializer):
    id = serializers.CharField(read_only=True)
    name = serializers.CharField(max_length=200)
    location = serializers.CharField(max_length=200, required=False, allow_blank=True)
    description = serializers.CharField(required=False, allow_blank=True)
    created_by = serializers.CharField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)


class CourseSerializer(serializers.Serializer):
    id = serializers.CharField(read_only=True)
    name = serializers.CharField(max_length=200)
    description = serializers.CharField(required=False, allow_blank=True)
    college_id = serializers.CharField(max_length=24, required=False, allow_blank=True)
    instructor_id = serializers.CharField(max_length=24, required=False, allow_blank=True)
    created_by = serializers.CharField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)


class AssignmentSerializer(serializers.Serializer):
    id = serializers.CharField(read_only=True)
    title = serializers.CharField(max_length=200)
    description = serializers.CharField(required=False, allow_blank=True)
    course_id = serializers.CharField(max_length=24)
    due_date = serializers.DateTimeField(required=False, allow_null=True)
    created_by = serializers.CharField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)


class SubmissionSerializer(serializers.Serializer):
    id = serializers.CharField(read_only=True)
    assignment_id = serializers.CharField(max_length=24)
    student_id = serializers.CharField(read_only=True)
    content = serializers.CharField(required=False, allow_blank=True)
    file_url = serializers.URLField(required=False, allow_blank=True)
    status = serializers.ChoiceField(
        choices=("submitted", "graded", "returned"),
        required=False,
        default="submitted",
    )
    grade = serializers.CharField(required=False, allow_blank=True)
    feedback = serializers.CharField(required=False, allow_blank=True)
    created_at = serializers.DateTimeField(read_only=True)


class HealthSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=("ok", "degraded"))
    database = serializers.ChoiceField(choices=("connected", "unavailable"))
    detail = serializers.CharField(required=False)
    timestamp = serializers.DateTimeField()


class UserSummarySerializer(serializers.Serializer):
    id = serializers.CharField()
    name = serializers.CharField()
    email = serializers.EmailField()
    role = serializers.CharField()
    created_at = serializers.DateTimeField(required=False)
