"""Живой лендинг: посетители видят курсоры, следы и разрезы букв друг друга.

Один процесс uvicorn — поэтому рассылка из памяти, без Redis. Сервер ничего не рисует:
он проверяет события, ставит на них автора и раздаёт остальным. Текста нет by design —
только координаты, так что модерировать нечего.

Протокол (JSON, короткие ключи; x — доля ширины окна 0..1, y — px от верха страницы):
  клиент → сервер   {"t":"c","x","y"}                          курсор
                    {"t":"s","s":id,"k":"p"|"k","p":[[x,y],…]}  кусок следа (p — рисунок, k — нож)
                    {"t":"x","i":буква,"a":[x,y],"b":[x,y]}    разрез; a, b — в долях плитки буквы
  сервер → клиент   те же события с "u" (автор), плюс
                    {"t":"hello","you":{…},"peers":[…],"cuts":[…]}, {"t":"join",…}, {"t":"leave","u"}
"""

import asyncio
import json
import logging
import math
import random
import time
from collections import deque
from dataclasses import dataclass, field

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger("codevibehub.live")
router = APIRouter()

MAX_PEERS = 300
MAX_PEERS_PER_IP = 8  # вкладки одного человека; не даём одному IP занять все места
MAX_MESSAGE = 4096  # байт
MAX_POINTS = 64  # точек в одном куске следа
RATE = 60  # событий в секунду на соединение (с запасом на всплеск ×2)
CUT_TTL = 45  # сек; столько же буква живёт разрезанной на клиенте (paint.js)
LETTERS = 8  # плиток в заголовке CODE VIBE
QUEUE = 256  # исходящих сообщений на медленного клиента, дальше — отбрасываем

ADJ = ["neon", "acid", "turbo", "pixel", "cyber", "lazy", "cosmic", "glitch", "retro", "sonic"]
ANIMALS = ["fox", "cat", "owl", "lynx", "orca", "yak", "koala", "otter", "raven", "panda"]
COLORS = ["#67E8F9", "#C084FC", "#D4FF3A", "#3AFFB4", "#FF8A4C", "#FF3DA5", "#FACC15", "#60A5FA"]


@dataclass(eq=False)
class Peer:
    ws: WebSocket
    ip: str
    id: str
    name: str
    color: str
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(QUEUE))
    tokens: float = RATE * 2
    stamp: float = field(default_factory=time.monotonic)

    def public(self) -> dict:
        return {"u": self.id, "name": self.name, "color": self.color}

    def allow(self) -> bool:
        now = time.monotonic()
        self.tokens = min(RATE * 2, self.tokens + (now - self.stamp) * RATE)
        self.stamp = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True

    def send(self, msg: str) -> None:
        try:
            self.queue.put_nowait(msg)
        except asyncio.QueueFull:
            pass  # клиент не успевает — пропускаем, это эфемерные события


peers: dict[str, Peer] = {}
cuts: deque[tuple[float, dict]] = deque(maxlen=200)


def broadcast(msg: dict, skip: Peer | None = None) -> None:
    text = json.dumps(msg, separators=(",", ":"))
    for p in peers.values():
        if p is not skip:
            p.send(text)


def _num(v, lo: float, hi: float) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(v) or not lo <= v <= hi:
        return None
    return round(float(v), 4)


def _point(v, ylo: float, yhi: float) -> list[float] | None:
    if not isinstance(v, list) or len(v) != 2:
        return None
    x, y = _num(v[0], -0.5, 1.5), _num(v[1], ylo, yhi)
    return None if x is None or y is None else [x, y]


def clean(msg) -> dict | None:
    """Пропускает только известные события с координатами в допустимых пределах."""
    if not isinstance(msg, dict):
        return None
    t = msg.get("t")
    if t == "c":
        p = _point([msg.get("x"), msg.get("y")], 0, 50000)
        return p and {"t": "c", "x": p[0], "y": p[1]}
    if t == "s":
        sid, kind, pts = msg.get("s"), msg.get("k"), msg.get("p")
        if not isinstance(sid, int) or isinstance(sid, bool) or kind not in ("p", "k"):
            return None
        if not isinstance(pts, list) or not 0 < len(pts) <= MAX_POINTS:
            return None
        clean_pts = [_point(p, 0, 50000) for p in pts]
        if None in clean_pts:
            return None
        return {"t": "s", "s": sid % 1_000_000, "k": kind, "p": clean_pts}
    if t == "x":
        i, a, b = msg.get("i"), _point(msg.get("a"), -0.5, 1.5), _point(msg.get("b"), -0.5, 1.5)
        if not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < LETTERS or not a or not b:
            return None
        return {"t": "x", "i": i, "a": a, "b": b}
    return None


async def _pump(peer: Peer) -> None:
    while True:
        await peer.ws.send_text(await peer.queue.get())


@router.websocket("/ws/live")
async def live(ws: WebSocket):
    await ws.accept()
    ip = ws.client.host if ws.client else ""
    if len(peers) >= MAX_PEERS or sum(p.ip == ip for p in peers.values()) >= MAX_PEERS_PER_IP:
        await ws.close(code=1013)  # try again later
        return

    pid = f"{random.getrandbits(32):08x}"
    peer = Peer(ws, ip, pid, f"{random.choice(ADJ)}-{random.choice(ANIMALS)}", random.choice(COLORS))
    now = time.monotonic()
    while cuts and now - cuts[0][0] > CUT_TTL:
        cuts.popleft()
    await ws.send_text(json.dumps({
        "t": "hello",
        "you": peer.public(),
        "peers": [p.public() for p in peers.values()],
        "cuts": [c for _, c in cuts],
    }))
    peers[pid] = peer
    broadcast({"t": "join", **peer.public()}, skip=peer)
    pump = asyncio.create_task(_pump(peer))
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_MESSAGE or not peer.allow():
                continue
            try:
                msg = clean(json.loads(raw))
            except ValueError:
                continue
            if not msg:
                continue
            if msg["t"] == "x":
                cuts.append((time.monotonic(), msg))
            broadcast({**msg, "u": pid}, skip=peer)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("live socket failed")
    finally:
        pump.cancel()
        peers.pop(pid, None)
        broadcast({"t": "leave", "u": pid})
