from functools import lru_cache

from django.conf import settings
from pymongo import MongoClient


@lru_cache(maxsize=1)
def get_mongo_client():
    if not settings.MONGODB_URI:
        raise RuntimeError("MONGODB_URI is not configured.")
    return MongoClient(settings.MONGODB_URI, serverSelectionTimeoutMS=5000)


def get_database():
    return get_mongo_client()[settings.MONGODB_DATABASE]


def check_mongo_connection():
    get_database().command("ping")


def collection(name):
    return get_database()[name]
