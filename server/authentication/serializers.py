from rest_framework import serializers


class RegisterSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=150)
    email = serializers.EmailField()
    password = serializers.CharField(min_length=8, write_only=True, trim_whitespace=False)

    def validate_name(self, value):
        if not value.strip():
            raise serializers.ValidationError("Name is required.")
        return value.strip()

    def validate_email(self, value):
        return value.strip().lower()


class CollegeAdminCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=150)
    email = serializers.EmailField()
    password = serializers.CharField(min_length=8, write_only=True, trim_whitespace=False)

    def validate_name(self, value):
        if not value.strip():
            raise serializers.ValidationError("Name is required.")
        return value.strip()

    def validate_email(self, value):
        return value.strip().lower()


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, trim_whitespace=False)


class RefreshSerializer(serializers.Serializer):
    refresh = serializers.CharField()


class TokenPairSerializer(serializers.Serializer):
    user = serializers.DictField()
    access = serializers.CharField()
    refresh = serializers.CharField()
    token_type = serializers.CharField()
    expires_in = serializers.IntegerField()


class AccessTokenSerializer(serializers.Serializer):
    access = serializers.CharField()
    token_type = serializers.CharField()
