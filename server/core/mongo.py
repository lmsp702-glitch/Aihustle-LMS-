from bson import ObjectId
from bson.errors import InvalidId


def parse_object_id(value):
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        return None


def serialize_document(document):
    if document is None:
        return None
    result = dict(document)
    result["id"] = str(result.pop("_id"))
    return result
