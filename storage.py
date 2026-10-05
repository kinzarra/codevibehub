"""Hetzner Object Storage (S3). Переменные: S3_ENDPOINT_URL, S3_REGION, S3_AVATAR_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY."""
import os
from functools import lru_cache

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

REQUIRED = ("S3_ENDPOINT_URL", "S3_AVATAR_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY")


def configured() -> bool:
    return all(os.environ.get(k) for k in REQUIRED)


@lru_cache
def _client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT_URL"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        region_name=os.environ.get("S3_REGION", "hel1"),
        config=Config(connect_timeout=5, read_timeout=10, retries={"max_attempts": 2}),
    )


def get_object(key: str) -> tuple[bytes, str] | None:
    """Блокирующий вызов — из async-кода запускать через run_in_threadpool."""
    try:
        obj = _client().get_object(Bucket=os.environ["S3_AVATAR_BUCKET"], Key=key)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise
    return obj["Body"].read(), obj.get("ContentType", "application/octet-stream")


def put_object(key: str, body: bytes, content_type: str) -> None:
    _client().put_object(Bucket=os.environ["S3_AVATAR_BUCKET"], Key=key, Body=body, ContentType=content_type)
