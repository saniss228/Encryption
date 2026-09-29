"""Pydantic-схемы запросов. Валидация на входе — часть модели угроз."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

USERNAME_RE = r"^[a-zA-Z0-9_]{3,32}$"


class KeyBundle(BaseModel):
    ik_dh_pub: str = Field(min_length=16)
    ik_sign_pub: str = Field(min_length=16)
    rsa_pub: str = Field(min_length=16)
    spk_pub: str = Field(min_length=16)
    spk_sig: str = Field(min_length=16)
    one_time_keys: list[str] = Field(default_factory=list, max_length=200)


class DeviceInfo(BaseModel):
    device_id: str = Field(min_length=8, max_length=128)
    name: str = Field(default="", max_length=64)
    platform: Literal["web", "windows", "linux", "macos", "android", "ios", "unknown"] = "unknown"
    app_version: str = Field(default="", max_length=32)
    fingerprint: str = Field(default="", max_length=256)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    display_name: str = Field(default="", max_length=64)
    auth_hash: str = Field(min_length=32, max_length=512,
                           description="PBKDF2-SHA512(пароль, соль=username) — пароль в открытом виде не уходит")
    keys: KeyBundle
    device: DeviceInfo
    key_backup: dict[str, Any] | None = None
    recovery: dict[str, Any] | None = None
    recovery_hint: str = Field(default="", max_length=128)

    @field_validator("username")
    @classmethod
    def check_username(cls, v: str) -> str:
        import re
        if not re.match(USERNAME_RE, v):
            raise ValueError("Логин: 3–32 символа, латиница, цифры и _")
        return v


class ChallengeRequest(BaseModel):
    username: str
    device: DeviceInfo


class LoginRequest(BaseModel):
    username: str
    auth_hash: str = Field(min_length=32, max_length=512)
    device: DeviceInfo


class RefreshRequest(BaseModel):
    refresh_token: str


class RecoverRequest(BaseModel):
    """Восстановление по 24-словной фразе (BIP39). Фраза не уходит на сервер целиком."""
    username: str
    recovery_phrase: str = Field(default="", max_length=1024,
                                 description="необязательно: фраза остаётся на устройстве, сервер проверяет только её хеш")
    phrase_hash: str = Field(min_length=32, max_length=512,
                             description="PBKDF2-SHA512(нормализованная фраза, salt=encryption:recover:<логин>)")
    new_auth_hash: str = Field(min_length=32, max_length=512)
    keys: KeyBundle
    device: DeviceInfo
    key_backup: dict[str, Any] | None = None
    recovery: dict[str, Any] | None = None


class RecoverKeysRequest(BaseModel):
    """Получить бэкап ключей по фразе (без смены пароля)."""
    username: str
    recovery_phrase: str = Field(default="", max_length=512)
    phrase_hash: str = Field(min_length=32, max_length=512)


class PairStartRequest(BaseModel):
    device: DeviceInfo


class PairApproveRequest(BaseModel):
    code: str = Field(min_length=4, max_length=12)
    key_bundle: str | None = None


class PairClaimRequest(BaseModel):
    pair_id: str
    code: str = Field(min_length=4, max_length=12)
    device: DeviceInfo


class UpdateMeRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=64)
    about: str | None = Field(default=None, max_length=256)
    avatar_id: str | None = None


class ChatCreateRequest(BaseModel):
    type: Literal["direct", "group", "saved"] = "direct"
    peer_username: str | None = None
    title: str = Field(default="", max_length=128)
    members: list[str] = Field(default_factory=list, max_length=200)
    ttl_seconds: int = 0


class ChatUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=128)
    avatar_id: str | None = None
    ttl_seconds: int | None = Field(default=None, ge=0, le=90 * 24 * 3600)


class MemberUpdateRequest(BaseModel):
    action: Literal["add", "remove", "promote", "demote"]
    username: str | None = None
    user_id: int | None = None


class MessageCreateRequest(BaseModel):
    """
    Конверт с двойным шифрованием. Сервер его не разбирает — только проверяет форму.
    payload = {
      "v": 2,
      "l1": {"alg":"AES-256-GCM","iv":..,"ct":..},           # слой 1: AES-GCM
      "wrap": {"<uid>": {"rsa":..,"dh":..,"sig":..}},        # слой 2: RSA-OAEP + ECDH
      "ct":  ".."                                            # ECDH-обёртка (forward secrecy)
    }
    """
    chat_id: str
    payload: dict[str, Any]
    type: Literal["text", "image", "file", "voice", "video", "sticker", "system",
                  "contact", "location", "poll", "call"] = "text"
    reply_to: str | None = None
    thread_root: str | None = None
    forward_from: str | None = None
    attachment_id: str | None = None
    attachment_meta: dict[str, Any] | None = None
    ttl_seconds: int | None = Field(default=None, ge=0, le=90 * 24 * 3600)
    burn_after_read: bool = False
    client_msg_id: str | None = Field(default=None, max_length=64)


class MessageUpdateRequest(BaseModel):
    payload: dict[str, Any]


class ReactionRequest(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)


class ReceiptRequest(BaseModel):
    state: Literal["delivered", "read"]


class FileInitRequest(BaseModel):
    chat_id: str | None = None
    size: int = Field(ge=0)
    kind: Literal["file", "image", "voice", "video", "avatar"] = "file"
    mime: str = Field(default="", max_length=128)
    name_enc: str = Field(default="", max_length=512)
    key_wrap: str = Field(default="", max_length=4096)
    chunk_size: int = Field(default=1 << 20, ge=64 * 1024, le=8 << 20)
    sha256: str = Field(default="", max_length=64)


# ── Админ-панель ───────────────────────────────────────────────────────────
class AdminUserActionRequest(BaseModel):
    reason: str = Field(default="", max_length=256)


class AdminRoleRequest(BaseModel):
    role: Literal["user", "admin"] = "user"


class AdminBroadcastRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    level: Literal["info", "warning", "critical"] = "info"
    ttl_seconds: int = Field(default=0, ge=0, le=90 * 24 * 3600)


class AdminSettingsRequest(BaseModel):
    registration_open: bool | None = None
    welcome_note: str | None = Field(default=None, max_length=500)
    friends_only: bool | None = None   # писать можно только друзьям (по умолчанию включено)


class AdminBackupRequest(BaseModel):
    """Пароль, которым закрывается файл копии (его знает только владелец сервера)."""
    password: str = Field(min_length=8, max_length=256)


class CallCreateRequest(BaseModel):
    chat_id: str
    kind: Literal["audio", "video", "group"] = "audio"


class CallUpdateRequest(BaseModel):
    state: Literal["active", "ended", "declined", "missed"]


class FriendRequestCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    message: str = Field(default="", max_length=200)


class ContactUpdateRequest(BaseModel):
    alias: str = Field(default="", max_length=64)
    blocked: bool = False
    verified: bool = False
