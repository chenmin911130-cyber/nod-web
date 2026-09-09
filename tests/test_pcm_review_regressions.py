"""Real sender/Session regressions for the final #165 review."""
import threading
import time
from unittest import mock

import pytest

from server.app import CloudListener, PCM_ACCEPTED, STT_PCM_BUF_MAX
from tests.test_pcm_drain import _session
from tests.test_stt_terminate import _connected_ws


def listener():
    return CloudListener('k', {'stt': {}}, lambda *a: None, None, None)


def start_sender(lst, ws):
    lst._ws = ws
    lst._was_ready = True
    t = threading.Thread(target=lst._sender, daemon=True)
    lst._sender_thread = t
    t.start()
    return t


@pytest.mark.parametrize('payload', [b't' * 640, b'a' * 3200 + b't' * 640], ids=['short', 'full-plus-short'])
def test_end_sends_short_tail_without_another_input(payload):
    sess = _session(user_id='')
    sess.usage_session_id = 'session'
    sess._listen_wanted = True
    lst = listener()
    sess._listener = lst
    lst.on_sent = lambda n: setattr(sess, '_stt_tx_bytes', getattr(sess, '_stt_tx_bytes', 0) + n)
    events = []
    sess.emit = events.append
    sess.push_pcm(payload)
    ws = _connected_ws()
    done = threading.Event()
    with mock.patch('server.app.pace_wait_s', return_value=0):
        sender = start_sender(lst, ws)
        end = threading.Thread(target=lambda: (sess.pcm_end('session', len(payload), 'capture'), done.set()), daemon=True)
        end.start()
        try:
            assert done.wait(1), 'healthy End must drain a short tail without another PCM frame'
            assert events[-1] == {'type': 'pcm_drained', 'id': 'session', 'capture_id': 'capture', 'byte_offset': len(payload)}
            sent = b''.join(c.args[0] for c in ws.send.call_args_list if isinstance(c.args[0], bytes))
            assert sent == payload + b'\0' * 960
            assert sess._stt_tx_bytes == len(payload)
        finally:
            lst._stop.set()
            end.join(1)
            sender.join(1)


def test_failure_after_success_keeps_only_unsent_suffix_and_short_tail():
    a, b, c = b'a' * 3200, b'b' * 3200, b'c' * 640
    old = listener()
    old.seed_unsent(a + b + c)
    ws = _connected_ws()
    sent = []
    def send(frame, *args):
        if frame == b:
            raise RuntimeError('transport failed')
        sent.append(frame)
    ws.send.side_effect = send
    with mock.patch('server.app.pace_wait_s', return_value=0):
        t = start_sender(old, ws)
        assert not old.drain(timeout=1)
        handoff = old.take_unsent()
        t.join(1)
        assert handoff.pcm == b + c
        new = listener()
        new.seed_unsent(handoff.pcm)
        ws2 = _connected_ws()
        t2 = start_sender(new, ws2)
        try:
            assert new.drain(timeout=1)
            sent += [call.args[0] for call in ws2.send.call_args_list if isinstance(call.args[0], bytes)]
            assert b''.join(sent) == a + b + c + b'\0' * 960
        finally:
            new._stop.set()
            t2.join(1)


def test_hold_refusal_does_not_let_new_small_frame_overtake():
    sess = _session(user_id='')
    sess._listen_wanted = True
    lst = listener()
    sess._listener = lst
    a, b, c = b'a' * 4800, b'b' * 3200, b'c' * 640
    lst.seed_unsent(a)
    sess._pcm_hold = bytearray(b)
    sess._pcm_rx_bytes = len(a) + len(b)
    with mock.patch('server.app.STT_PCM_BUF_MAX', 6400):
        sess.push_pcm(c)
    # Harvest the actual owners in send order, not an independently modelled queue.
    retained = lst.take_unsent().pcm + bytes(sess._pcm_hold)
    assert retained == a + b + c


def test_rejected_end_survives_park_and_reattach():
    sess = _session(user_id='')
    sess.usage_session_id = 'old-session'
    sess._listen_ended = True
    sess._detach_control_emit()
    native = []
    sess._send_audio_text = native.append
    sess.pcm_end('old-session', 640, 'old-capture')
    rejected = native[-1]
    events = []
    sess.emit = events.append
    native.clear()
    sess.reattach()
    assert rejected in events
    assert rejected in native
