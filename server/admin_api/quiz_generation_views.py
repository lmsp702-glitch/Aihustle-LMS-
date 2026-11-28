import json
import logging
import random
import time

from google import genai
from google.genai import types
from httpx import TimeoutException
from rest_framework import serializers, status
from rest_framework.generics import GenericAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from authentication.permissions import IsMainAdmin
from django.conf import settings


logger = logging.getLogger(__name__)

QUESTION_TYPES = ("multiple-choice", "multiple-select", "true-false")
DIFFICULTIES = ("beginner", "intermediate", "advanced", "all-levels")
GEMINI_503_RETRIES = 2
GEMINI_RETRY_INITIAL_DELAY_SECONDS = 1
GEMINI_RETRY_MAX_DELAY_SECONDS = 8


class QuizQuestionGenerationRequestSerializer(serializers.Serializer):
    lessonContent = serializers.CharField(min_length=1, max_length=30000)
    questionCount = serializers.IntegerField(min_value=1, max_value=100)
    difficulty = serializers.ChoiceField(choices=DIFFICULTIES)
    questionTypes = serializers.ListField(
        child=serializers.ChoiceField(choices=QUESTION_TYPES),
        min_length=1,
        max_length=len(QUESTION_TYPES),
    )

    def validate_lessonContent(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Provide lesson content to generate questions.")
        return value

    def validate_questionTypes(self, value):
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Choose each question type only once.")
        return value


def _response_schema(question_types):
    return {
        "type": "OBJECT",
        "properties": {
            "questions": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "type": {"type": "STRING", "enum": question_types},
                        "prompt": {"type": "STRING"},
                        "options": {"type": "ARRAY", "items": {"type": "STRING"}},
                        "correctOptionIndices": {
                            "type": "ARRAY",
                            "items": {"type": "INTEGER"},
                        },
                        "explanation": {"type": "STRING"},
                    },
                    "required": [
                        "type",
                        "prompt",
                        "options",
                        "correctOptionIndices",
                        "explanation",
                    ],
                },
            },
        },
        "required": ["questions"],
    }


def _sleep_before_gemini_retry(attempt, model):
    delay_ceiling = min(
        GEMINI_RETRY_INITIAL_DELAY_SECONDS * (2 ** attempt),
        GEMINI_RETRY_MAX_DELAY_SECONDS,
    )
    delay = random.uniform(0, delay_ceiling)
    logger.info(
        "Gemini quiz generation for model %s received 503; retrying in %.2f seconds.",
        model,
        delay,
    )
    time.sleep(delay)


def _generate_with_503_retries(client, model, prompt, config, max_retries):
    for attempt in range(max_retries + 1):
        try:
            return client.models.generate_content(
                model=model,
                contents=prompt,
                config=config,
            )
        except Exception as exc:
            if getattr(exc, "code", None) != 503 or attempt == max_retries:
                raise
            _sleep_before_gemini_retry(attempt, model)


def _generate_with_gemini(lesson_content, question_count, difficulty, question_types):
    question_types_text = ", ".join(question_types)
    prompt = (
        "Create assessment questions using only the supplied lesson content. "
        "Do not invent facts or rely on outside knowledge. Return exactly "
        f"{question_count} questions at {difficulty} difficulty. Each question's "
        f"type must be one of: {question_types_text}. Distribute types as evenly "
        "as possible when more than one type is requested. For multiple-choice, "
        "provide 2 to 10 options and exactly one correct option. For multiple-select, "
        "provide 2 to 10 options and at least two correct options. For true-false, "
        'use options exactly ["True", "False"] and one correct option. '
        "Keep prompts concise, include a brief explanation, and set "
        "correctOptionIndices to zero-based option indices.\n\n"
        f"Lesson content:\n{lesson_content}"
    )
    max_output_tokens = min(32768, max(2048, question_count * 350))
    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=_response_schema(question_types),
        temperature=0.2,
        max_output_tokens=max_output_tokens,
        thinking_config=types.ThinkingConfig(
            thinking_level=types.ThinkingLevel.LOW,
        ),
    )
    client = genai.Client(
        api_key=settings.GEMINI_API_KEY,
        http_options=types.HttpOptions(
            timeout=120_000,
            retry_options=types.HttpRetryOptions(attempts=1),
        ),
    )
    try:
        try:
            response = _generate_with_503_retries(
                client,
                settings.GEMINI_MODEL,
                prompt,
                config,
                max_retries=0,
            )
        except Exception as primary_error:
            fallback_model = settings.GEMINI_FALLBACK_MODEL
            if (
                getattr(primary_error, "code", None) != 503
                or not fallback_model
                or fallback_model == settings.GEMINI_MODEL
            ):
                raise
            error_detail = str(primary_error)
            if settings.GEMINI_API_KEY:
                error_detail = error_detail.replace(settings.GEMINI_API_KEY, "[redacted]")
            logger.warning(
                "Primary Gemini model %s returned 503; retrying with fallback model %s (detail=%s).",
                settings.GEMINI_MODEL,
                fallback_model,
                error_detail,
            )
            _sleep_before_gemini_retry(0, settings.GEMINI_MODEL)
            response = _generate_with_503_retries(
                client,
                fallback_model,
                prompt,
                config,
                max_retries=GEMINI_503_RETRIES,
            )
        return response.text
    finally:
        client.close()


def _validated_questions(response_text, question_count, question_types):
    try:
        result = json.loads(response_text)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("Gemini returned invalid JSON.") from exc

    questions = result.get("questions") if isinstance(result, dict) else None
    if not isinstance(questions, list) or len(questions) != question_count:
        raise ValueError("Gemini returned the wrong number of questions.")

    validated = []
    for question in questions:
        if not isinstance(question, dict):
            raise ValueError("Gemini returned an invalid question.")

        question_type = question.get("type")
        prompt = question.get("prompt")
        options = question.get("options")
        correct_indices = question.get("correctOptionIndices")
        explanation = question.get("explanation", "")
        if (
            question_type not in question_types
            or not isinstance(prompt, str)
            or not prompt.strip()
            or len(prompt) > 2000
            or not isinstance(options, list)
            or not 2 <= len(options) <= 10
            or any(not isinstance(option, str) or not option.strip() or len(option) > 500 for option in options)
            or not isinstance(correct_indices, list)
            or any(type(index) is not int or index < 0 or index >= len(options) for index in correct_indices)
            or len(set(correct_indices)) != len(correct_indices)
            or not isinstance(explanation, str)
            or len(explanation) > 2000
        ):
            raise ValueError("Gemini returned a question with invalid fields.")

        if question_type in {"multiple-choice", "true-false"} and len(correct_indices) != 1:
            raise ValueError("Gemini returned an invalid correct answer.")
        if question_type == "multiple-select" and len(correct_indices) < 2:
            raise ValueError("Gemini returned an invalid multiple-select answer.")

        if question_type == "true-false":
            if [option.strip().lower() for option in options] != ["true", "false"]:
                raise ValueError("Gemini returned invalid true/false options.")
            options = ["True", "False"]

        validated.append({
            "type": question_type,
            "prompt": prompt.strip(),
            "options": [option.strip() for option in options],
            "correctOptionIndices": correct_indices,
            "explanation": explanation.strip(),
        })
    return validated


class AdminQuizQuestionGenerationView(GenericAPIView):
    permission_classes = [IsAuthenticated, IsMainAdmin]
    serializer_class = QuizQuestionGenerationRequestSerializer

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        if not settings.GEMINI_API_KEY:
            return Response(
                {"message": "AI quiz generation is not configured. Set GEMINI_API_KEY on the server."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        data = serializer.validated_data
        try:
            response_text = _generate_with_gemini(
                data["lessonContent"],
                data["questionCount"],
                data["difficulty"],
                data["questionTypes"],
            )
        except Exception as exc:
            error_code = getattr(exc, "code", None)
            error_detail = str(exc)
            if settings.GEMINI_API_KEY:
                error_detail = error_detail.replace(settings.GEMINI_API_KEY, "[redacted]")
            logger.warning(
                "Gemini quiz generation request failed (type=%s, code=%s, detail=%s).",
                type(exc).__name__,
                error_code if isinstance(error_code, int) else "unavailable",
                error_detail,
            )
            if error_code == 504 or isinstance(exc, (TimeoutException, TimeoutError)):
                return Response(
                    {"message": "Gemini generation timed out. Check the quiz draft before trying again."},
                    status=status.HTTP_504_GATEWAY_TIMEOUT,
                )
            if error_code == 429:
                return Response(
                    {"message": "Gemini quota or rate limit reached. Wait briefly and try again."},
                    status=status.HTTP_429_TOO_MANY_REQUESTS,
                )
            if error_code in {500, 502, 503, 504}:
                return Response(
                    {"message": "Gemini is temporarily unavailable. Please try again shortly."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            if error_code in {401, 403}:
                return Response(
                    {"message": "Gemini rejected the server credentials or API access. Check the server configuration."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            return Response(
                {"message": "Gemini could not generate questions. Check the model configuration and try again."},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        try:
            questions = _validated_questions(
                response_text,
                data["questionCount"],
                data["questionTypes"],
            )
        except ValueError:
            logger.warning("Gemini returned invalid quiz question data.")
            return Response(
                {"message": "Gemini returned invalid question data. Please try generating the questions again."},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response({"questions": questions}, status=status.HTTP_200_OK)
