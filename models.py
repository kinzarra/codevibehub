"""Таблицы мероприятий. Создаются автоматически в db.init_db() (create_all), миграций пока нет."""
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from db import Base


class User(Base):
    """Посетитель, вошедший через Google. Права создавать мероприятия определяются отдельно (auth.can_create)."""
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True)  # в нижнем регистре
    name: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_login_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Event(Base):
    __tablename__ = "events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(String(80), unique=True)  # идентификатор в URL: /events/<slug>
    hashtag: Mapped[str] = mapped_column(String(40), default="вебинар")  # без «#», на странице показывается как #вебинар
    title: Mapped[str] = mapped_column(String(200))
    subtitle: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)  # для <meta description> и разметки Event
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Nicosia")  # IANA, для подписей времени
    tz_label: Mapped[str] = mapped_column(String(40), default="")  # то, что видит посетитель: «Кипр / МСК»
    format: Mapped[str] = mapped_column(String(80), default="Онлайн · Google Meet")
    meet_url: Mapped[str] = mapped_column(Text)
    links: Mapped[list] = mapped_column(JSONB, default=list)      # [{label, url}] — каналы, чаты и т. д.
    stats: Mapped[list] = mapped_column(JSONB, default=list)      # [{value, label}]
    agenda: Mapped[list] = mapped_column(JSONB, default=list)     # [{id, title, text}]; к id привязаны лайки
    audience: Mapped[list] = mapped_column(JSONB, default=list)   # [{id, text}]; id стабилен — к нему привязаны отметки «это я»
    # [{id, name, role, bio, photo_key, links: [{label, url}]}]; photo_key — объект в S3 (бакет S3_AVATAR_BUCKET)
    speakers: Mapped[list] = mapped_column(JSONB, default=list)
    owner_email: Mapped[str | None] = mapped_column(String(255))  # кто создал; пусто у мероприятий из посева
    # Соавторы: [{email (нормализованный), added_by, added_at}]. Видят «Отметки посетителей», править не могут.
    coauthors: Mapped[list] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class EventRsvp(Base):
    """Кнопка «Я пойду». Один посетитель (cookie cv_vid) — одна отметка на мероприятие."""
    __tablename__ = "event_rsvps"
    __table_args__ = (UniqueConstraint("event_id", "visitor_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    visitor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EventCalendarClick(Base):
    """Каждое нажатие «Добавить в календарь» (kind = google | ics). Повторные нажатия считаются."""
    __tablename__ = "event_calendar_clicks"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10))
    visitor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EventAudiencePick(Base):
    """Пользователь отметил пункт «Для кого»: «это я»."""
    __tablename__ = "event_audience_picks"
    __table_args__ = (UniqueConstraint("event_id", "user_id", "item_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    item_id: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EventAgendaLike(Base):
    """Пользователь поставил лайк пункту программы («Что разберём»)."""
    __tablename__ = "event_agenda_likes"
    __table_args__ = (UniqueConstraint("event_id", "user_id", "item_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    item_id: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
