"""End-to-end test of :func:`shared.notify.notify` + :class:`Listener` against
a real Postgres. Verifies that a NOTIFY round-trips through the DB to a
parallel-connection LISTEN session.
"""

from __future__ import annotations

import threading
import time

from shared.notify import Listener, notify


def test_notify_roundtrip() -> None:
    received: list[tuple[str, str]] = []
    ready = threading.Event()
    stop = threading.Event()

    def listener_thread() -> None:
        with Listener(["pt_prices"]) as listener:
            ready.set()
            for notif in listener.listen(timeout=2.0):
                received.append((notif.channel, notif.payload))
                if stop.is_set() or len(received) >= 1:
                    return

    t = threading.Thread(target=listener_thread, daemon=True)
    t.start()

    # Wait for LISTEN to register.
    assert ready.wait(timeout=2.0)
    time.sleep(0.1)

    notify("pt_prices", '["0xtest"]')

    t.join(timeout=3.0)
    stop.set()

    assert received, "no notification arrived"
    assert received[0][0] == "pt_prices"
    assert received[0][1] == '["0xtest"]'
