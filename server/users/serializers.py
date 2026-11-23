from rest_framework import serializers


class UserProfileSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=150, required=False)
    email = serializers.EmailField(read_only=True)
    role = serializers.CharField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)
